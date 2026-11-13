import { createAdminClient } from "../supabase";
import {
  CrmAdapter,
  Company,
  CompanyInput,
  CompanySearchResult,
  Contact,
  ContactInput,
  ContactUpdate,
  CreateCompanyResult,
  CreateContactResult,
  Deal,
  DealStage,
  StageInfo,
  TaskItem,
  TaskPriority,
} from "./types";
import {
  ValidationError,
  cleanCompanyName,
  cleanPersonName,
  normalizeEmail,
  routePhones,
} from "./contact-rules";

function rowToContact(c: any): Contact {
  return {
    id: c.id,
    name: c.full_name,
    company: c.company || undefined,
    email: c.email || undefined,
    phone: c.phone || undefined,
    jobtitle: c.position || undefined,
  };
}
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

  async createContact(input: ContactInput): Promise<CreateContactResult> {
    const firstname = cleanPersonName(input.firstname);
    if (!firstname) throw new ValidationError("Falta el nombre del contacto.");
    const fullName = [firstname, cleanPersonName(input.lastname)].filter(Boolean).join(" ");
    const email = normalizeEmail(input.email);
    const phones = routePhones({ mobile: input.mobile, phone: input.phone });
    // El CRM nativo tiene un solo campo de teléfono: preferimos el celular.
    const phone = phones.mobilephone || phones.phone;
    // Sin objeto Empresa: el "id" de empresa es su nombre (ver searchCompany).
    const company = input.company || input.companyId;

    if (!input.allowDuplicate && (email || phone)) {
      const ors = [email && `email.eq.${email}`, phone && `phone.eq.${phone}`].filter(Boolean).join(",");
      const { data: dups } = await this.supabase
        .from("contacts")
        .select("*")
        .eq("tenant_id", this.tenantId)
        .or(ors)
        .limit(5);
      if (dups && dups.length > 0) {
        return {
          status: "possible_duplicate",
          matches: dups.map(rowToContact),
          message:
            "NO se creó: ya existe un contacto con el mismo correo o teléfono. Pregunta al usuario si es la misma persona; solo si confirma que es otra, vuelve a llamar create_contact con allow_duplicate: true.",
        };
      }
    }

    const { data, error } = await this.supabase
      .from("contacts")
      .insert({
        tenant_id: this.tenantId,
        full_name: fullName,
        company,
        email,
        phone,
        position: input.jobtitle,
        source: "whatsapp",
      })
      .select()
      .single();

    if (error) throw error;
    return { status: "created", contact: rowToContact(data) };
  }

  async updateContact(contactId: string, input: ContactUpdate): Promise<Contact> {
    const patch: Record<string, string> = {};
    const firstname = cleanPersonName(input.firstname);
    const lastname = cleanPersonName(input.lastname);
    if (firstname || lastname) {
      const { data: cur } = await this.supabase.from("contacts").select("full_name").eq("id", contactId).single();
      const [curFirst, ...curRest] = String(cur?.full_name || "").split(" ");
      patch.full_name = [firstname || curFirst, lastname || curRest.join(" ")].filter(Boolean).join(" ");
    }
    const email = normalizeEmail(input.email);
    if (email) patch.email = email;
    const phones = routePhones({ mobile: input.mobile, phone: input.phone });
    const phone = phones.mobilephone || phones.phone;
    if (phone) patch.phone = phone;
    if (input.jobtitle) patch.position = input.jobtitle;
    const company = input.company || input.companyId;
    if (company) patch.company = company;
    if (Object.keys(patch).length === 0) throw new ValidationError("No hay datos para actualizar.");

    const { data, error } = await this.supabase
      .from("contacts")
      .update(patch)
      .eq("tenant_id", this.tenantId)
      .eq("id", contactId)
      .select()
      .single();
    if (error) throw error;
    return rowToContact(data);
  }

  // Sin objeto Empresa en el CRM nativo: la empresa existe en cuanto un
  // contacto la usa. Devolvemos el nombre limpio como id.
  async createCompany(input: CompanyInput): Promise<CreateCompanyResult> {
    const name = cleanCompanyName(input.name);
    return { status: "created", company: { id: name, name, city: input.city } };
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
    isAppointment?: boolean;
  }): Promise<string> {
    // La tabla `tasks` nativa no tiene columnas de prioridad ni de recordatorios
    // todavía; aceptamos `priority` e `isAppointment` para cumplir la interfaz y
    // los ignoramos (sin sistema de recordatorios nativo no hay nada que disparar).
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
