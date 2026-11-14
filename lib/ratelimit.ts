import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { NextRequest } from "next/server";

const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

const redis = redisUrl && redisToken
  ? new Redis({ url: redisUrl, token: redisToken })
  : null;

function makeLimiter(tokens: number, window: `${number} ${"s" | "m" | "h"}`, prefix: string) {
  if (!redis) return null;
  return new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(tokens, window),
    analytics: false,
    prefix,
  });
}

// Webhook: hasta 60 mensajes/min por phone_number_id (tenant)
export const webhookLimiter = makeLimiter(60, "1 m", "rl:webhook");

// Login admin: hasta 5 intentos cada 5 min por IP (anti brute-force)
export const adminAuthLimiter = makeLimiter(5, "5 m", "rl:admin-auth");

export function getClientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

// Devuelve true si pasa, false si excede. Si Upstash no está configurado, deja pasar
// (fail-open) — apropiado para entornos de dev. En prod, configura Upstash siempre.
// Si Upstash falla (credenciales inválidas, base archivada por inactividad,
// caída), también deja pasar y lo registra: un rate limit caído no puede
// tumbar el login del panel ni el webhook de WhatsApp.
export async function checkLimit(
  limiter: Ratelimit | null,
  key: string
): Promise<{ ok: boolean; remaining?: number; reset?: number }> {
  if (!limiter) return { ok: true };
  try {
    const res = await limiter.limit(key);
    return { ok: res.success, remaining: res.remaining, reset: res.reset };
  } catch (e: any) {
    console.error("[ratelimit] Upstash no respondió, dejando pasar:", e?.message || e);
    return { ok: true };
  }
}
