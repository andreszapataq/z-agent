import OpenAI, { toFile } from "openai";

// Transcripción de notas de voz. La API de Claude no recibe audio, así que
// usamos el modelo de transcripción de OpenAI (cuenta que Z-Agent ya tenía).
// Costo de referencia: centavos de dólar por minuto.

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY no está configurada (se usa para transcribir notas de voz)");
  }
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

// Vocabulario del negocio para que el modelo escriba bien nombres propios.
const VOCAB_HINT =
  "Conversación comercial en español de Colombia sobre clínicas, hospitales y médicos " +
  "(ortopedistas, neurocirujanos, instrumentadoras). Términos: HubSpot, DBM, duramadre, " +
  "Bio Tech Bank, Alamo Biologics, Dora, cotización, sede.";

const EXT_BY_MIME: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "audio/webm": "webm",
  "audio/wav": "wav",
};

export async function transcribeAudio(data: Buffer, mimeType: string): Promise<string> {
  const ext = EXT_BY_MIME[mimeType] || "ogg";
  const file = await toFile(data, `nota.${ext}`, { type: mimeType });
  const res = await getOpenAI().audio.transcriptions.create({
    file,
    model: process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
    language: "es",
    prompt: VOCAB_HINT,
  });
  return res.text || "";
}
