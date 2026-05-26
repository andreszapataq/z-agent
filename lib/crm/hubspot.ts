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
  private ownerId: string | null;

  constructor(token: string, stageMap?: Record<string, string> | null, ownerId?: string | null) {
    this.token = token;
    this.client = axios.create({
      baseURL: "https://api.hubapi.com",
      headers: { Authorization: `Bearer ${token}` },
    });
    // El mapeo del tenant tiene prioridad; lo que falte cae al default.
    this.stageMap = { ...DEFAULT_HUBSPOT_STAGE_MAP, ...(stageMap || {}) };
    this.ownerId = ownerId || null;
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

  // Devuelve los contactos y la empresa asociados a un deal en HubSpot. Lo
  // usamos en searchDeal para darle al agente el contexto completo del deal
  // y en createTask para enlazar la tarea a todos los registros relevantes.
  private async getDealAssociations(
    dealId: string
  ): Promise<{ contactIds: string[]; companyId?: string }> {
    try {
      const [contactsRes, companiesRes] = await Promise.all([
        this.client.get(`/crm/v3/objects/deals/${dealId}/associations/contacts`).catch(() => null),
        this.client.get(`/crm/v3/objects/deals/${dealId}/associations/companies`).catch(() => null),
      ]);
      const contactIds: string[] = (contactsRes?.data?.results || []).map((r: any) => r.id);
      const companyId: string | undefined = companiesRes?.data?.results?.[0]?.id;
      return { contactIds, companyId };
    } catch {
      return { contactIds: [] };
    }
  }

  async searchDeal(query: string): Promise<Deal[]> {
    // HubSpot's deals search `query` parameter sólo busca contra propiedades
    // del deal (dealname, description, etc.) — no incluye nombres de contacto
    // ni de empresa asociados. Por eso intentamos primero el match directo,
    // y si vacía, caemos a buscar contactos por el query y traemos sus deals.
    const direct = await this.client.post("/crm/v3/objects/deals/search", {
      query,
      properties: ["dealname", "dealstage", "amount"],
      limit: 5,
    });

    const directRaw = (direct.data.results || []) as any[];
    if (directRaw.length > 0) {
      const enriched = await Promise.all(
        directRaw.map(async (d) => {
          const assoc = await this.getDealAssociations(d.id);
          return {
            id: d.id,
            name: d.properties.dealname,
            stage: d.properties.dealstage,
            amount: d.properties.amount ? parseFloat(d.properties.amount) : undefined,
            contactIds: assoc.contactIds,
            contactId: assoc.contactIds[0],
            companyId: assoc.companyId,
          };
        })
      );
      return enriched;
    }

    // Fallback: buscar contactos cuyo nombre/empresa/email matcheen el query
    // y traer los deals asociados a ellos.
    const contactsRes = await this.client.post("/crm/v3/objects/contacts/search", {
      query,
      properties: ["firstname", "lastname", "company"],
      limit: 5,
    });
    const contactIds: string[] = (contactsRes.data.results || []).map((c: any) => c.id);
    if (contactIds.length === 0) return [];

    // Mapeo deal_id → primer contact_id que lo trajo, para devolverlo al agente
    // (le permite anclar notas tanto al deal como al contacto sin tener que
    // hacer una búsqueda adicional).
    const dealToContact = new Map<string, string>();
    await Promise.all(
      contactIds.map(async (cid) => {
        try {
          const r = await this.client.get(
            `/crm/v3/objects/contacts/${cid}/associations/deals`
          );
          for (const a of r.data?.results || []) {
            if (!dealToContact.has(a.id)) dealToContact.set(a.id, cid);
          }
        } catch {
          // ignoramos errores por contacto — seguimos con los demás
        }
      })
    );

    if (dealToContact.size === 0) return [];

    const batch = await this.client.post("/crm/v3/objects/deals/batch/read", {
      properties: ["dealname", "dealstage", "amount"],
      inputs: Array.from(dealToContact.keys()).slice(0, 10).map((id) => ({ id })),
    });

    const dealsRaw = (batch.data?.results || []) as any[];
    return Promise.all(
      dealsRaw.map(async (d) => {
        const assoc = await this.getDealAssociations(d.id);
        return {
          id: d.id,
          name: d.properties?.dealname,
          stage: d.properties?.dealstage,
          amount: d.properties?.amount ? parseFloat(d.properties.amount) : undefined,
          contactIds: assoc.contactIds.length ? assoc.contactIds : [dealToContact.get(d.id)!],
          contactId: dealToContact.get(d.id),
          companyId: assoc.companyId,
        };
      })
    );
  }

  async createDeal(input: { contactId: string; name: string; amount?: number; stage?: DealStage }): Promise<Deal> {
    const stageId = this.resolveStage(input.stage || "saludo");
    const properties: Record<string, any> = {
      dealname: input.name,
      dealstage: stageId,
    };
    if (input.amount !== undefined) properties.amount = String(input.amount);

    // Asociar la empresa primaria del contacto al deal, para que cualquier
    // actividad futura (tareas, notas) pueda propagarse a la timeline de la
    // empresa sin tener que adivinar la asociación.
    let companyId: string | null = null;
    try {
      const companyAssoc = await this.client.get(
        `/crm/v3/objects/contacts/${input.contactId}/associations/companies`
      );
      companyId = companyAssoc.data?.results?.[0]?.id || null;
    } catch {
      // si falla, seguimos sin company association
    }

    const associations: Array<{ to: { id: string }; types: any[] }> = [
      {
        to: { id: input.contactId },
        // 3 = deal-to-contact (HUBSPOT_DEFINED)
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }],
      },
    ];
    if (companyId) {
      associations.push({
        to: { id: companyId },
        // 5 = deal-to-company (HUBSPOT_DEFINED)
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 5 }],
      });
    }

    const res = await this.client.post("/crm/v3/objects/deals", {
      properties,
      associations,
    });

    return {
      id: res.data.id,
      name: input.name,
      stage: input.stage || "saludo",
      amount: input.amount,
      contactId: input.contactId,
      companyId: companyId || undefined,
    };
  }

  async moveDeal(dealId: string, stage: DealStage): Promise<string> {
    const stageId = this.resolveStage(stage);
    await this.client.patch(`/crm/v3/objects/deals/${dealId}`, {
      properties: { dealstage: stageId },
    });
    return `Deal movido a "${stage}"`;
  }

  async createNote(input: { contactId?: string; dealId?: string; body: string }): Promise<string> {
    if (!input.contactId && !input.dealId) {
      throw new Error("createNote requiere al menos contactId o dealId");
    }
    // HubSpot associationTypeIds (HUBSPOT_DEFINED): note↔contact = 202, note↔deal = 214.
    const associations: any[] = [];
    if (input.contactId) {
      associations.push({
        to: { id: input.contactId },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }],
      });
    }
    if (input.dealId) {
      associations.push({
        to: { id: input.dealId },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 214 }],
      });
    }
    try {
      await this.client.post("/crm/v3/objects/notes", {
        properties: {
          hs_note_body: input.body,
          hs_timestamp: Date.now(),
        },
        associations,
      });
      if (input.dealId && input.contactId) return "Nota registrada en el deal y en el contacto";
      if (input.dealId) return "Nota registrada en el deal";
      return "Nota registrada en el contacto";
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

  async createTask(input: {
    contactId?: string;
    dealId?: string;
    title: string;
    dueDate: string;
    dueTime?: string;
  }): Promise<string> {
    const { contactId, dealId, title, dueDate, dueTime } = input;
    // YYYY-MM-DD without a time parses as midnight UTC, which is the prior day in Bogotá; anchor a la hora indicada (default 9am Bogotá).
    const time = dueTime && /^\d{2}:\d{2}$/.test(dueTime) ? dueTime : "09:00";
    const dueTs = /^\d{4}-\d{2}-\d{2}$/.test(dueDate)
      ? new Date(`${dueDate}T${time}:00-05:00`).getTime()
      : new Date(dueDate).getTime();

    // Si la tarea viene asociada a un deal, traemos sus contactos + empresa y
    // también el owner del deal para que la tarea quede a nombre del comercial
    // que maneja la oportunidad (no del owner default del tenant).
    let dealContactIds: string[] = [];
    let dealCompanyId: string | undefined;
    let dealOwnerId: string | undefined;
    if (dealId) {
      const assoc = await this.getDealAssociations(dealId);
      dealContactIds = assoc.contactIds;
      dealCompanyId = assoc.companyId;
      try {
        const dealRes = await this.client.get(`/crm/v3/objects/deals/${dealId}`, {
          params: { properties: "hubspot_owner_id" },
        });
        dealOwnerId = dealRes.data?.properties?.hubspot_owner_id || undefined;
      } catch {
        // si falla, caemos al owner default
      }
    }

    // Construimos la lista de asociaciones: deal + empresa + todos los
    // contactos relevantes (los del deal y/o el contact_id explícito).
    const contactIdSet = new Set<string>();
    if (contactId) contactIdSet.add(contactId);
    for (const cid of dealContactIds) contactIdSet.add(cid);

    const associations: Array<{ to: { id: string }; types: any[] }> = [];
    for (const cid of contactIdSet) {
      associations.push({
        to: { id: cid },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 204 }],
      });
    }
    if (dealId) {
      associations.push({
        to: { id: dealId },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 216 }],
      });
    }
    if (dealCompanyId) {
      associations.push({
        to: { id: dealCompanyId },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 192 }],
      });
    }

    const ownerId = dealOwnerId || this.ownerId;

    try {
      await this.client.post("/crm/v3/objects/tasks", {
        properties: {
          hs_task_subject: title,
          hs_task_status: "NOT_STARTED",
          hs_timestamp: dueTs,
          hs_task_reminders: String(dueTs),
          // HubSpot solo dispara la notificación del recordatorio si la tarea tiene owner.
          ...(ownerId ? { hubspot_owner_id: ownerId } : {}),
        },
        associations,
      });
      const targets: string[] = [];
      if (dealId) targets.push("deal");
      if (contactIdSet.size > 0) targets.push(contactIdSet.size > 1 ? `${contactIdSet.size} contactos` : "contacto");
      if (dealCompanyId) targets.push("empresa");
      const where = targets.length ? ` (asociada al ${targets.join(", ")})` : "";
      return `Tarea "${title}" creada en HubSpot${where}`;
    } catch (err: any) {
      if (err?.response?.status === 403) {
        return `Tarea "${title}" registrada (HubSpot no expone el scope de tareas en este plan; queda en el log de actividad)`;
      }
      throw err;
    }
  }
}
