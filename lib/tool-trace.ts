// ============================================================
// Registro de herramientas por turno
// ============================================================
// La memoria de conversación guarda solo el texto de cada turno. Sin más
// contexto, el modelo ve en el historial respuestas como "No encontré a
// nadie" o "Listo, registré" sin ninguna llamada a herramientas detrás, y
// la regla antialucinación lo lleva a concluir que no verificó y a pedir
// disculpas por algo que sí hizo. Guardamos un resumen compacto de las
// herramientas ejecutadas en cada turno (con los IDs reales) y se lo
// mostramos junto al turno en el historial.

export type ToolTrace = string;

const MAX_LEN = 140;

function short(s: string, n = MAX_LEN): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

function count(v: unknown): number | null {
  return Array.isArray(v) ? v.length : null;
}

// Formas de los resultados de herramientas que se resumen (JSON de los
// adapters). Todo opcional: el resultado puede ser texto o venir incompleto.
type Named = { id?: string; name?: string };
type CompanyCheck = { query?: string; status?: string; matches?: Named[] };
type ToolResultData = Named & {
  status?: string;
  contact?: Named;
  company?: Named;
  matches?: Named[];
};

// Resume una llamada a herramienta en una línea legible.
export function summarizeTool(
  name: string,
  input: Record<string, unknown>,
  result: string,
  isError: boolean
): ToolTrace {
  if (isError) return `${name}: ${short(result, 100)}`;
  let data: unknown = result;
  try {
    data = JSON.parse(result);
  } catch {
    /* resultado de texto */
  }

  switch (name) {
    case "search_contact":
    case "search_deal": {
      const n = count(data);
      const ids = Array.isArray(data)
        ? (data as Named[]).slice(0, 3).map((x) => `${x.name || "?"} #${x.id}`).join(", ")
        : "";
      return `${name}("${short(String(input?.query ?? ""), 40)}") → ${n ?? "?"} resultado(s)${ids ? `: ${ids}` : ""}`;
    }
    case "search_company": {
      if (!Array.isArray(data)) return `${name} → ${short(String(result))}`;
      return `search_company → ${(data as CompanyCheck[])
        .map((r) => `${r.query}: ${r.status}${r.matches?.[0] ? ` (${r.matches[0].name} #${r.matches[0].id})` : ""}`)
        .join("; ")}`;
    }
    case "create_contact":
    case "create_company": {
      const d = data as ToolResultData | null;
      if (d?.status === "created") {
        const o = d.contact || d.company;
        return `${name} → creado: ${o?.name} #${o?.id}`;
      }
      if (d?.status === "possible_duplicate") {
        return `${name} → NO creado, posible duplicado: ${(d.matches || [])
          .slice(0, 3)
          .map((m) => `${m.name} #${m.id}`)
          .join(", ")}`;
      }
      return `${name} → ${short(String(result))}`;
    }
    case "update_contact":
      return `update_contact #${input?.contact_id} → actualizado`;
    case "create_deal": {
      const d = data as ToolResultData | null;
      return `create_deal → ${d?.name || "negocio"} #${d?.id ?? "?"}`;
    }
    case "list_tasks":
      return `list_tasks → ${count(data) ?? "?"} tarea(s)`;
    default:
      return `${name} → ${short(typeof data === "string" ? data : JSON.stringify(data))}`;
  }
}

// El modelo ve en el historial que sus turnos terminan con el bloque
// "[Registro interno …]" y a veces lo imita al final de su respuesta (con un
// listado inventado, no el real). Pese a la instrucción del prompt, pasó en
// producción y llegó por WhatsApp al usuario. Este filtro es la garantía
// determinista: se aplica a la respuesta antes de enviarla/guardarla, y al
// leer el historial, para que un turno ya contaminado no refuerce el patrón.
const TRACE_MARKER = /\[\s*Registro interno/i;

export function stripInternalTrace(content: string): string {
  const m = TRACE_MARKER.exec(content);
  if (!m) return content;
  const before = content.slice(0, m.index).trimEnd();
  if (before) return before; // caso normal: el bloque va al final
  // Si (raro) el bloque viene al inicio, quitamos solo hasta su "]" de cierre.
  const close = content.indexOf("]", m.index);
  return close === -1 ? "" : content.slice(close + 1).trim();
}

// Agrega al texto de un turno del asistente el registro de lo que ejecutó.
export function annotateWithTrace(content: string, actions: unknown): string {
  content = stripInternalTrace(content);
  if (!Array.isArray(actions) || actions.length === 0) return content;
  const lines = actions.slice(0, 12).map((a) => `- ${String(a)}`);
  return `${content}\n\n[Registro interno — herramientas que ejecutaste en este turno (no lo menciones al usuario):\n${lines.join("\n")}]`;
}
