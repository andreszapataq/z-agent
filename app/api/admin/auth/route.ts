import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { secret } = await req.json();
  if (secret === process.env.ADMIN_SECRET) {
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "No autorizado" }, { status: 401 });
}
