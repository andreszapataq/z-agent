import { normalizePhone } from "./phone";

// ============================================================
// Reglas de escritura de contactos y empresas
// ============================================================
// Lo que el modelo puede olvidar, el código lo garantiza. Estas reglas salen
// de la curaduría de la base de QNA (fase 1, oct–nov 2026) y aplican a todo
// lo que el agente escribe en el CRM:
// - Celular en «Móvil», fijo en «Teléfono», ambos +57 + 10 dígitos sin
//   espacios; extensión como " ext. N". Un fijo de 7 dígitos se rechaza
//   (falta el indicativo).
// - Nombres sin "Dr./Dra.", con mayúscula inicial si llegan todo en
//   minúscula o todo en mayúscula.
// - Ciudades con tildes; especialidad solo de la lista permitida.
// Los errores se lanzan con mensajes en español: el loop del agente se los
// devuelve al modelo, que le pregunta al usuario lo que falta.

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

// ------------------------------------------------------------
// Teléfonos
// ------------------------------------------------------------

export type PhoneKind = "mobile" | "landline" | "foreign";
export type ParsedPhone = { value: string; kind: PhoneKind };

const EXT_RE = /\s*(?:ext\.?|extensi[oó]n|ext:|x)\s*[:.#-]?\s*(\d{1,6})\s*$/i;

export function parsePhone(raw: string): ParsedPhone {
  const input = String(raw || "").trim();
  if (!input) throw new ValidationError("Teléfono vacío");

  let base = input;
  let ext: string | undefined;
  const m = input.match(EXT_RE);
  if (m) {
    ext = m[1];
    base = input.slice(0, m.index).trim();
  }

  const digits = base.replace(/\D/g, "");
  if (digits.length === 7) {
    throw new ValidationError(
      `El fijo ${input} tiene 7 dígitos: falta el indicativo de la ciudad (601 Bogotá, 602 Cali, 604 Antioquia, 605 Costa, 606 Eje Cafetero, 607 Santanderes, 608 otros). Pídeselo al usuario.`
    );
  }

  const normalized = normalizePhone(base) || "";
  const compact = normalized.startsWith("+") ? "+" + normalized.replace(/\D/g, "") : normalized;
  const withExt = (v: string) => (ext ? `${v} ext. ${ext}` : v);

  if (/^\+573\d{9}$/.test(compact)) {
    if (ext) throw new ValidationError(`El número ${input} es un celular y no lleva extensión.`);
    return { value: compact, kind: "mobile" };
  }
  if (/^\+576\d{9}$/.test(compact)) return { value: withExt(compact), kind: "landline" };
  if (/^\+57/.test(compact)) {
    throw new ValidationError(`No reconozco el número ${input}: un número colombiano debe tener 10 dígitos. Pide el número completo.`);
  }
  if (/^\+\d{8,15}$/.test(compact)) return { value: withExt(compact), kind: "foreign" };

  throw new ValidationError(`No reconozco el número ${input}. Pide el número completo (celular de 10 dígitos o fijo con indicativo).`);
}

// Reparte los números dictados entre Móvil y Teléfono según su tipo real, sin
// importar en qué campo los puso el modelo.
export function routePhones(input: { mobile?: string; phone?: string }): { mobilephone?: string; phone?: string } {
  const parsed: ParsedPhone[] = [];
  for (const raw of [input.mobile, input.phone]) {
    if (raw && String(raw).trim()) parsed.push(parsePhone(raw));
  }
  const out: { mobilephone?: string; phone?: string } = {};
  // Primero los celulares a Móvil, luego fijos a Teléfono; lo que sobre ocupa
  // el campo libre.
  for (const p of parsed.filter((p) => p.kind === "mobile")) {
    if (!out.mobilephone) out.mobilephone = p.value;
    else if (!out.phone) out.phone = p.value;
  }
  for (const p of parsed.filter((p) => p.kind === "landline")) {
    if (!out.phone) out.phone = p.value;
  }
  for (const p of parsed.filter((p) => p.kind === "foreign")) {
    if (!out.mobilephone && p.value === input.mobile) out.mobilephone = p.value;
    else if (!out.phone) out.phone = p.value;
    else if (!out.mobilephone) out.mobilephone = p.value;
  }
  return out;
}

// Para buscar por teléfono: devuelve el número en el formato guardado en el
// CRM (+57XXXXXXXXXX) si el texto parece un número; si no, null.
export function phoneSearchKey(query: string): string | null {
  const q = String(query || "").trim();
  if (/[a-záéíóúñ]/i.test(q.replace(/ext\.?/i, ""))) return null;
  const digits = q.replace(/\D/g, "");
  if (digits.length < 10) return null;
  try {
    const p = parsePhone(q);
    return p.value.split(" ext.")[0];
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// Nombres
// ------------------------------------------------------------

const CONNECTORS = new Set(["de", "del", "la", "las", "los", "el", "y", "e", "en", "para", "da", "do", "dos", "van", "von"]);
const HONORIFIC_RE = /^(?:dr|dra|doctor|doctora|dr\(a\))\.?\s+/i;

export function smartTitleCase(s: string): string {
  return s
    .toLowerCase()
    .split(" ")
    .map((w, i) => {
      if (!w) return w;
      if (i > 0 && CONNECTORS.has(w)) return w;
      return w
        .split("-")
        .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
        .join("-");
    })
    .join(" ");
}

// Limpia un nombre o apellido: espacios, prefijo "Dr./Dra." y mayúsculas
// cuando llega todo en minúscula o todo en mayúscula. Si ya viene con
// mayúsculas mixtas se respeta (p.ej. "McAllister", "Asistente del Dr. Pérez").
export function cleanPersonName(raw?: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  let s = String(raw).replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  s = s.replace(HONORIFIC_RE, "").trim();
  const letters = s.replace(/[^a-záéíóúüñ]/gi, "");
  if (letters && (letters === letters.toLowerCase() || letters === letters.toUpperCase())) {
    s = smartTitleCase(s);
  }
  return s;
}

// ------------------------------------------------------------
// Ciudades
// ------------------------------------------------------------

const CITY_ACCENTS: Record<string, string> = {
  bogota: "Bogotá",
  medellin: "Medellín",
  popayan: "Popayán",
  cucuta: "Cúcuta",
  ibague: "Ibagué",
  monteria: "Montería",
  quibdo: "Quibdó",
  tulua: "Tuluá",
  chia: "Chía",
  zipaquira: "Zipaquirá",
  facatativa: "Facatativá",
  fusagasuga: "Fusagasugá",
  apartado: "Apartadó",
  caucasia: "Caucasia",
  sincelejo: "Sincelejo",
  "san andres": "San Andrés",
  "santa marta": "Santa Marta",
  "rio negro": "Rionegro",
  rionegro: "Rionegro",
  "villa del rosario": "Villa del Rosario",
  "san jose del guaviare": "San José del Guaviare",
  "puerto lopez": "Puerto López",
  "cienaga": "Ciénaga",
  "bucaramanga": "Bucaramanga",
};

export function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function normalizeCity(raw?: string): string | undefined {
  if (!raw) return undefined;
  const s = String(raw).replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  const key = stripAccents(s).toLowerCase();
  if (CITY_ACCENTS[key]) return CITY_ACCENTS[key];
  const letters = s.replace(/[^a-záéíóúüñ]/gi, "");
  return letters === letters.toLowerCase() || letters === letters.toUpperCase() ? smartTitleCase(s) : s;
}

// ------------------------------------------------------------
// Especialidad
// ------------------------------------------------------------

// Opciones de la propiedad «Especialidad» en el HubSpot de QNA, excepto
// Odontología, que está fuera del alcance del CRM.
export const ESPECIALIDADES = [
  "Ortopedia",
  "Neurocirugía",
  "Maxilofacial",
  "Cirugía general",
  "Cirugía plástica",
  "Cirugía vascular",
  "Urología",
  "Oftalmología",
  "Podología",
] as const;

export function normalizeEspecialidad(raw?: string): string | undefined {
  if (!raw || !String(raw).trim()) return undefined;
  const key = stripAccents(String(raw)).toLowerCase().trim();
  if (key.startsWith("odontolog")) {
    throw new ValidationError("Odontología está fuera del alcance de este CRM: no se registran especialistas de odontología.");
  }
  const found = ESPECIALIDADES.find((e) => stripAccents(e).toLowerCase() === key);
  if (found) return found;
  throw new ValidationError(
    `"${raw}" no es una especialidad válida. Opciones: ${ESPECIALIDADES.join(", ")}. Si no es médico especialista, deja la especialidad vacía.`
  );
}

// ------------------------------------------------------------
// Correo
// ------------------------------------------------------------

export function normalizeEmail(raw?: string): string | undefined {
  if (!raw || !String(raw).trim()) return undefined;
  const e = String(raw).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new ValidationError(`El correo "${raw}" no parece válido.`);
  return e;
}

// ------------------------------------------------------------
// Empresas
// ------------------------------------------------------------

// Quita S.A.S., S.A., Ltda. (no E.S.E.) y ordena espacios.
const COMPANY_SUFFIX_RE = /[\s,]*\b(?:s\.?\s?a\.?\s?s\.?|s\.?\s?a\.?|ltda\.?)(?=\s|$)/gi;

export function cleanCompanyName(raw: string): string {
  let s = String(raw || "").replace(/\s+/g, " ").trim();
  s = s.replace(COMPANY_SUFFIX_RE, "").replace(/\s+/g, " ").replace(/[\s,-]+$/, "").trim();
  // Sedes: «Marca Sede», sin guion ni raya.
  s = s.replace(/\s+[-–—]\s+/g, " ");
  if (!s) throw new ValidationError("El nombre de la empresa está vacío.");
  const letters = s.replace(/[^a-záéíóúüñ]/gi, "");
  return letters === letters.toLowerCase() || letters === letters.toUpperCase() ? smartTitleCase(s) : s;
}

export function normalizeDomain(raw?: string): string | undefined {
  if (!raw || !String(raw).trim()) return undefined;
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
}

export function normalizeForMatch(s?: string): string {
  return stripAccents(String(s || "")).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
