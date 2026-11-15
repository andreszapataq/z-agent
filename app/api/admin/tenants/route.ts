import { NextRequest, NextResponse } from "next/server";
import { getAllTenantsForAdmin, saveTenant, toAdminTenant } from "@/lib/tenants";
import { isAuthenticated } from "@/lib/admin-auth";
import { tenantCreateSchema } from "@/lib/schemas";
import { dropUnchangedTokens } from "@/lib/tenant-secrets";
import { safeError } from "@/lib/safe-error";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  if (!isAuthenticated(req)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  // Tokens enmascarados: el panel nunca recibe un token completo.
  const tenants = await getAllTenantsForAdmin();
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
    // Tenant nuevo: no hay token actual, pero descartamos un texto enmascarado
    // por si llega uno por error (nunca debe guardarse como token).
    const saved = await saveTenant(dropUnchangedTokens(parsed.data, null));
    return NextResponse.json(toAdminTenant(saved), { status: 201 });
  } catch (err: any) {
    console.error("[admin/tenants POST]", safeError(err));
    return NextResponse.json({ error: "Error guardando tenant" }, { status: 500 });
  }
}
