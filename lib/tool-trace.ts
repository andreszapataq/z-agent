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

// Resume una llamada a herramienta en una línea legible.
export function summarizeTool(name: string, input: any, result: string, isError: boolean): ToolTrace {
  if (isError) return `${name}: ${short(result, 100)}`;
  let data: any = result;
  try {
    data = JSON.parse(result);
  } catch {
    /* resultado de texto */
  }

  switch (name) {
    case "search_contact":
    case "search_deal": {
      const n = count(data);
      const ids = Array.isArray(data) ? data.slice(0, 3).map((x: any) => `${x.name || "?"} #${x.id}`).join(", ") : "";
      return `${name}("${short(String(input?.query ?? ""), 40)}") → ${n ?? "?"} resultado(s)${ids ? `: ${ids}` : ""}`;
    }
    case "search_company": {
      if (!Array.isArray(data)) return `${name} → ${short(String(result))}`;
      return `search_company → ${data
        .map((r: any) => `${r.query}: ${r.status}${r.matches?.[0] ? ` (${r.matches[0].name} #${r.matches[0].id})` : ""}`)
        .join("; ")}`;
    }
    case "create_contact":
    case "create_company": {
      if (data?.status === "created") {
        const o = data.contact || data.company;
        return `${name} → creado: ${o?.name} #${o?.id}`;
      }
      if (data?.status === "possible_duplicate") {
        return `${name} → NO creado, posible duplicado: ${(data.matches || [])
          .slice(0, 3)
          .map((m: any) => `${m.name} #${m.id}`)
          .join(", ")}`;
      }
      return `${name} → ${short(String(result))}`;
    }
    case "update_contact":
      return `update_contact #${input?.contact_id} → actualizado`;
    case "create_deal":
      return `create_deal → ${data?.name || "negocio"} #${data?.id ?? "?"}`;
    case "list_tasks":
      return `list_tasks → ${count(data) ?? "?"} tarea(s)`;
    default:
      return `${name} → ${short(typeof data === "string" ? data : JSON.stringify(data))}`;
  }
}

// Agrega al texto de un turno del asistente el registro de lo que ejecutó.
export function annotateWithTrace(content: string, actions: unknown): string {
  if (!Array.isArray(actions) || actions.length === 0) return content;
  const lines = actions.slice(0, 12).map((a) => `- ${String(a)}`);
  return `${content}\n\n[Registro interno — herramientas que ejecutaste en este turno (no lo menciones al usuario):\n${lines.join("\n")}]`;
}
