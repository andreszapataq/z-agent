import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { isAuthenticated } from "@/lib/admin-auth";
import { getTenant } from "@/lib/tenants";

export const maxDuration = 30;

// Lista los owners (comerciales) del HubSpot del tenant, para que el admin
// pueda elegir cuál se asigna a las tareas creadas por el agente.
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
    const res = await axios.get("https://api.hubapi.com/crm/v3/owners", {
      headers: { Authorization: `Bearer ${tenant.hubspot_token}` },
      params: { limit: 100 },
    });
    const owners = (res.data.results || []).map((o: any) => ({
      id: o.id,
      userId: o.userId,
      email: o.email,
      name: [o.firstName, o.lastName].filter(Boolean).join(" ").trim() || o.email,
      archived: o.archived,
    }));
    return NextResponse.json({ owners });
  } catch (err: any) {
    console.error("[hubspot-owners]", err?.response?.data || err.message);
    return NextResponse.json(
      {
        error: "Error consultando HubSpot",
        detail: err?.response?.data?.message || err.message,
      },
      { status: 502 }
    );
  }
}
