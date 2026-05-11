import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase";
import { isAuthenticated } from "@/lib/admin-auth";

export const maxDuration = 30;

// Bogota is UTC-5 year-round (no DST). Start of "today" in Bogota = today's
// Bogota date at 00:00, expressed in UTC.
function startOfBogotaTodayUTC(): string {
  const now = new Date();
  const bogotaNow = new Date(now.getTime() - 5 * 60 * 60 * 1000);
  const y = bogotaNow.getUTCFullYear();
  const m = bogotaNow.getUTCMonth();
  const d = bogotaNow.getUTCDate();
  // 00:00 Bogota = 05:00 UTC of same Bogota date
  return new Date(Date.UTC(y, m, d, 5, 0, 0)).toISOString();
}

export async function GET(req: NextRequest) {
  if (!isAuthenticated(req)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const since = startOfBogotaTodayUTC();
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("activity_log")
    .select("tenant_id")
    .eq("action", "message_received")
    .gte("created_at", since);

  if (error) {
    console.error("[stats/messages-today]", error);
    return NextResponse.json({ error: "Error consultando actividad" }, { status: 500 });
  }

  const counts: Record<string, number> = {};
  for (const row of data || []) {
    const id = (row as { tenant_id: string }).tenant_id;
    if (!id) continue;
    counts[id] = (counts[id] || 0) + 1;
  }

  return NextResponse.json({ counts, since });
}
