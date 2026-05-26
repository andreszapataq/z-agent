import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { Tenant } from "./tenants";
import { getCrmAdapter } from "./crm";
import { DealStage } from "./crm/types";
import { createAdminClient } from "./supabase";

let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_contact",
      description: "Busca un contacto en el CRM por nombre o empresa",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Nombre o empresa a buscar" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_contact",
      description: "Crea un nuevo contacto en el CRM. Úsalo cuando el usuario mencione una persona/empresa que no existe aún.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          company: { type: "string" },
          email: { type: "string" },
          phone: { type: "string" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_deal",
      description: "Busca un negocio/deal en el CRM",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Nombre del negocio o empresa" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_deal",
      description: "Crea un nuevo negocio/deal asociado a un contacto. Úsalo cuando el usuario quiera abrir una oportunidad de venta nueva.",
      parameters: {
        type: "object",
        properties: {
          contact_id: { type: "string", description: "ID del contacto al que se asocia el deal" },
          name: { type: "string", description: "Nombre del negocio (ej. 'Implementación Q3 - Clínica Norte')" },
          amount: { type: "number", description: "Monto esperado en moneda local (opcional)" },
          stage: {
            type: "string",
            enum: ["saludo", "presentación", "propuesta", "negociación", "cierre", "perdido"],
            description: "Etapa inicial del deal (por defecto: saludo)",
          },
        },
        required: ["contact_id", "name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_deal",
      description: "Mueve un negocio a una etapa del pipeline",
      parameters: {
        type: "object",
        properties: {
          deal_id: { type: "string" },
          stage: {
            type: "string",
            enum: ["saludo", "presentación", "propuesta", "negociación", "cierre", "perdido"],
          },
        },
        required: ["deal_id", "stage"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_note",
      description:
        "Registra una nota de actividad. Asóciala al deal cuando la nota habla del avance del negocio (motivo de cambio de etapa, pedido específico del cliente sobre la propuesta, etc.). Asóciala al contacto cuando es info general de la persona. Puedes pasar ambas si aplica.",
      parameters: {
        type: "object",
        properties: {
          deal_id: { type: "string", description: "ID del deal donde anclar la nota (preferido cuando el contexto es del negocio)" },
          contact_id: { type: "string", description: "ID del contacto donde anclar la nota" },
          note: { type: "string" },
        },
        required: ["note"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_task",
      description:
        "Crea una tarea o alerta de seguimiento. PREFIERE pasar deal_id cuando la tarea se refiera a un negocio en curso — eso enlaza la tarea al deal, a TODOS sus contactos y a su empresa automáticamente, y la asigna al comercial dueño del deal. Si la tarea es solo sobre una persona (sin deal de por medio), pasa contact_id. Pasa due_time solo si el usuario indica una hora explícita.",
      parameters: {
        type: "object",
        properties: {
          deal_id: {
            type: "string",
            description: "ID del deal al que está vinculada la tarea. Si lo pasas, la tarea se asocia automáticamente al deal + sus contactos + su empresa, y se asigna al owner del deal. Úsalo siempre que el usuario mencione un negocio, deal, propuesta, cuenta o cliente con deal abierto.",
          },
          contact_id: {
            type: "string",
            description: "ID de un contacto específico. Úsalo cuando la tarea sea solo sobre la persona (sin deal asociado) o cuando quieras añadir un contacto extra además del deal.",
          },
          title: { type: "string" },
          due_date: {
            type: "string",
            description: "Fecha en formato YYYY-MM-DD",
          },
          due_time: {
            type: "string",
            description: "Hora en formato 24h HH:MM, hora Bogotá (ej. '14:30' para 2:30 pm). Opcional — solo úsala si el usuario indica una hora explícita ('a las 3 pm', 'en la mañana', etc.). Si no se especifica, el sistema usa 09:00.",
          },
        },
        required: ["title", "due_date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tasks",
      description:
        "Lista las tareas pendientes del comercial en un rango de fechas. Úsalo cuando el usuario pida 'mis tareas de hoy', 'tareas de mañana', 'tareas del viernes', 'qué tengo esta semana', etc. Resuelve las fechas relativas usando la FECHA ACTUAL del system prompt y pásalas en formato YYYY-MM-DD. Para un solo día, pasa el mismo valor en from_date y to_date.",
      parameters: {
        type: "object",
        properties: {
          from_date: {
            type: "string",
            description: "Inicio del rango (inclusive), formato YYYY-MM-DD, hora Bogotá.",
          },
          to_date: {
            type: "string",
            description: "Fin del rango (inclusive), formato YYYY-MM-DD, hora Bogotá. Para un solo día, igual a from_date.",
          },
          include_completed: {
            type: "boolean",
            description: "Si true, incluye también tareas ya completadas. Por defecto false (solo pendientes).",
          },
        },
        required: ["from_date", "to_date"],
      },
    },
  },
];

async function logActivity(tenantId: string, action: string, details: any) {
  try {
    const supabase = createAdminClient();
    await supabase.from("activity_log").insert({
      tenant_id: tenantId,
      action,
      details,
    });
  } catch (e) {
    console.error("[activity_log error]", e);
  }
}

export async function processMessage(userMessage: string, tenant: Tenant): Promise<string> {
  const crm = getCrmAdapter(tenant);

  // The OpenAI model has no notion of the current date, so it tends to
  // anchor relative dates ("el viernes", "mañana", "la próxima semana") to
  // its training cutoff and produces wildly past `due_date` values.
  // Anchoring to America/Bogota matches the operating timezone of QNA
  // Medical's commercial team. If we ever onboard a tenant in another
  // timezone, promote this to a column on `tenants`.
  const todayInBogota = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Bogota",
  });
  const weekdayInBogota = new Date().toLocaleDateString("es-CO", {
    timeZone: "America/Bogota",
    weekday: "long",
  });
  const dateContext = `\n\n📅 FECHA ACTUAL: ${todayInBogota} (${weekdayInBogota}, zona horaria America/Bogota). Úsala como referencia obligatoria para los due_date de tareas. Reglas:
- "mañana" = el día siguiente a la fecha actual.
- "el viernes" / "este viernes" = el próximo viernes a partir de hoy (si hoy es viernes, asume que se refiere a hoy mismo salvo que el contexto diga lo contrario).
- "el próximo lunes" / "el lunes que viene" = el lunes de la SEMANA SIGUIENTE. Si hoy ya es lunes, son 7 días después, NO hoy ni mañana. Lo mismo para cualquier otro día.
- "en X días" = suma X días a la fecha actual.`;

  // Inyectamos los labels reales del pipeline para que el agente hable con la
  // misma terminología que ve el comercial en HubSpot. Si la consulta falla,
  // listStages devuelve los slugs como label y el agente sigue operando.
  let stagesContext = "";
  try {
    const stages = await crm.listStages();
    if (stages.length > 0) {
      const lines = stages.map((s) => `- \`${s.slug}\` → "${s.label}"`).join("\n");
      stagesContext = `\n\n📊 ETAPAS DEL PIPELINE (orden real del CRM del tenant):\n${lines}\n\nCuando hables con el usuario, usa los labels (la parte entre comillas). En los tools \`move_deal\` y \`create_deal\` usa el slug (la parte con backticks).`;
    }
  } catch (e) {
    console.error("[listStages error]", e);
  }

  const notesContext =
    `\n\n📝 REGLA DE NOTAS: cuando muevas un deal con un motivo concreto (p.ej. "pidió documentos técnicos", "objetó el precio", "pidió tiempo para decidir"), inmediatamente después del \`move_deal\` llama \`create_note\` describiendo brevemente el motivo. Pasa SIEMPRE ambos identificadores cuando los tengas: \`deal_id\` (del deal que moviste) Y \`contact_id\` (del contacto asociado, que viene en search_deal/search_contact). Así el comercial ve la nota tanto en la timeline del deal como en la del contacto sin importar desde dónde llegue.`;

  const tasksContext =
    `\n\n✅ REGLA DE TAREAS: cuando el usuario pida una tarea relacionada con un negocio/deal/propuesta/cuenta, SIEMPRE llama primero \`search_deal\` para obtener el \`deal_id\` y pásalo como \`deal_id\` en \`create_task\`. NO uses \`contact_id\` solo en este caso: pasar \`deal_id\` enlaza la tarea al deal + sus contactos + su empresa y la asigna al comercial dueño del deal automáticamente. Solo usa \`contact_id\` sin \`deal_id\` cuando la tarea sea explícitamente sobre una persona sin deal abierto (p.ej. "llamar a Juan el viernes" sin mencionar negocio).`;

  const listTasksContext =
    `\n\n📋 REGLA DE LISTAR TAREAS: cuando el usuario pida ver sus tareas ("mis tareas de hoy", "qué tengo mañana", "tareas del viernes", "tareas de la semana"), usa \`list_tasks\` con from_date/to_date resueltos contra la FECHA ACTUAL. Rangos típicos:
- "hoy" → from_date = to_date = fecha actual.
- "mañana" → from_date = to_date = fecha actual + 1.
- "esta semana" → from_date = fecha actual, to_date = el próximo domingo (inclusive).
- "la próxima semana" → from_date = el próximo lunes, to_date = el domingo siguiente.
Al responder, presenta cada tarea con título, fecha (y hora si la hay) y el deal/contacto asociado. Si no hay tareas en el rango, dilo claramente.`;

  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        (tenant.system_prompt || `Eres el asistente de ventas de ${tenant.name}.`) +
        dateContext +
        stagesContext +
        notesContext +
        tasksContext +
        listTasksContext,
    },
    { role: "user", content: userMessage },
  ];

  await logActivity(tenant.id, "message_received", { text: userMessage });

  // Loop del agente: usa tools hasta llegar a una respuesta final
  for (let i = 0; i < 10; i++) {
    const response = await getOpenAI().chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      max_tokens: 1024,
      tools: TOOLS,
      messages,
    });

    const choice = response.choices[0];
    const message = choice.message;
    messages.push(message);

    if (!message.tool_calls || message.tool_calls.length === 0) {
      return message.content || "Listo.";
    }

    for (const toolCall of message.tool_calls) {
      if (toolCall.type !== "function") continue;
      const name = toolCall.function.name;
      let input: any = {};
      try {
        input = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
      } catch {
        input = {};
      }

      let toolResult = "";
      try {
        switch (name) {
          case "search_contact":
            toolResult = JSON.stringify(await crm.searchContact(input.query));
            break;
          case "create_contact":
            toolResult = JSON.stringify(await crm.createContact(input));
            break;
          case "search_deal":
            toolResult = JSON.stringify(await crm.searchDeal(input.query));
            break;
          case "create_deal":
            toolResult = JSON.stringify(
              await crm.createDeal({
                contactId: input.contact_id,
                name: input.name,
                amount: input.amount,
                stage: (input.stage as DealStage) || "saludo",
              })
            );
            break;
          case "move_deal":
            toolResult = await crm.moveDeal(input.deal_id, input.stage as DealStage);
            break;
          case "create_note":
            toolResult = await crm.createNote({
              contactId: input.contact_id,
              dealId: input.deal_id,
              body: input.note,
            });
            break;
          case "create_task":
            toolResult = await crm.createTask({
              contactId: input.contact_id,
              dealId: input.deal_id,
              title: input.title,
              dueDate: input.due_date,
              dueTime: input.due_time,
            });
            break;
          case "list_tasks":
            toolResult = JSON.stringify(
              await crm.listTasks({
                fromDate: input.from_date,
                toDate: input.to_date,
                includeCompleted: input.include_completed === true,
              })
            );
            break;
          default:
            toolResult = `Tool desconocido: ${name}`;
        }
        await logActivity(tenant.id, "tool_used", { tool: name, input });
      } catch (err: any) {
        toolResult = `Error: ${err.message}`;
        await logActivity(tenant.id, "tool_error", { tool: name, error: err.message });
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: toolResult,
      });
    }
  }

  return "No pude completar la acción. Intenta reformular.";
}
