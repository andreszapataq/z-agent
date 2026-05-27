import { NextRequest, NextResponse } from "next/server";
import { pollDailyDigests } from "@/lib/daily-digest";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Vercel Cron envía Authorization: Bearer <CRON_SECRET> automáticamente
// si CRON_SECRET está configurado en las env vars del proyecto.
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  try {
    const digests = await pollDailyDigests();
    return NextResponse.json({ ok: true, digests });
  } catch (err: any) {
    console.error("[cron/daily-tasks] error", err);
    return NextResponse.json(
      { error: err?.message || "error" },
      { status: 500 }
    );
  }
}
