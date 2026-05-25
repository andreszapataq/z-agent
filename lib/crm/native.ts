import { createAdminClient } from "../supabase";
import { CrmAdapter, Contact, Deal, DealStage, StageInfo } from "./types";

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
    }));
  }

  async createContact(input: { name: string; company?: string; email?: string; phone?: string }): Promise<Contact> {
    const { data, error } = await this.supabase
      .from("contacts")
      .insert({
        tenant_id: this.tenantId,
        full_name: input.name,
        company: input.company,
        email: input.email,
        phone: input.phone,
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

  async createTask(contactId: string, title: string, dueDate: string): Promise<string> {
    const { error } = await this.supabase.from("tasks").insert({
      tenant_id: this.tenantId,
      contact_id: contactId,
      title,
      due_date: dueDate,
      status: "pending",
    });
    if (error) throw error;
    return `Tarea "${title}" creada`;
  }

  async listStages(): Promise<StageInfo[]> {
    return NATIVE_STAGE_LABELS.map((s, i) => ({ ...s, displayOrder: i }));
  }
}
