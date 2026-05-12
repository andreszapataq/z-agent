import { NextRequest, NextResponse } from "next/server";
import { pollProposalEmails, pollProposalNotifications } from "@/lib/hubspot-poll";

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
    // 1) Sync correos → deals (puede dejar deals nuevos en "propuesta")
    const emails = await pollProposalEmails();
    // 2) Notificar al comercial los deals que están en "propuesta"
    const deals = await pollProposalNotifications();
    return NextResponse.json({ ok: true, emails, deals });
  } catch (err: any) {
    console.error("[cron/check-deals] error", err);
    return NextResponse.json(
      { error: err?.message || "error" },
      { status: 500 }
    );
  }
}
