import { NextRequest, NextResponse } from "next/server";
import { getTenant, getTenantForAdmin, saveTenant, deleteTenant, toAdminTenant } from "@/lib/tenants";
import { isAuthenticated } from "@/lib/admin-auth";
import { tenantUpdateSchema } from "@/lib/schemas";
import { dropUnchangedTokens } from "@/lib/tenant-secrets";
import { safeError } from "@/lib/safe-error";

export const maxDuration = 30;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isAuthenticated(req)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  const { id } = await params;
  // Tokens enmascarados: el panel nunca recibe un token completo.
  const tenant = await getTenantForAdmin(id);
  if (!tenant) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }
  return NextResponse.json(tenant);
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isAuthenticated(req)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const parsed = tenantUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Datos inválidos", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const existing = await getTenant(id);
    if (!existing) {
      return NextResponse.json({ error: "No encontrado" }, { status: 404 });
    }
    // Un token solo se sobrescribe si llega con un valor nuevo. Vacío, null o
    // el texto enmascarado que mostró el panel → se conserva el actual (la
    // columna no viaja en el upsert y PostgREST no la toca).
    const data = dropUnchangedTokens(parsed.data, existing);
    // Si no llega name, usar el actual para no nullificarlo en el upsert
    const name = data.name || existing.name;
    // Forzamos el id de la URL — no permitimos cambiarlo desde el body
    const saved = await saveTenant({ ...data, id, name });
    return NextResponse.json(toAdminTenant(saved));
  } catch (err) {
    console.error("[admin/tenants PUT]", safeError(err));
    return NextResponse.json({ error: "Error guardando tenant" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isAuthenticated(req)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  const { id } = await params;
  try {
    await deleteTenant(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[admin/tenants DELETE]", safeError(err));
    return NextResponse.json({ error: "Error eliminando tenant" }, { status: 500 });
  }
}
