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

export async function loadConversationHistory(
  tenantId: string,
  phone: string
): Promise<ChatCompletionMessageParam[]> {
  try {
    const supabase = createAdminClient();
    const since = new Date(Date.now() - HISTORY_WINDOW_MINUTES * 60_000).toISOString();
    const { data, error } = await supabase
      .from("conversation_messages")
      .select("role, content")
      .eq("tenant_id", tenantId)
      .eq("phone", phone)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(HISTORY_MAX_MESSAGES);

    if (error || !data) return [];

    // La query trae los más recientes primero; los volteamos a orden
    // cronológico para que el modelo los lea en secuencia.
    return data
      .reverse()
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  } catch (e) {
    console.error("[conversation load error]", e);
    return [];
  }
}

export async function saveConversationTurn(
  tenantId: string,
  phone: string,
  role: "user" | "assistant",
  content: string
): Promise<void> {
  if (!content) return;
  try {
    const supabase = createAdminClient();
    await supabase
      .from("conversation_messages")
      .insert({ tenant_id: tenantId, phone, role, content });
  } catch (e) {
    console.error("[conversation save error]", e);
  }
}
