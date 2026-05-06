import { NextRequest, NextResponse } from "next/server";
import { getAllTenants, saveTenant } from "@/lib/tenants";
import { isAuthenticated } from "@/lib/admin-auth";
import { tenantCreateSchema } from "@/lib/schemas";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  if (!isAuthenticated(req)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  const tenants = await getAllTenants();
  return NextResponse.json(tenants);
}

export async function POST(req: NextRequest) {
  if (!isAuthenticated(req)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const parsed = tenantCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Datos inválidos", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const saved = await saveTenant(parsed.data);
    return NextResponse.json(saved, { status: 201 });
  } catch (err: any) {
    console.error("[admin/tenants POST]", err);
    return NextResponse.json({ error: "Error guardando tenant" }, { status: 500 });
  }
}
