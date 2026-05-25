import axios, { AxiosInstance } from "axios";
import { CrmAdapter, Contact, Deal, DealStage, StageInfo } from "./types";

// Fallback al pipeline default de HubSpot. Cada tenant puede sobrescribir
// con su propio mapeo via `tenant.stage_map`.
export const DEFAULT_HUBSPOT_STAGE_MAP: Record<DealStage, string> = {
  saludo: "appointmentscheduled",
  "presentación": "qualifiedtobuy",
  propuesta: "contractsent",
  "negociación": "decisionmakerboughtin",
  cierre: "closedwon",
  perdido: "closedlost",
};

// Cache in-memory de pipelines por token. TTL corto porque corre en serverless
// (cada instancia warm reaprovecha; cold start refetchea). Evita pegarle a
// HubSpot en cada mensaje de WhatsApp solo para resolver labels.
const PIPELINE_CACHE_TTL_MS = 10 * 60 * 1000;
type StageMeta = { label: string; displayOrder: number };
const stageMetaCache = new Map<string, { data: Map<string, StageMeta>; expiresAt: number }>();

export class HubSpotAdapter implements CrmAdapter {
  private client: AxiosInstance;
  private stageMap: Record<string, string>;
  private token: string;

  constructor(token: string, stageMap?: Record<string, string> | null) {
    this.token = token;
    this.client = axios.create({
      baseURL: "https://api.hubapi.com",
      headers: { Authorization: `Bearer ${token}` },
    });
    // El mapeo del tenant tiene prioridad; lo que falte cae al default.
    this.stageMap = { ...DEFAULT_HUBSPOT_STAGE_MAP, ...(stageMap || {}) };
  }

  private resolveStage(stage: DealStage): string {
    return this.stageMap[stage] || stage;
  }

  private async getStageMeta(): Promise<Map<string, StageMeta>> {
    const cached = stageMetaCache.get(this.token);
    if (cached && cached.expiresAt > Date.now()) return cached.data;

    const res = await this.client.get("/crm/v3/pipelines/deals");
    const meta = new Map<string, StageMeta>();
    for (const p of res.data.results || []) {
      for (const s of p.stages || []) {
        // Si el mismo stageId aparece en varios pipelines (raro), gana el primero.
        if (!meta.has(s.id)) {
          meta.set(s.id, { label: s.label, displayOrder: s.displayOrder ?? 0 });
        }
      }
    }
    stageMetaCache.set(this.token, { data: meta, expiresAt: Date.now() + PIPELINE_CACHE_TTL_MS });
    return meta;
  }

  async listStages(): Promise<StageInfo[]> {
    const entries = Object.entries(this.stageMap) as Array<[DealStage, string]>;
    try {
      const meta = await this.getStageMeta();
      return entries
        .map(([slug, stageId]) => {
          const m = meta.get(stageId);
          return {
            slug,
            label: m?.label || slug,
            displayOrder: m?.displayOrder,
          };
        })
        .sort((a, b) => (a.displayOrder ?? 999) - (b.displayOrder ?? 999));
    } catch {
      // Si HubSpot no responde, devolvemos los slugs como label — el agente
      // sigue funcionando, simplemente sin los labels reales del pipeline.
      return entries.map(([slug]) => ({ slug, label: slug }));
    }
  }

  async searchContact(query: string): Promise<Contact[]> {
    // Top-level `query` searches firstname/lastname/email/company together; a single-property filterGroup missed name matches.
    const res = await this.client.post("/crm/v3/objects/contacts/search", {
      query,
      properties: ["firstname", "lastname", "email", "company", "phone"],
      limit: 5,
    });

    return (res.data.results || []).map((c: any) => ({
      id: c.id,
      name: `${c.properties.firstname || ""} ${c.properties.lastname || ""}`.trim() || "(sin nombre)",
      company: c.properties.company,
      email: c.properties.email,
      phone: c.properties.phone,
    }));
  }

