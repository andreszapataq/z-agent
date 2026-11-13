import { Redis } from "@upstash/redis";

// Kapso reintenta la entrega del webhook si no recibe 200 en 10 s, y Meta
// también reintenta. Para no procesar dos veces el mismo mensaje (y crear un
// contacto duplicado), marcamos cada message.id la primera vez que llega.
// Sin Upstash configurado, deja pasar (fail-open, igual que el rate limit).

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = url && token ? new Redis({ url, token }) : null;

const TTL_SECONDS = 24 * 60 * 60;

export async function firstTimeSeen(key: string): Promise<boolean> {
  if (!redis || !key) return true;
  try {
    const res = await redis.set(`wa:msg:${key}`, "1", { nx: true, ex: TTL_SECONDS });
    return res === "OK";
  } catch (e) {
    console.error("[dedupe] redis error, dejando pasar", e);
    return true;
  }
}
