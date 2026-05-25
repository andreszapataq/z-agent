import { createAdminClient } from "./supabase";

export type Tenant = {
  id: string;
  name: string;
  crm_type: "hubspot" | "native" | "salesforce";
  status: "active" | "paused";
  whatsapp_phone_id: string | null;
  whatsapp_token: string | null;
  owner_number: string | null;
  hubspot_token: string | null;
  hubspot_owner_id: string | null;
  system_prompt: string | null;

  // Cuando un deal entra a la etapa de propuesta, el comercial recibe
  // un recordatorio (WhatsApp libre + tarea HubSpot).
  proposal_stage_id: string | null;
  last_polled_at: string | null;

  // Sync de correos con un template específico → mueve/crea deal a "propuesta"
  proposal_email_template_id: string | null;
  last_email_polled_at: string | null;

  // Mapeo etapa-en-español → stageId real del pipeline custom de cada tenant
  stage_map: Record<string, string> | null;

  created_at: string;
  updated_at: string;
};

export async function getAllTenants(): Promise<Tenant[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("tenants")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getTenant(id: string): Promise<Tenant | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("tenants")
    .select("*")
    .eq("id", id)
    .single();
  return data;
}

export async function getTenantByPhone(phoneNumberId: string): Promise<Tenant | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("tenants")
    .select("*")
    .eq("whatsapp_phone_id", phoneNumberId)
    .eq("status", "active")
    .single();
  return data;
}

export async function saveTenant(tenant: Partial<Tenant> & { id: string; name: string }): Promise<Tenant> {
  const supabase = createAdminClient();

  // Default prompt si no viene
  if (!tenant.system_prompt) {
    tenant.system_prompt = buildDefaultPrompt(tenant.name, tenant.crm_type || "native");
  }

  const { data, error } = await supabase
    .from("tenants")
    .upsert(tenant)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteTenant(id: string): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.from("tenants").delete().eq("id", id);
  if (error) throw error;
}

function buildDefaultPrompt(name: string, crmType: string): string {
  const crmDesc = crmType === "hubspot"
    ? "Las acciones (crear notas, mover deals, crear tareas) se ejecutan en el HubSpot del cliente."
    : "Las acciones se guardan en el CRM nativo de Z-Agent (Supabase).";

  return `Eres el asistente de ventas de ${name}.
Ayudas al equipo comercial a registrar actividades, mover negocios y consultar información de clientes.
${crmDesc}
Responde siempre en español, de forma concisa y confirma cada acción que realices.`;
}
