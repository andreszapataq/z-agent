// ============================================================
// Errores seguros para logs y activity_log
// ============================================================
// Un AxiosError lleva la petición completa en `config` y `request`, incluidas
// las cabeceras de autenticación de cada canal (Bearer de Meta/HubSpot,
// X-API-Key de Kapso). Imprimirlo con console.error(err) o serializarlo con
// JSON.stringify(err) deja esa credencial en texto plano en los logs.
//
// Regla: nunca registres un error tal cual. Pásalo por `safeError` (para
// logs) o por `toSafeError` (para relanzarlo desde código que hace HTTP).

const DEFAULT_MAX_CHARS = 1000;

export type SafeError = {
  message: string;
  status?: number;
  data?: unknown;
};

// Forma mínima que leemos de un error (axios, SDKs, Supabase o Error común).
type ErrorLike = {
  message?: unknown;
  status?: unknown;
  response?: { status?: unknown; data?: unknown };
  config?: unknown;
  request?: unknown;
} | null | undefined;

// Resume un error en { message, status, data }. Nunca incluye config,
// headers ni request. `data` es el cuerpo de la respuesta, recortado a
// `maxChars` caracteres si es largo.
export function safeError(err: unknown, maxChars = DEFAULT_MAX_CHARS): SafeError {
  const e = err as ErrorLike;
  const out: SafeError = { message: clip(errorMessage(err), maxChars) };

  const status = e?.response?.status ?? e?.status;
  if (typeof status === "number") out.status = status;

  const data = e?.response?.data;
  if (data !== undefined && data !== null) out.data = clipData(data, maxChars);

  return out;
}

// Forma de un error HTTP (axios, SafeHttpError o similar) tal como la leen los
// `catch`, para tiparlos sin `any`: `const e = err as HttpErrorLike`. Todo es
// opcional porque el error puede no venir de HTTP. Solo describe lo que se lee;
// para registrar un error sigue valiendo la regla de arriba (safeError).
export type HttpErrorLike = {
  message?: string;
  config?: { method?: string; url?: string };
  response?: {
    status?: number;
    headers?: Record<string, unknown>;
    data?: { message?: string } & Record<string, unknown>;
  };
};

// Para código que hace HTTP y relanza el error: devuelve un Error nuevo con
// el mismo mensaje y solo `response.status` / `response.data`, de modo que
// quien lo capture siga pudiendo leer `err.response.status` o
// `err.response.data`, pero sin config, headers ni request. A propósito no
// usa `cause`: el error original volvería a viajar con las cabeceras.
export type SafeHttpError = Error & {
  status?: number;
  response?: { status?: number; data?: unknown };
};

export function toSafeError(err: unknown): unknown {
  const e = err as ErrorLike;
  if (!e || typeof e !== "object" || (!e.config && !e.request)) return err;

  const safe: SafeHttpError = new Error(errorMessage(err));
  safe.name = "HttpError";
  if (e.response) {
    const status = typeof e.response.status === "number" ? e.response.status : undefined;
    safe.status = status;
    safe.response = { status, data: e.response.data };
  }
  return safe;
}

function errorMessage(err: unknown): string {
  const e = err as ErrorLike;
  if (typeof e?.message === "string" && e.message) return e.message;
  if (typeof err === "string" && err) return err;
  if (typeof err === "number" || typeof err === "boolean") return String(err);
  return "Error desconocido";
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function clipData(data: unknown, max: number): unknown {
  if (Buffer.isBuffer(data)) return `[binario, ${data.length} bytes]`;
  if (data instanceof ArrayBuffer) return `[binario, ${data.byteLength} bytes]`;
  if (ArrayBuffer.isView(data)) return `[binario, ${data.byteLength} bytes]`;
  if (typeof data === "string") return clip(data, max);

  let json: string | undefined;
  try {
    json = JSON.stringify(data);
  } catch {
    return "[no serializable]";
  }
  if (json === undefined) return undefined;
  // Si cabe, se conserva como objeto (más legible en activity_log); si no,
  // se guarda el JSON recortado.
  return json.length > max ? clip(json, max) : data;
}
