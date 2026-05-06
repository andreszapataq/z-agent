import { NextRequest, NextResponse } from "next/server";
import { buildSessionCookie, isValidSecret } from "@/lib/admin-auth";
import { adminAuthLimiter, checkLimit, getClientIp } from "@/lib/ratelimit";

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  const limit = await checkLimit(adminAuthLimiter, ip);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Demasiados intentos, espera unos minutos" },
      { status: 429 }
    );
  }

  let secret: unknown;
  try {
    const body = await req.json();
    secret = body?.secret;
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  if (typeof secret !== "string" || !isValidSecret(secret)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(buildSessionCookie(secret));
  return res;
}
