import axios from "axios";
import { createAdminClient } from "./supabase";
import { sendWhatsAppMessage } from "./whatsapp";
import { Tenant } from "./tenants";
import { getCrmAdapter } from "./crm";

type PollResult = {
  scanned: number;
  notified: number;
  errors: string[];
};

// Punto de entrada del cron. Recorre tenants HubSpot activos y, para los
// deals que entraron a la etapa de "propuesta" desde la última corrida,
// crea una tarea en HubSpot + WhatsApp libre al comercial. No envía
// nada al cliente final (eso requeriría template pagado).
export async function pollProposalNotifications(): Promise<PollResult> {
  const result: PollResult = { scanned: 0, notified: 0, errors: [] };
  const supabase = createAdminClient();

  const { data: tenants, error } = await supabase
    .from("tenants")
    .select("*")
    .eq("crm_type", "hubspot")
    .eq("status", "active")
    .not("proposal_stage_id", "is", null)
    .not("hubspot_token", "is", null)
    .not("whatsapp_phone_id", "is", null)
    .not("whatsapp_token", "is", null)
    .not("owner_number", "is", null);

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
  const crm = getCrmAdapter(tenant);
  const stageId = tenant.proposal_stage_id!;
  const enteredProp = `hs_date_entered_${stageId}`;

  // Ventana: desde last_polled_at - 1 min (overlap defensivo) hasta ahora.
  // Primera corrida: últimos 10 min para no notificar deals viejos.
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

  let queued = 0;

  for (const deal of deals) {
    // Dedup: si ya encolamos el follow-up para este deal, saltar
    const { data: prior } = await supabase
      .from("activity_log")
      .select("id")
      .eq("tenant_id", tenant.id)
      .eq("action", "proposal_followup_queued")
      .filter("details->>deal_id", "eq", deal.id)
      .limit(1);

    if (prior && prior.length > 0) continue;

    const assoc = await client.get(
      `/crm/v3/objects/deals/${deal.id}/associations/contacts`
    );
    const contactId = assoc.data?.results?.[0]?.id;
    if (!contactId) {
      console.warn(`[poll] deal ${deal.id} sin contacto asociado, omitiendo`);
      await supabase.from("activity_log").insert({
        tenant_id: tenant.id,
        action: "proposal_skipped",
        details: { deal_id: deal.id, reason: "no_contact" },
      });
      continue;
    }

    const contactRes = await client.get(
      `/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,phone`
    );
    const props = contactRes.data?.properties || {};
    const firstName = (props.firstname || "").trim() || "el cliente";
    const lastName = (props.lastname || "").trim();
    const fullName = [firstName, lastName].filter(Boolean).join(" ");
    const dealName = deal.properties.dealname || "tu propuesta";
    const phoneRaw = (props.phone || "").trim();

    // Crear tarea en HubSpot (due hoy en Bogotá)
    const todayBogota = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/Bogota",
    });
    const taskTitle = `Seguimiento propuesta — ${dealName}`;

    let taskOk = false;
    try {
      await crm.createTask(contactId, taskTitle, todayBogota);
      taskOk = true;
    } catch (taskErr: any) {
      console.error(`[poll] createTask falló para deal ${deal.id}:`, taskErr?.message);
    }

    // WhatsApp libre al comercial (depende de service window abierta)
    const phoneLine = phoneRaw
      ? `📞 Teléfono del contacto: ${phoneRaw}`
      : `⚠️ El contacto no tiene teléfono registrado en HubSpot — revísalo allí.`;

    const body =
      `🔔 *Recordatorio: seguimiento de propuesta*\n\n` +
      `Entró a propuesta el deal *"${dealName}"* con ${fullName}.\n` +
      `${phoneLine}\n\n` +
      `Sugerencia para enviarle hoy desde tu WhatsApp personal:\n\n` +
      `──\n` +
      `Hola ${firstName}, te confirmo que ${tenant.name} te envió la propuesta para "${dealName}". ¿Pudiste revisarla? Quedamos atentos a cualquier inquietud.\n` +
      `──\n\n` +
      (taskOk
        ? `✅ Te dejé también una tarea en HubSpot para no perderle el rastro.`
        : `(No pude crear la tarea en HubSpot, revísalo manualmente.)`);

    let waOk = false;
    let waError: string | undefined;
    try {
      await sendWhatsAppMessage(
        tenant.whatsapp_phone_id!,
        tenant.whatsapp_token!,
        tenant.owner_number!,
        body
      );
      waOk = true;
    } catch (waErr: any) {
      waError = waErr?.response?.data
        ? JSON.stringify(waErr.response.data)
        : waErr?.message || String(waErr);
      console.warn(`[poll] WhatsApp al comercial falló (probable ventana cerrada): ${waError}`);
    }

    await supabase.from("activity_log").insert({
      tenant_id: tenant.id,
      action: "proposal_followup_queued",
      details: {
        deal_id: deal.id,
        deal_name: dealName,
        contact_id: contactId,
        contact_phone: phoneRaw || null,
        task_created: taskOk,
        whatsapp_sent: waOk,
        whatsapp_error: waError || null,
      },
    });
    queued++;
  }

  await supabase
    .from("tenants")
    .update({ last_polled_at: new Date(now).toISOString() })
    .eq("id", tenant.id);

  return queued;
}
