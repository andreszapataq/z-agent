import { createAdminClient } from "../supabase";
import { CrmAdapter, Company, CompanySearchResult, Contact, Deal, DealStage, StageInfo, TaskItem, TaskPriority } from "./types";
import { normalizePhone } from "./phone";
import { companyMatches, stripLegalSuffix } from "./match";

const NATIVE_STAGE_LABELS: Array<{ slug: DealStage; label: string }> = [
  { slug: "saludo", label: "Nuevo contacto" },
  { slug: "presentación", label: "Presentación enviada" },
  { slug: "propuesta", label: "Propuesta económica enviada" },
  { slug: "negociación", label: "Negociación" },
  { slug: "cierre", label: "Cliente ganado" },
  { slug: "perdido", label: "Perdido" },
];

export class NativeAdapter implements CrmAdapter {
  private tenantId: string;
  private supabase = createAdminClient();

  constructor(tenantId: string) {
    this.tenantId = tenantId;
  }

  async searchContact(query: string): Promise<Contact[]> {
    const { data } = await this.supabase
      .from("contacts")
      .select("*")
      .eq("tenant_id", this.tenantId)
      .or(`full_name.ilike.%${query}%,company.ilike.%${query}%`)
      .limit(5);

    return (data || []).map((c) => ({
      id: c.id,
      name: c.full_name,
      company: c.company,
      email: c.email,
      phone: c.phone,
      jobtitle: c.position,
    }));
  }

  // El CRM nativo no tiene un objeto Company; la empresa vive como campo de
  // texto en `contacts.company`. Verificamos contra los valores distintos de
  // esa columna — es la mejor señal disponible sin un objeto dedicado.
  async searchCompany(names: string[]): Promise<CompanySearchResult[]> {
    const capped = (names || []).map((n) => n.trim()).filter(Boolean).slice(0, 25);
    return Promise.all(
      capped.map(async (name): Promise<CompanySearchResult> => {
        // Buscamos sin el sufijo legal (el texto guardado puede no tenerlo).
        const cleaned = stripLegalSuffix(name) || name;
        const { data, error } = await this.supabase
          .from("contacts")
          .select("company")
          .eq("tenant_id", this.tenantId)
          .ilike("company", `%${cleaned}%`)
          .limit(5);
        if (error) return { query: name, status: "error", matches: [], error: error.message };

        const seen = new Set<string>();
        const candidates: Company[] = [];
        for (const row of data || []) {
          const c = (row as any).company as string | null;
          if (c && !seen.has(c)) {
            seen.add(c);
            candidates.push({ id: c, name: c });
          }
        }
        const matched = candidates.filter((c) => companyMatches(name, [c.name]));
        if (matched.length > 0) return { query: name, status: "exists", matches: matched };
        if (candidates.length > 0)
          return { query: name, status: "possible", matches: candidates.slice(0, 3) };
        return { query: name, status: "not_found", matches: [] };
      })
    );
  }

  async createContact(input: { name: string; company?: string; email?: string; phone?: string; jobtitle?: string }): Promise<Contact> {
    const phone = normalizePhone(input.phone);
    const { data, error } = await this.supabase
      .from("contacts")
      .insert({
        tenant_id: this.tenantId,
        full_name: input.name,
        company: input.company,
        email: input.email,
        phone,
        position: input.jobtitle,
        source: "whatsapp",
      })
      .select()
      .single();

    if (error) throw error;
    return {
      id: data.id,
      name: data.full_name,
      company: data.company,
      email: data.email,
      phone: data.phone,
      jobtitle: data.position,
    };
  }

  async searchDeal(query: string): Promise<Deal[]> {
    const { data } = await this.supabase
      .from("deals")
      .select("*")
      .eq("tenant_id", this.tenantId)
      .ilike("name", `%${query}%`)
      .limit(5);

    return (data || []).map((d) => ({
      id: d.id,
      name: d.name,
      stage: d.stage,
      amount: d.amount,
      contactId: d.contact_id,
    }));
  }

  async createDeal(input: { contactId: string; name: string; amount?: number; stage?: DealStage }): Promise<Deal> {
    const { data, error } = await this.supabase
      .from("deals")
      .insert({
        tenant_id: this.tenantId,
        contact_id: input.contactId,
        name: input.name,
        amount: input.amount,
        stage: input.stage || "saludo",
      })
      .select()
      .single();

    if (error) throw error;
    return {
      id: data.id,
      name: data.name,
      stage: data.stage,
      amount: data.amount,
      contactId: data.contact_id,
    };
  }

  async moveDeal(dealId: string, stage: DealStage): Promise<string> {
    const { error } = await this.supabase
      .from("deals")
      .update({ stage })
      .eq("id", dealId)
      .eq("tenant_id", this.tenantId);

    if (error) throw error;
    return `Deal movido a "${stage}"`;
  }

  async createNote(input: { contactId?: string; dealId?: string; body: string }): Promise<string> {
    if (!input.contactId && !input.dealId) {
      throw new Error("createNote requiere al menos contactId o dealId");
    }
    const { error } = await this.supabase.from("notes").insert({
      tenant_id: this.tenantId,
      contact_id: input.contactId || null,
      deal_id: input.dealId || null,
      body: input.body,
    });
    if (error) throw error;
    if (input.dealId && input.contactId) return "Nota registrada (deal + contacto)";
    if (input.dealId) return "Nota registrada en el deal";
    return "Nota registrada en el contacto";
  }

  async createTask(input: {
    contactId?: string;
    dealId?: string;
    title: string;
    dueDate: string;
    dueTime?: string;
    priority?: TaskPriority;
  }): Promise<string> {
    // La tabla `tasks` nativa no tiene columna de prioridad todavía; aceptamos
    // el parámetro para cumplir la interfaz y lo ignoramos.
    const { error } = await this.supabase.from("tasks").insert({
      tenant_id: this.tenantId,
      contact_id: input.contactId || null,
      title: input.title,
      due_date: input.dueDate,
      status: "pending",
    });
    if (error) throw error;
    return `Tarea "${input.title}" creada`;
  }

  async completeTask(taskId: string): Promise<string> {
    const { data, error } = await this.supabase
      .from("tasks")
      .update({ status: "completed", updated_at: new Date().toISOString() })
      .eq("id", taskId)
      .eq("tenant_id", this.tenantId)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) return "No encontré esa tarea";
    return "Tarea marcada como completada";
  }

  async listTasks(input: {
    fromDate: string;
    toDate: string;
    includeCompleted?: boolean;
  }): Promise<TaskItem[]> {
    let query = this.supabase
      .from("tasks")
      .select("id, title, due_date, status, contact_id, contacts(full_name, company)")
      .eq("tenant_id", this.tenantId)
      .gte("due_date", input.fromDate)
      .lte("due_date", input.toDate)
      .order("due_date", { ascending: true })
      .limit(50);

    if (!input.includeCompleted) {
      query = query.neq("status", "completed");
    }

    const { data, error } = await query;
    if (error) throw error;

    return (data || []).map((t: any) => ({
      id: t.id,
      title: t.title,
      dueDate: t.due_date,
      status: t.status,
      contactName: t.contacts?.full_name,
      companyName: t.contacts?.company,
    }));
  }

  async listStages(): Promise<StageInfo[]> {
    return NATIVE_STAGE_LABELS.map((s, i) => ({ ...s, displayOrder: i }));
  }
}