  async createContact(input: { name: string; company?: string; email?: string; phone?: string }): Promise<Contact> {
    const [firstname, ...rest] = input.name.split(" ");
    const lastname = rest.join(" ");

    const res = await this.client.post("/crm/v3/objects/contacts", {
      properties: {
        firstname,
        lastname,
        company: input.company,
        email: input.email,
        phone: input.phone,
      },
    });

    return {
      id: res.data.id,
      name: input.name,
      company: input.company,
      email: input.email,
      phone: input.phone,
    };
  }

  async searchDeal(query: string): Promise<Deal[]> {
    // Top-level `query` searches dealname plus associated company/contact properties; a single-property filterGroup missed those.
    const res = await this.client.post("/crm/v3/objects/deals/search", {
      query,
      properties: ["dealname", "dealstage", "amount"],
      limit: 5,
    });

    return (res.data.results || []).map((d: any) => ({
      id: d.id,
      name: d.properties.dealname,
      stage: d.properties.dealstage,
      amount: d.properties.amount ? parseFloat(d.properties.amount) : undefined,
    }));
  }

  async createDeal(input: { contactId: string; name: string; amount?: number; stage?: DealStage }): Promise<Deal> {
    const stageId = this.resolveStage(input.stage || "saludo");
    const properties: Record<string, any> = {
      dealname: input.name,
      dealstage: stageId,
    };
    if (input.amount !== undefined) properties.amount = String(input.amount);

    const res = await this.client.post("/crm/v3/objects/deals", {
      properties,
      associations: [
        {
          to: { id: input.contactId },
          // 3 = deal-to-contact (HUBSPOT_DEFINED)
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }],
        },
      ],
    });

    return {
      id: res.data.id,
      name: input.name,
      stage: input.stage || "saludo",
      amount: input.amount,
      contactId: input.contactId,
    };
  }

  async moveDeal(dealId: string, stage: DealStage): Promise<string> {
    const stageId = this.resolveStage(stage);
    await this.client.patch(`/crm/v3/objects/deals/${dealId}`, {
      properties: { dealstage: stageId },
    });
    return `Deal movido a "${stage}"`;
  }

  async createNote(contactId: string, body: string): Promise<string> {
    try {
      await this.client.post("/crm/v3/objects/notes", {
        properties: {
          hs_note_body: body,
          hs_timestamp: Date.now(),
        },
        associations: [
          {
            to: { id: contactId },
            types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }],
          },
        ],
      });
      return "Nota registrada en HubSpot";
    } catch (err: any) {
      // Some HubSpot plans don't expose `crm.objects.notes.write`. The note
      // body is already persisted in `activity_log` by the agent loop, so we
      // return a graceful success to keep the conversation moving.
      if (err?.response?.status === 403) {
        return "Nota registrada (HubSpot no expone el scope de notas en este plan; queda en el log de actividad)";
      }
      throw err;
    }
  }

  async createTask(contactId: string, title: string, dueDate: string): Promise<string> {
    // YYYY-MM-DD without a time parses as midnight UTC, which is the prior day in Bogotá; anchor to 5pm Bogotá so the task displays on the intended local date.
    const dueTs = /^\d{4}-\d{2}-\d{2}$/.test(dueDate)
      ? new Date(`${dueDate}T17:00:00-05:00`).getTime()
      : new Date(dueDate).getTime();
    try {
      await this.client.post("/crm/v3/objects/tasks", {
        properties: {
          hs_task_subject: title,
          hs_task_status: "NOT_STARTED",
          hs_timestamp: dueTs,
        },
        associations: [
          {
            to: { id: contactId },
            types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 204 }],
          },
        ],
      });
      return `Tarea "${title}" creada en HubSpot`;
    } catch (err: any) {
      if (err?.response?.status === 403) {
        return `Tarea "${title}" registrada (HubSpot no expone el scope de tareas en este plan; queda en el log de actividad)`;
      }
      throw err;
    }
  }
}
