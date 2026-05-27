import axios from "axios";
import { createAdminClient } from "./supabase";
import { Tenant } from "./tenants";
import { getCrmAdapter } from "./crm";

type PollResult = {
  scanned: number;
  notified: number;
  errors: string[];
};

type TouchedDeal = { id: string; name: string };

type EmailSyncResult = {
  scanned: number;
  synced: number;
  errors: string[];
  // deals creados/movidos a la etapa de propuesta en esta corrida, por tenant
  dealsByTenant: Record<string, TouchedDeal[]>;
};

// Recorre tenants HubSpot activos con un template de propuesta configurado.
// Para cada correo enviado con ese template, mueve el deal asociado al
// contacto a la etapa de "propuesta", o crea uno nuevo si no existe.
export async function pollProposalEmails(): Promise<EmailSyncResult> {
  const result: EmailSyncResult = { scanned: 0, synced: 0, errors: [], dealsByTenant: {} };
  const supabase = createAdminClient();

  const { data: tenants, error } = await supabase
    .from("tenants")
    .select("*")
    .eq("crm_type", "hubspot")
    .eq("status", "active")
    .not("proposal_stage_id", "is", null)
    .not("proposal_email_template_id", "is", null)
    .not("hubspot_token", "is", null);

  if (error) {
    result.errors.push(`supabase: ${error.message}`);
    return result;
  }
  if (!tenants) return result;

  result.scanned = tenants.length;

  for (const tenant of tenants as Tenant[]) {
    try {
      const { synced, deals } = await syncTenantEmails(tenant);
      result.synced += synced;
      if (deals.length > 0) result.dealsByTenant[tenant.id] = deals;
    } catch (e: any) {
      const method = e?.config?.method?.toUpperCase();
      const url = e?.config?.url;
      const status = e?.response?.status;
      const data = e?.response?.data
        ? JSON.stringify(e.response.data)
        : e?.message || String(e);
      const where = url ? ` [${method} ${url} → ${status}]` : "";
      console.error(`[email-sync] tenant=${tenant.id} error${where}:`, data);
      result.errors.push(`${tenant.id}${where}: ${data}`);
    }
  }
  return result;
}

