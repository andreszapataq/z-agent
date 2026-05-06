import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { isAuthenticated } from "@/lib/admin-auth";
import { getTenant } from "@/lib/tenants";

export const maxDuration = 30;

// Devuelve los pipelines de deals del tenant en HubSpot, con sus stages
// (id + label). Sirve para que el admin pueda elegir el stageId correcto
// sin tener que entrar a HubSpot a buscarlo.
export async function GET(
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
  if (!tenant.hubspot_token) {
    return NextResponse.json(
      { error: "Este tenant no tiene token de HubSpot configurado" },
      { status: 400 }
    );
  }

  try {
    const res = await axios.get(
      "https://api.hubapi.com/crm/v3/pipelines/deals",
      { headers: { Authorization: `Bearer ${tenant.hubspot_token}` } }
    );
    const pipelines = (res.data.results || []).map((p: any) => ({
      id: p.id,
      label: p.label,
      stages: (p.stages || [])
        .map((s: any) => ({
          id: s.id,
          label: s.label,
          displayOrder: s.displayOrder,
        }))
        .sort((a: any, b: any) => a.displayOrder - b.displayOrder),
    }));
    return NextResponse.json({ pipelines });
  } catch (err: any) {
    console.error("[hubspot-stages]", err?.response?.data || err.message);
    return NextResponse.json(
      {
        error: "Error consultando HubSpot",
        detail: err?.response?.data?.message || err.message,
      },
      { status: 502 }
    );
  }
}
