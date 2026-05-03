import axios from "axios";
import crypto from "crypto";

const GRAPH_API_VERSION = "v22.0";

export async function sendWhatsAppMessage(
  phoneId: string,
  token: string,
  to: string,
  text: string
): Promise<void> {
  await axios.post(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneId}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    },
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
}

// Verifica que el POST al webhook viene realmente de Meta.
// Meta firma el cuerpo crudo con HMAC-SHA256 usando el App Secret y lo
// envía en el header `x-hub-signature-256` con formato "sha256=<hex>".
export function verifyMetaSignature(rawBody: string, signatureHeader: string | null): boolean {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret || !signatureHeader) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");

  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