async function syncTenantEmails(tenant: Tenant): Promise<{ synced: number; deals: TouchedDeal[] }> {
  const supabase = createAdminClient();
  const templateId = tenant.proposal_email_template_id!;
  const targetStage = tenant.proposal_stage_id!;
  const now = Date.now();
  const since = tenant.last_email_polled_at
    ? new Date(tenant.last_email_polled_at).getTime() - 60_000
    : now - 24 * 60 * 60_000; // primera corrida: últimas 24h (dedup por email_id evita reprocesar)

  const client = axios.create({
    baseURL: "https://api.hubapi.com",
    headers: { Authorization: `Bearer ${tenant.hubspot_token}` },
  });

  const search = await client.post("/crm/v3/objects/emails/search", {
    filterGroups: [
      {
        filters: [
          { propertyName: "hs_template_id", operator: "EQ", value: templateId },
          { propertyName: "hs_timestamp", operator: "GTE", value: since },
        ],
      },
    ],
    properties: ["hs_template_id", "hs_email_subject", "hs_timestamp", "hs_email_direction"],
    limit: 50,
  });

  const emails = (search.data.results || []) as Array<{
    id: string;
    properties: Record<string, string>;
  }>;

  let synced = 0;
  const touched: TouchedDeal[] = [];

  for (const email of emails) {
    // Dedup: si ya procesamos este email_id, saltar
    const { data: prior } = await supabase
      .from("activity_log")
      .select("id")
      .eq("tenant_id", tenant.id)
      .eq("action", "proposal_email_synced")
      .filter("details->>email_id", "eq", email.id)
      .limit(1);

    if (prior && prior.length > 0) continue;

    const assoc = await client.get(
      `/crm/v3/objects/emails/${email.id}/associations/contacts`
    );
    const contactId = assoc.data?.results?.[0]?.id;
    if (!contactId) {
      await supabase.from("activity_log").insert({
        tenant_id: tenant.id,
        action: "proposal_email_skipped",
        details: { email_id: email.id, reason: "no_contact" },
      });
      continue;
    }

    const contactRes = await client.get(
      `/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,company`
    );
    const cprops = contactRes.data?.properties || {};
    const contactName = [cprops.firstname, cprops.lastname].filter(Boolean).join(" ").trim()
      || cprops.company
      || "Contacto sin nombre";

    // Buscar deals abiertos asociados al contacto
    const dealAssoc = await client.get(
      `/crm/v3/objects/contacts/${contactId}/associations/deals`
    );
    const dealIds: string[] = (dealAssoc.data?.results || []).map((d: any) => d.id);

    let dealId: string | null = null;
    let dealAction: "moved" | "created" | "already_at_stage" = "created";
    let dealName: string | null = null;

    if (dealIds.length > 0) {
      // Trae propiedades de los deals para escoger uno abierto
      const dealsRes = await client.post("/crm/v3/objects/deals/batch/read", {
        properties: ["dealname", "dealstage", "pipeline"],
        inputs: dealIds.map((id) => ({ id })),
      });
      const deals = (dealsRes.data?.results || []) as Array<{
        id: string;
        properties: Record<string, string>;
      }>;

      const closedStages = new Set(["closedwon", "closedlost"]);
      const openDeal = deals.find((d) => !closedStages.has(d.properties.dealstage));

      if (openDeal) {
        dealId = openDeal.id;
        dealName = openDeal.properties.dealname;
        if (openDeal.properties.dealstage === targetStage) {
          dealAction = "already_at_stage";
        } else {
          await client.patch(`/crm/v3/objects/deals/${openDeal.id}`, {
            properties: { dealstage: targetStage },
          });
          dealAction = "moved";
        }
      }
    }

    if (!dealId) {
      const subject = (email.properties.hs_email_subject || "").trim();
      // Convención: "{Company} — {Subject}" para que el cliente sea identificable
      // en el kanban y en la búsqueda del agente. Si el contacto no tiene
      // company en HubSpot, caemos al nombre del contacto como label del cliente.
      const customerLabel = (cprops.company || "").trim() || contactName;
      dealName = subject
        ? `${customerLabel} — ${subject}`
        : `${customerLabel} — Propuesta`;

      // Trae la empresa primaria del contacto para enlazar el deal a la company.
      // Sin esto el deal queda solo asociado al contacto y luego las tareas no
      // pueden propagarse a la timeline de la empresa.
      let companyId: string | null = null;
      try {
        const companyAssoc = await client.get(
          `/crm/v3/objects/contacts/${contactId}/associations/companies`
        );
        companyId = companyAssoc.data?.results?.[0]?.id || null;
      } catch {
        // si falla, seguimos sin company association
      }

      const dealAssociations: Array<{ to: { id: string }; types: any[] }> = [
        {
          to: { id: contactId },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 3 }],
        },
      ];
      if (companyId) {
        dealAssociations.push({
          to: { id: companyId },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 5 }],
        });
      }

      const created = await client.post("/crm/v3/objects/deals", {
        properties: {
          dealname: dealName,
          dealstage: targetStage,
        },
        associations: dealAssociations,
      });
      dealId = created.data?.id;
      dealAction = "created";
    }

    await supabase.from("activity_log").insert({
      tenant_id: tenant.id,
      action: "proposal_email_synced",
      details: {
        email_id: email.id,
        email_subject: email.properties.hs_email_subject || null,
        contact_id: contactId,
        contact_name: contactName,
        deal_id: dealId,
        deal_name: dealName,
        deal_action: dealAction,
      },
    });
    if (dealId) touched.push({ id: dealId, name: dealName || "tu propuesta" });
    synced++;
  }

  await supabase
    .from("tenants")
    .update({ last_email_polled_at: new Date(now).toISOString() })
    .eq("id", tenant.id);

  return { synced, deals: touched };
}

// Punto de entrada del cron. Recorre tenants HubSpot activos y, para los
// deals que entraron a la etapa de "propuesta" desde la última corrida,
// crea una tarea en HubSpot + WhatsApp libre al comercial. No envía
// nada al cliente final (eso requeriría template pagado).
export async function pollProposalNotifications(
  extraDeals: Record<string, TouchedDeal[]> = {}
): Promise<PollResult> {
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
      result.notified += await pollTenant(tenant, extraDeals[tenant.id] || []);
    } catch (e: any) {
      const method = e?.config?.method?.toUpperCase();
      const url = e?.config?.url;
      const status = e?.response?.status;
      const data = e?.response?.data
        ? JSON.stringify(e.response.data)
        : e?.message || String(e);
      const where = url ? ` [${method} ${url} → ${status}]` : "";
      console.error(`[poll] tenant=${tenant.id} error${where}:`, data);
      result.errors.push(`${tenant.id}${where}: ${data}`);
    }
  }
  return result;
}

