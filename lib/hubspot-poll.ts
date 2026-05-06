import axios from "axios";
import { createAdminClient } from "./supabase";
import { sendWhatsAppTemplate } from "./whatsapp";
import { Tenant } from "./tenants";

type PollResult = {
  scanned: number;
  notified: number;
  errors: string[];
};

// Punto de entrada del cron. Recorre tenants HubSpot activos con notificación
// configurada y envía WhatsApp template para deals que entraron a la etapa
// de "propuesta" desde la última corrida.
export async function pollProposalNotifications(): Promise<PollResult> {
  const result: PollResult = { scanned: 0, notified: 0, errors: [] };
  const supabase = createAdminClient();

  const { data: tenants, error } = await supabase
    .from("tenants")
    .select("*")
    .eq("crm_type", "hubspot")
    .eq("status", "active")
    .not("proposal_stage_id", "is", null)
    .not("proposal_template_name", "is", null)
    .not("hubspot_token", "is", null)
    .not("whatsapp_phone_id", "is", null)
    .not("whatsapp_token", "is", null);

  if (error) {
    result.errors.push(`supabase: ${error.message}`);
    return result;
  }
  if (!tenants) return result;

  result.scanned = tenants.length;

  for (const tenant of tenants as Tenant[]) {
    try {
      result.notified += await pollTenant(tenant);
    } catch (e: any) {
      const msg = e?.response?.data
        ? JSON.stringify(e.response.data)
        : e?.message || String(e);
      console.error(`[poll] tenant=${tenant.id} error:`, msg);
      result.errors.push(`${tenant.id}: ${msg}`);
    }
  }
  return result;
}

async function pollTenant(tenant: Tenant): Promise<number> {
  const supabase = createAdminClient();
  const stageId = tenant.proposal_stage_id!;
  const enteredProp = `hs_date_entered_${stageId}`;

  // Ventana: desde last_polled_at - 1 min (overlap defensivo) hasta ahora.
  // En la primera corrida, ventana de últimos 10 min para no notificar
  // deals viejos que ya estaban en la etapa.
  const now = Date.now();
  const since = tenant.last_polled_at
    ? new Date(tenant.last_polled_at).getTime() - 60_000
    : now - 10 * 60_000;

  const client = axios.create({
    baseURL: "https://api.hubapi.com",
    headers: { Authorization: `Bearer ${tenant.hubspot_token}` },
  });

  const search = await client.post("/crm/v3/objects/deals/search", {
    filterGroups: [
      {
        filters: [
          { propertyName: "dealstage", operator: "EQ", value: stageId },
          { propertyName: enteredProp, operator: "GTE", value: String(since) },
        ],
      },
    ],
    properties: ["dealname", "dealstage", enteredProp],
    limit: 50,
  });

  const deals = (search.data.results || []) as Array<{
    id: string;
    properties: Record<string, string>;
  }>;

  let notified = 0;

  for (const deal of deals) {
    // Dedup: si ya notificamos para este deal, saltar
    const { data: prior } = await supabase
      .from("activity_log")
      .select("id")
      .eq("tenant_id", tenant.id)
      .eq("action", "proposal_notified")
      .filter("details->>deal_id", "eq", deal.id)
      .limit(1);

    if (prior && prior.length > 0) continue;

    // Buscar contacto asociado al deal
    const assoc = await client.get(
      `/crm/v3/objects/deals/${deal.id}/associations/contacts`
    );
    const contactId = assoc.data?.results?.[0]?.id;
    if (!contactId) {
      console.warn(`[poll] deal ${deal.id} sin contacto asociado, omitiendo`);
      continue;
    }

    const contactRes = await client.get(
      `/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,phone`
    );
    const props = contactRes.data?.properties || {};
    const phoneRaw = props.phone || "";
    const phone = phoneRaw.replace(/[^0-9]/g, "");
    const firstName = (props.firstname || "").trim() || "cliente";

    if (!phone || phone.length < 8) {
      console.warn(`[poll] contacto ${contactId} sin teléfono válido`);
      await supabase.from("activity_log").insert({
        tenant_id: tenant.id,
        action: "proposal_skipped",
        details: { deal_id: deal.id, reason: "no_phone", contact_id: contactId },
      });
      continue;
    }

    await sendWhatsAppTemplate(
      tenant.whatsapp_phone_id!,
      tenant.whatsapp_token!,
      phone,
      tenant.proposal_template_name!,
      tenant.proposal_template_lang || "es",
      [firstName, deal.properties.dealname || "tu solicitud"]
    );

    await supabase.from("activity_log").insert({
      tenant_id: tenant.id,
      action: "proposal_notified",
      details: {
        deal_id: deal.id,
        deal_name: deal.properties.dealname,
        contact_id: contactId,
        phone,
        template: tenant.proposal_template_name,
      },
    });
    notified++;
  }

  await supabase
    .from("tenants")
    .update({ last_polled_at: new Date(now).toISOString() })
    .eq("id", tenant.id);

  return notified;
}
