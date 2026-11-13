import { createAdminClient } from "./supabase";
import { credsFromTenant, sendWhatsAppMessage } from "./whatsapp";
import { Tenant } from "./tenants";
import { getCrmAdapter } from "./crm";
import { TaskItem } from "./crm/types";

type DigestResult = {
  scanned: number;
  sent: number;
  skipped: number;
  errors: string[];
};

// Resumen diario de tareas pendientes por WhatsApp libre al owner_number.
// Cubre vencidas + hoy + esta semana, todo en zona Bogotá.
export async function pollDailyDigests(): Promise<DigestResult> {
  const result: DigestResult = { scanned: 0, sent: 0, skipped: 0, errors: [] };
  const supabase = createAdminClient();

  const { data: tenants, error } = await supabase
    .from("tenants")
    .select("*")
    .eq("status", "active")
    .eq("daily_digest_enabled", true)
    .not("whatsapp_phone_id", "is", null)
    .not("whatsapp_token", "is", null)
    .not("owner_number", "is", null);

  if (error) {
    result.errors.push(`supabase: ${error.message}`);
    return result;
  }
  if (!tenants) return result;

  result.scanned = tenants.length;

  for (const tenant of tenants as Tenant[]) {
    try {
      const status = await sendTenantDigest(tenant);
      if (status === "sent") result.sent++;
      else result.skipped++;
    } catch (e: any) {
      const detail = e?.response?.data
        ? JSON.stringify(e.response.data)
        : e?.message || String(e);
      console.error(`[daily-digest] tenant=${tenant.id}`, detail);
      result.errors.push(`${tenant.id}: ${detail}`);
    }
  }
  return result;
}

async function sendTenantDigest(tenant: Tenant): Promise<"sent" | "skipped"> {
  const supabase = createAdminClient();

  // Anclamos las fechas a Bogotá. "Hoy" en zona del comercial, no UTC.
  const today = todayInBogota();
  // Ventana rodante: muestra lo de hoy + los próximos 7 días, sin importar
  // qué día de la semana sea. Es más predecible que "hasta el domingo" (que se
  // achicaba a 1-2 días el viernes y dejaba huecos al lunes siguiente).
  const horizon = daysAfter(today, 7);
  const lookback = daysBefore(today, 30);

  // Dedup: si ya mandamos el digest hoy para este tenant, no repetir aunque
  // el cron se haya re-ejecutado (Vercel cron puede reintentar en algunos casos).
  const { data: prior } = await supabase
    .from("activity_log")
    .select("id")
    .eq("tenant_id", tenant.id)
    .eq("action", "daily_digest_sent")
    .filter("details->>date", "eq", today)
    .limit(1);

  if (prior && prior.length > 0) return "skipped";

  const crm = getCrmAdapter(tenant);
  const tasks = await crm.listTasks({
    fromDate: lookback,
    toDate: horizon,
    includeCompleted: false,
  });

  const overdue: TaskItem[] = [];
  const todayTasks: TaskItem[] = [];
  const upcoming: TaskItem[] = [];
  for (const t of tasks) {
    if (t.dueDate < today) overdue.push(t);
    else if (t.dueDate === today) todayTasks.push(t);
    else if (t.dueDate <= horizon) upcoming.push(t);
  }

  // Si no hay nada que reportar, no molestamos al comercial.
  if (overdue.length === 0 && todayTasks.length === 0 && upcoming.length === 0) {
    await supabase.from("activity_log").insert({
      tenant_id: tenant.id,
      action: "daily_digest_skipped",
      details: { date: today, reason: "no_pending_tasks" },
    });
    return "skipped";
  }

  const body = formatDigest({ overdue, today: todayTasks, upcoming, todayStr: today });

  let waOk = false;
  let waError: string | undefined;
  try {
    const creds = credsFromTenant(tenant);
    if (!creds) throw new Error("Tenant sin credenciales de WhatsApp");
    await sendWhatsAppMessage(creds, tenant.owner_number!, body);
    waOk = true;
  } catch (waErr: any) {
    waError = waErr?.response?.data
      ? JSON.stringify(waErr.response.data)
      : waErr?.message || String(waErr);
    console.warn(`[daily-digest] WhatsApp falló (probable ventana cerrada): ${waError}`);
  }

  await supabase.from("activity_log").insert({
    tenant_id: tenant.id,
    action: waOk ? "daily_digest_sent" : "daily_digest_failed",
    details: {
      date: today,
      overdue_count: overdue.length,
      today_count: todayTasks.length,
      upcoming_count: upcoming.length,
      whatsapp_error: waError || null,
    },
  });

  return waOk ? "sent" : "skipped";
}

// WhatsApp limita texto a 4096 chars. Truncamos por bucket y por título para
// que un día con 60+ tareas no nos haga rechazar el mensaje. La sección "Hoy"
// es la más importante → más slots; "Vencidas" y "Próximos días" muestran
// los primeros N ordenados y dejan un "y X más" al final.
const MAX_PER_BUCKET = { overdue: 12, today: 20, upcoming: 12 };
const MAX_TITLE_CHARS = 90;

function formatDigest(input: {
  overdue: TaskItem[];
  today: TaskItem[];
  upcoming: TaskItem[];
  todayStr: string;
}): string {
  const lines: string[] = [];
  lines.push(`☀️ *Tu día arranca con ${totalCount(input)} tareas pendientes*`);
  lines.push("");

  appendBucket(lines, "⚠️ *Vencidas*", input.overdue, MAX_PER_BUCKET.overdue, { showDate: true });
  appendBucket(lines, "📌 *Hoy*", input.today, MAX_PER_BUCKET.today, { showDate: false });
  appendBucket(lines, "📅 *Próximos días*", input.upcoming, MAX_PER_BUCKET.upcoming, { showDate: true });

  lines.push("Cuando completes alguna, dime aquí ('ya llamé a Juan', 'mandé la cotización a X') y la marco en el CRM.");

  return lines.join("\n").trim();
}

function appendBucket(
  lines: string[],
  header: string,
  tasks: TaskItem[],
  max: number,
  opts: { showDate: boolean }
) {
  if (tasks.length === 0) return;
  lines.push(`${header} (${tasks.length})`);
  const visible = tasks.slice(0, max);
  for (const t of visible) lines.push(formatLine(t, opts));
  const hidden = tasks.length - visible.length;
  if (hidden > 0) lines.push(`…y ${hidden} más (revísalas en HubSpot)`);
  lines.push("");
}

function formatLine(t: TaskItem, opts: { showDate: boolean }): string {
  const title = t.title.length > MAX_TITLE_CHARS
    ? `${t.title.slice(0, MAX_TITLE_CHARS - 1)}…`
    : t.title;
  const parts: string[] = [`• ${title}`];
  if (opts.showDate) {
    parts.push(`— ${t.dueDate}${t.dueTime ? ` ${t.dueTime}` : ""}`);
  } else if (t.dueTime) {
    parts.push(`— ${t.dueTime}`);
  }
  const ctx = t.dealName || t.companyName || t.contactName;
  if (ctx) parts.push(`(${ctx})`);
  return parts.join(" ");
}

function totalCount(input: { overdue: TaskItem[]; today: TaskItem[]; upcoming: TaskItem[] }): number {
  return input.overdue.length + input.today.length + input.upcoming.length;
}

function todayInBogota(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
}

function daysBefore(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00-05:00`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
}

function daysAfter(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00-05:00`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
}