async function pollTenant(tenant: Tenant, extraDeals: TouchedDeal[] = []): Promise<number> {
  const supabase = createAdminClient();
  const crm = getCrmAdapter(tenant);
  const stageId = tenant.proposal_stage_id!;
  const now = Date.now();

  const client = axios.create({
    baseURL: "https://api.hubapi.com",
    headers: { Authorization: `Bearer ${tenant.hubspot_token}` },
  });

  // Trae todos los deals en la etapa de propuesta. El dedup contra
  // activity_log evita reenvíos; no usamos hs_date_entered_<stageId>
  // porque HubSpot lo rechaza con 400 en algunos portales.
  const search = await client.post("/crm/v3/objects/deals/search", {
    filterGroups: [
      {
        filters: [
          { propertyName: "dealstage", operator: "EQ", value: stageId },
        ],
      },
    ],
    properties: ["dealname", "dealstage"],
    limit: 50,
  });

  const found = (search.data.results || []) as Array<{
    id: string;
    properties: Record<string, string>;
  }>;

  // El índice de búsqueda de HubSpot es eventualmente consistente: un deal
  // recién creado/movido en esta misma corrida (por pollProposalEmails) puede
  // no aparecer todavía. Lo sumamos explícitamente para notificar el mismo día.
  const dealsById = new Map<string, string>();
  for (const d of found) {
    dealsById.set(d.id, d.properties.dealname || "tu propuesta");
  }
  for (const d of extraDeals) {
    if (!dealsById.has(d.id)) dealsById.set(d.id, d.name || "tu propuesta");
  }

  let queued = 0;

  for (const [dealId, dealName] of Array.from(dealsById.entries())) {
    // Dedup: si ya encolamos el follow-up para este deal, saltar
    const { data: prior } = await supabase
      .from("activity_log")
      .select("id")
      .eq("tenant_id", tenant.id)
      .eq("action", "proposal_followup_queued")
      .filter("details->>deal_id", "eq", dealId)
      .limit(1);

    if (prior && prior.length > 0) continue;

    const assoc = await client.get(
      `/crm/v3/objects/deals/${dealId}/associations/contacts`
    );
    const contactId = assoc.data?.results?.[0]?.id;
    if (!contactId) {
      console.warn(`[poll] deal ${dealId} sin contacto asociado, omitiendo`);
      await supabase.from("activity_log").insert({
        tenant_id: tenant.id,
        action: "proposal_skipped",
        details: { deal_id: dealId, reason: "no_contact" },
      });
      continue;
    }

    const contactRes = await client.get(
      `/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,phone,company`
    );
    const props = contactRes.data?.properties || {};
    const firstName = (props.firstname || "").trim() || "el cliente";
    const phoneRaw = (props.phone || "").trim();

    // Empresa: preferimos el record asociado (más confiable que la propiedad
    // free-text `company` del contacto, que se desactualiza).
    let companyName = "";
    try {
      const companyAssoc = await client.get(
        `/crm/v3/objects/contacts/${contactId}/associations/companies`
      );
      const companyId = companyAssoc.data?.results?.[0]?.id;
      if (companyId) {
        const companyRes = await client.get(
          `/crm/v3/objects/companies/${companyId}?properties=name`
        );
        companyName = (companyRes.data?.properties?.name || "").trim();
      }
    } catch {
      // si falla, caemos a la propiedad free-text del contacto
    }
    if (!companyName) companyName = (props.company || "").trim();

    // El cron corre a las 7am Bogotá del día siguiente al envío del correo,
    // así que "hoy" desde la perspectiva del cron == "día siguiente" desde la
    // perspectiva del cliente. La tarea queda due las 9am de hoy → el comercial
    // tiene 2 horas para prepararse y el digest de las 8am ya la verá en "Hoy".
    const todayBogota = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/Bogota",
    });
    const dealLabel = dealName.split(" — ").slice(-1)[0] || dealName;
    const contactRef = companyName ? `${firstName} de ${companyName}` : firstName;
    const taskTitle = phoneRaw
      ? `Enviar WhatsApp de seguimiento a ${contactRef} (${phoneRaw}) — ${dealLabel}`
      : `Enviar WhatsApp de seguimiento a ${contactRef} (sin teléfono) — ${dealLabel}`;

    let taskOk = false;
    let taskError: string | undefined;
    try {
      await crm.createTask({
        contactId,
        dealId,
        title: taskTitle,
        dueDate: todayBogota,
        dueTime: "09:00",
      });
      taskOk = true;
    } catch (taskErr: any) {
      taskError = taskErr?.response?.data
        ? JSON.stringify(taskErr.response.data)
        : taskErr?.message || String(taskErr);
      console.error(`[poll] createTask falló para deal ${dealId}:`, taskError);
    }

    await supabase.from("activity_log").insert({
      tenant_id: tenant.id,
      action: "proposal_followup_queued",
      details: {
        deal_id: dealId,
        deal_name: dealName,
        contact_id: contactId,
        contact_phone: phoneRaw || null,
        task_due_date: todayBogota,
        task_created: taskOk,
        task_error: taskError || null,
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
