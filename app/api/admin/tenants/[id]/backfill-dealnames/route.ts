import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { isAuthenticated } from "@/lib/admin-auth";
import { getTenant } from "@/lib/tenants";
import { createAdminClient } from "@/lib/supabase";

export const maxDuration = 60;

// One-shot: recorre todos los deals abiertos del tenant en HubSpot y
// renombra los que NO incluyan ya el nombre de la empresa/contacto
// asociado, aplicando la convención `{Company} — {dealname original}`.
// Idempotente: si el dealname ya contiene el customer label, no toca.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isAuthenticated(req)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  const { id } = await params;
  const tenant = await getTenant(id);
  if (!tenant) {
    return NextResponse.json({ error: "Tenant no encontrado" }, { status: 404 });
  }
  if (tenant.crm_type !== "hubspot" || !tenant.hubspot_token) {
    return NextResponse.json(
      { error: "El backfill solo aplica para tenants HubSpot con token configurado" },
      { status: 400 }
    );
  }

  const client = axios.create({
    baseURL: "https://api.hubapi.com",
    headers: { Authorization: `Bearer ${tenant.hubspot_token}` },
  });

  const result = {
    scanned: 0,
    renamed: 0,
    skipped: 0,
    errors: [] as string[],
    sample: [] as Array<{ id: string; before: string; after: string }>,
  };

  try {
    // Paginar todos los deals que NO estén cerrados. HubSpot devuelve max 100/p.
    let after: string | undefined;
    const allDeals: Array<{ id: string; dealname: string }> = [];

    do {
      const body: Record<string, unknown> = {
        filterGroups: [
          {
            filters: [
              {
                propertyName: "dealstage",
                operator: "NOT_IN",
                values: ["closedwon", "closedlost"],
              },
            ],
          },
        ],
        properties: ["dealname", "dealstage"],
        limit: 100,
      };
      if (after) body.after = after;

      const res = await client.post("/crm/v3/objects/deals/search", body);
      for (const d of res.data?.results || []) {
        allDeals.push({ id: d.id, dealname: d.properties?.dealname || "" });
      }
      after = res.data?.paging?.next?.after;
    } while (after);

    result.scanned = allDeals.length;

    // Por deal: traer contacto asociado → company → renombrar si aplica.
    for (const d of allDeals) {
      try {
        const assoc = await client.get(
          `/crm/v3/objects/deals/${d.id}/associations/contacts`
        );
        const contactId = assoc.data?.results?.[0]?.id;
        if (!contactId) {
          result.skipped++;
          continue;
        }

        const cRes = await client.get(
          `/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,company`
        );
        const cprops = cRes.data?.properties || {};
        const company = (cprops.company || "").trim();
        const fullName = [cprops.firstname, cprops.lastname].filter(Boolean).join(" ").trim();
        const customerLabel = company || fullName;

        if (!customerLabel) {
          result.skipped++;
          continue;
        }

        // Idempotencia: si el dealname ya contiene el customer label
        // (case-insensitive), no lo renombramos.
        const current = d.dealname || "";
        if (current.toLowerCase().includes(customerLabel.toLowerCase())) {
          result.skipped++;
          continue;
        }

        const newName = current
          ? `${customerLabel} — ${current}`
          : `${customerLabel} — Propuesta`;

        await client.patch(`/crm/v3/objects/deals/${d.id}`, {
          properties: { dealname: newName },
        });

        result.renamed++;
        if (result.sample.length < 10) {
          result.sample.push({ id: d.id, before: current, after: newName });
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        result.errors.push(`deal ${d.id}: ${msg}`);
      }
    }

    // Log de auditoría
    try {
      const supabase = createAdminClient();
      await supabase.from("activity_log").insert({
        tenant_id: tenant.id,
        action: "dealnames_backfilled",
        details: {
          scanned: result.scanned,
          renamed: result.renamed,
          skipped: result.skipped,
          errors_count: result.errors.length,
          sample: result.sample,
        },
      });
    } catch {
      // no-op: el log es best-effort
    }

    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[backfill-dealnames]", msg);
    return NextResponse.json(
      { error: "Error consultando HubSpot", detail: msg, partial: result },
      { status: 502 }
    );
  }
}
