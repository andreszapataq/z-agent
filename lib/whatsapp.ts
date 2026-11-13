import axios from "axios";
import crypto from "crypto";

// ============================================================
// Canal de WhatsApp: Meta directo o Kapso
// ============================================================
// Z-Agent habla el formato de la WhatsApp Cloud API de Meta. Kapso expone un
// proxy compatible con Graph: misma ruta y mismo cuerpo, solo cambia el host
// y la autenticación (X-API-Key del proyecto de Kapso en vez del token de
// Meta). Por eso el resto del código no sabe por cuál canal sale el mensaje:
// cada tenant elige `whatsapp_provider` y aquí se resuelve la URL y headers.
//
//   meta  → https://graph.facebook.com/{v}/...   Authorization: Bearer <token Meta>
//   kapso → https://app.kapso.ai/api/meta/{v}/... X-API-Key: <API key Kapso>
//
// En ambos casos la credencial vive en `tenant.whatsapp_token`.

const GRAPH_API_VERSION = "v22.0";
const META_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const KAPSO_BASE = `https://app.kapso.ai/api/meta/${GRAPH_API_VERSION}`;

export type WhatsAppProvider = "meta" | "kapso";

export type WhatsAppCreds = {
  phoneId: string;
  token: string;
  provider: WhatsAppProvider;
};

// Construye las credenciales desde un tenant. Devuelve null si faltan datos.
export function credsFromTenant(t: {
  whatsapp_phone_id: string | null;
  whatsapp_token: string | null;
  whatsapp_provider?: string | null;
}): WhatsAppCreds | null {
  if (!t.whatsapp_phone_id || !t.whatsapp_token) return null;
  return {
    phoneId: t.whatsapp_phone_id,
    token: t.whatsapp_token,
    provider: t.whatsapp_provider === "kapso" ? "kapso" : "meta",
  };
}

export function apiBase(provider: WhatsAppProvider): string {
  return provider === "kapso" ? KAPSO_BASE : META_BASE;
}

export function authHeaders(creds: Pick<WhatsAppCreds, "provider" | "token">): Record<string, string> {
  return creds.provider === "kapso"
    ? { "X-API-Key": creds.token }
    : { Authorization: `Bearer ${creds.token}` };
}

async function postMessage(creds: WhatsAppCreds, payload: Record<string, unknown>): Promise<void> {
  await axios.post(
    `${apiBase(creds.provider)}/${creds.phoneId}/messages`,
    { messaging_product: "whatsapp", ...payload },
    { headers: authHeaders(creds) }
  );
}

export async function sendWhatsAppMessage(creds: WhatsAppCreds, to: string, text: string): Promise<void> {
  await postMessage(creds, { to, type: "text", text: { body: text } });
}

// Envía un mensaje basado en un template aprobado por Meta.
// Necesario para mensajes proactivos (fuera de la ventana de 24h del cliente).
// `params` se mapea a las variables {{1}}, {{2}}... del template, en orden.
export async function sendWhatsAppTemplate(
  creds: WhatsAppCreds,
  to: string,
  templateName: string,
  lang: string,
  params: string[]
): Promise<void> {
  await postMessage(creds, {
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: lang },
      components: params.length
        ? [{ type: "body", parameters: params.map((p) => ({ type: "text", text: p })) }]
        : [],
    },
  });
}

// Marca el mensaje como leído y muestra "escribiendo…" mientras el agente
// trabaja (Meta lo apaga solo al responder o a los 25 s). Best-effort: si
// falla no interrumpe nada.
export async function markReadWithTyping(creds: WhatsAppCreds, messageId: string): Promise<void> {
  try {
    await postMessage(creds, {
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
    });
  } catch (e: any) {
    console.warn("[whatsapp] markRead falló:", e?.response?.status || e?.message);
  }
}

// Descarga un archivo recibido (audio, imagen) a partir de su media_id.
// - Meta: GET /{media_id} devuelve una `url` temporal que se descarga con el
//   mismo Bearer token.
// - Kapso: GET /{media_id}?phone_number_id=… devuelve `download_url` (servida
//   por Kapso) y la `url` original de Meta. Preferimos `download_url`; la
//   API key solo se envía si el host es de Kapso.
export async function downloadMedia(
  creds: WhatsAppCreds,
  mediaId: string
): Promise<{ data: Buffer; mimeType: string }> {
  const base = apiBase(creds.provider);
  const meta = await axios.get(`${base}/${mediaId}`, {
    headers: authHeaders(creds),
    params: creds.provider === "kapso" ? { phone_number_id: creds.phoneId } : undefined,
  });
  const info = meta.data || {};
  const url: string | undefined =
    creds.provider === "kapso" ? info.download_url || info.url : info.url;
  if (!url) throw new Error("La API no devolvió URL de descarga para el archivo");

  const headers =
    creds.provider === "meta"
      ? authHeaders(creds)
      : isKapsoHost(url)
        ? authHeaders(creds)
        : {};
  const file = await axios.get<ArrayBuffer>(url, {
    headers,
    responseType: "arraybuffer",
    maxContentLength: 20 * 1024 * 1024,
  });
  const mimeType = String(info.mime_type || file.headers["content-type"] || "application/octet-stream")
    .split(";")[0]
    .trim();
  return { data: Buffer.from(file.data), mimeType };
}

export function isKapsoHost(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "kapso.ai" || h.endsWith(".kapso.ai");
  } catch {
    return false;
  }
}

// ------------------------------------------------------------
// Verificación de firma del webhook
// ------------------------------------------------------------
// Meta firma el cuerpo crudo con HMAC-SHA256 usando el App Secret y lo envía
// en `x-hub-signature-256` con formato "sha256=<hex>".
export function verifyMetaSignature(rawBody: string, signatureHeader: string | null): boolean {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret || !signatureHeader) return false;
  const expected =
    "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  return safeEqual(signatureHeader, expected);
}

// Kapso reenvía el payload de Meta tal cual y lo firma con el `secret_key`
// que definimos al crear el webhook: HMAC-SHA256 en hex, sin prefijo, en el
// header `x-webhook-signature`.
export function verifyKapsoSignature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = process.env.KAPSO_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return safeEqual(signatureHeader.replace(/^sha256=/, ""), expected);
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
