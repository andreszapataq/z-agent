import { NextRequest, NextResponse } from "next/server";
import { getAllTenants, saveTenant } from "@/lib/tenants";

function checkAuth(req: NextRequest) {
  return req.headers.get("x-admin-secret") === process.env.ADMIN_SECRET;
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  const tenants = await getAllTenants();
  return NextResponse.json(tenants);
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  try {
    const body = await req.json();
    if (!body.id || !body.name) {
      return NextResponse.json(
        { error: "id y name son requeridos" },
        { status: 400 }
      );
    }
    const saved = await saveTenant(body);
    return NextResponse.json(saved, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
