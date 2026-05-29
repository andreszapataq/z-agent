import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { createAdminClient } from "./supabase";

// ============================================================
// Conversation memory
// ============================================================
// El webhook procesa cada mensaje de WhatsApp en un contexto fresco, sin
// historial. Esto rompe cualquier flujo multi-turno: cuando el agente
// pregunta "¿Confirmas que marque la tarea?" y el usuario responde "Sí",
// el siguiente turno no tiene de qué tarea hablaba. Aquí persistimos los
// turnos textuales (user/assistant) de cada conversación para reinyectar
// una ventana reciente en `processMessage`.
//
// Guardamos solo los turnos conversacionales (texto del usuario y la
// respuesta final del agente), NO las llamadas a tools intermedias. Con
// eso el agente recupera el contexto suficiente para re-ejecutar la
// búsqueda y actuar sobre la confirmación, sin arrastrar el ruido de los
// tool_calls.

// Ventana temporal: un "Sí" o "marcala" llega segundos/minutos después,
// pero un comercial puede retomar a lo largo de la mañana. 6h cubre el
// caso del digest (8am) respondido a media mañana sin arrastrar contexto
// de días anteriores.
const HISTORY_WINDOW_MINUTES = 360;
// Tope de mensajes a reinyectar (≈6 turnos por lado).
const HISTORY_MAX_MESSAGES = 12;

// Referencia compacta a una tarea que el agente le mostró al usuario. Guardar
// el `id` real es lo que evita que en el turno de confirmación ("Sí") el modelo
// invente un task_id; con esto completa de forma determinista.
export type TaskRef = {
  id: string;
  title: string;
  dueDate: string;
  status?: string;
  dealName?: string;
  contactName?: string;
};

export type ConversationContext = {
  messages: ChatCompletionMessageParam[];
  // task_id reales mostrados en el turno más reciente que listó tareas.
  recentTasks: TaskRef[];
};

export async function loadConversationHistory(
  tenantId: string,
  phone: string
): Promise<ConversationContext> {
  try {
    const supabase = createAdminClient();
    const since = new Date(Date.now() - HISTORY_WINDOW_MINUTES * 60_000).toISOString();
    const { data, error } = await supabase
      .from("conversation_messages")
      .select("role, content, metadata")
      .eq("tenant_id", tenantId)
      .eq("phone", phone)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(HISTORY_MAX_MESSAGES);

    if (error || !data) return { messages: [], recentTasks: [] };

    // `data` viene del más reciente al más antiguo. Tomamos las tareas del
    // turno más reciente que las tenga (las que el usuario tiene "frescas").
    let recentTasks: TaskRef[] = [];
    for (const m of data) {
      const tasks = (m.metadata as any)?.tasks;
      if (Array.isArray(tasks) && tasks.length > 0) {
        recentTasks = tasks as TaskRef[];
        break;
      }
    }

    // Volteamos a orden cronológico para que el modelo lea la secuencia.
    const messages = data
      .reverse()
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    return { messages, recentTasks };
  } catch (e) {
    console.error("[conversation load error]", e);
    return { messages: [], recentTasks: [] };
  }
}

export async function saveConversationTurn(
  tenantId: string,
  phone: string,
  role: "user" | "assistant",
  content: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  if (!content) return;
  try {
    const supabase = createAdminClient();
    await supabase
      .from("conversation_messages")
      .insert({ tenant_id: tenantId, phone, role, content, metadata: metadata ?? null });
  } catch (e) {
    console.error("[conversation save error]", e);
  }
}
