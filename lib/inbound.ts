import { WhatsAppCreds, downloadMedia } from "./whatsapp";
import { transcribeAudio } from "./transcribe";

// ============================================================
// Mensajes entrantes → entrada del agente
// ============================================================
// El comercial no solo escribe: reenvía contactos de WhatsApp, manda notas de
// voz y fotos de tarjetas. Aquí convertimos cada tipo de mensaje de la Cloud
// API (mismo formato con Meta directo o con Kapso) en una entrada uniforme
// para el agente: texto + imágenes opcionales.

export type AgentImage = { mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string };

export type AgentInput = {
  // Texto que ve el modelo y que queda en la memoria de conversación.
  text: string;
  // Imágenes (base64) para que el modelo las lea con visión. No se guardan en
  // la memoria; solo su descripción textual en `text`.
  images?: AgentImage[];
};

export type InboundResult = { ok: true; input: AgentInput } | { ok: false; reply: string };

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
// Límite de tamaño por imagen de la API de Claude.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const UNSUPPORTED_REPLY =
  "Por ahora puedo leer mensajes de texto, notas de voz, fotos (por ejemplo de tarjetas) y contactos compartidos. ¿Me lo puedes enviar de alguna de esas formas?";

export async function toAgentInput(message: any, creds: WhatsAppCreds): Promise<InboundResult> {
  switch (message?.type) {
    case "text": {
      const body = String(message.text?.body || "").trim();
      return body ? { ok: true, input: { text: body } } : { ok: false, reply: UNSUPPORTED_REPLY };
    }

    case "contacts": {
      const text = formatSharedContacts(message.contacts || []);
      return text ? { ok: true, input: { text } } : { ok: false, reply: UNSUPPORTED_REPLY };
    }

    case "audio": {
      const id = message.audio?.id;
      if (!id) return { ok: false, reply: UNSUPPORTED_REPLY };
      try {
        const { data, mimeType } = await downloadMedia(creds, id);
        const transcript = (await transcribeAudio(data, mimeType)).trim();
        if (!transcript) {
          return { ok: false, reply: "No logré entender la nota de voz. ¿Me la repites o me lo escribes?" };
        }
        return { ok: true, input: { text: `🎤 Nota de voz (transcrita automáticamente): «${transcript}»` } };
      } catch (e: any) {
        console.error("[inbound] audio:", e?.response?.status || e?.message);
        return { ok: false, reply: "No pude procesar la nota de voz. ¿Me lo puedes escribir?" };
      }
    }

    case "image": {
      const id = message.image?.id;
      const caption = String(message.image?.caption || "").trim();
      if (!id) return { ok: false, reply: UNSUPPORTED_REPLY };
      try {
        const { data, mimeType } = await downloadMedia(creds, id);
        if (!IMAGE_TYPES.has(mimeType)) {
          return { ok: false, reply: "Recibí la imagen pero en un formato que no puedo leer. ¿Me la envías como foto (JPG o PNG)?" };
        }
        if (data.length > MAX_IMAGE_BYTES) {
          return { ok: false, reply: "La foto es muy pesada para leerla (más de 5 MB). ¿Me la envías de nuevo con menor calidad?" };
        }
        const text = caption
          ? `📷 Foto enviada con el texto: «${caption}»`
          : "📷 Foto enviada sin texto (probablemente una tarjeta de presentación o los datos de un contacto).";
        return {
          ok: true,
          input: { text, images: [{ mediaType: mimeType as AgentImage["mediaType"], data: data.toString("base64") }] },
        };
      } catch (e: any) {
        console.error("[inbound] image:", e?.response?.status || e?.message);
        return { ok: false, reply: "No pude descargar la foto. ¿Me la envías de nuevo?" };
      }
    }

    case "button": {
      const t = String(message.button?.text || "").trim();
      return t ? { ok: true, input: { text: t } } : { ok: false, reply: UNSUPPORTED_REPLY };
    }

    case "interactive": {
      const t = String(
        message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || ""
      ).trim();
      return t ? { ok: true, input: { text: t } } : { ok: false, reply: UNSUPPORTED_REPLY };
    }

    default:
      return { ok: false, reply: UNSUPPORTED_REPLY };
  }
}

// Convierte la tarjeta de contacto de WhatsApp (vCard ya parseada por Meta) en
// texto legible para el agente.
export function formatSharedContacts(contacts: any[]): string {
  const blocks = (contacts || []).slice(0, 10).map((c) => {
    const lines: string[] = [];
    const name =
      c?.name?.formatted_name ||
      [c?.name?.prefix, c?.name?.first_name, c?.name?.middle_name, c?.name?.last_name].filter(Boolean).join(" ");
    if (name) lines.push(`Nombre: ${name}`);
    const title = c?.org?.title;
    const company = [c?.org?.company, c?.org?.department].filter(Boolean).join(" · ");
    if (title) lines.push(`Cargo: ${title}`);
    if (company) lines.push(`Empresa: ${company}`);
    for (const p of c?.phones || []) {
      const num = p?.phone || (p?.wa_id ? `+${p.wa_id}` : "");
      if (num) lines.push(`Teléfono${p?.type ? ` (${p.type})` : ""}: ${num}${p?.wa_id ? " [tiene WhatsApp]" : ""}`);
    }
    for (const e of c?.emails || []) if (e?.email) lines.push(`Correo: ${e.email}`);
    for (const a of c?.addresses || []) {
      const addr = [a?.street, a?.city, a?.state].filter(Boolean).join(", ");
      if (addr) lines.push(`Dirección: ${addr}`);
    }
    return lines.join("\n");
  }).filter(Boolean);

  if (blocks.length === 0) return "";
  const header = blocks.length === 1 ? "📇 Contacto compartido:" : `📇 ${blocks.length} contactos compartidos:`;
  return `${header}\n${blocks.join("\n---\n")}`;
}
