import { NextRequest, NextResponse } from "next/server";
import { getTenant, saveTenant, deleteTenant } from "@/lib/tenants";
import { isAuthenticated } from "@/lib/admin-auth";
import { tenantUpdateSchema } from "@/lib/schemas";

export const maxDuration = 30;

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
    // Si no llega name, leer el actual para no nullificarlo en el upsert
    let name = parsed.data.name;
    if (!name) {
      const existing = await getTenant(id);
      if (!existing) {
        return NextResponse.json({ error: "No encontrado" }, { status: 404 });
      }
      name = existing.name;
    }
    // Forzamos el id de la URL — no permitimos cambiarlo desde el body
    const saved = await saveTenant({ ...parsed.data, id, name });
    return NextResponse.json(saved);
  } catch (err: any) {
    console.error("[admin/tenants PUT]", err);
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
  } catch (err: any) {
    console.error("[admin/tenants DELETE]", err);
    return NextResponse.json({ error: "Error eliminando tenant" }, { status: 500 });
  }
}
