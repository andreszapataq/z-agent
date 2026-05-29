import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { Tenant } from "./tenants";
import { getCrmAdapter } from "./crm";
import { DealStage } from "./crm/types";
import { createAdminClient } from "./supabase";
import { loadConversationHistory, saveConversationTurn, TaskRef } from "./conversation";

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
          priority: {
            type: "string",
            enum: ["baja", "media", "alta"],
            description: "Prioridad de la tarea. OMÍTELA por defecto (el sistema usa 'media'). SOLO pásala si el usuario indica EXPLÍCITAMENTE la urgencia ('prioridad alta', 'urgente', 'esto corre', 'baja prioridad', 'cuando puedas'). NO la infieras del tono ni del contexto por tu cuenta.",
          },
        },
        required: ["title", "due_date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_task",
      description:
        "Marca una tarea existente como completada en el CRM. Úsalo cuando el usuario diga que ya hizo algo ('ya llamé a Juan', 'mandé la cotización', 'reunión hecha'). FLUJO OBLIGATORIO: primero llama `list_tasks` (rango razonable: hoy ± unos días) para encontrar la tarea que matchea. Si hay varias candidatas, pregunta al usuario cuál antes de marcar. Solo llama esto con el task_id exacto que devolvió list_tasks.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "ID de la tarea (campo `id` devuelto por list_tasks)" },
        },
        required: ["task_id"],
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

export async function processMessage(
  userMessage: string,
  tenant: Tenant,
  phone?: string
): Promise<string> {
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

  const completeTaskContext =
    `\n\n☑️ REGLA DE COMPLETAR TAREAS: cuando el usuario diga que ya hizo algo ("ya llamé", "mandé la cotización", "reunión hecha", "listo lo del cliente X"):
1. Llama \`list_tasks\` para localizar la tarea. Usa por defecto un rango amplio (from_date = fecha actual − 30 días, to_date = fecha actual + 30 días) para cubrir tareas VENCIDAS y también futuras (el usuario pudo adelantarse). Solo restringe el rango si el usuario dio una pista temporal clara.
2. Si encuentras UNA sola tarea que matchea claramente con lo que dijo el usuario, llama \`complete_task\` directo.
3. Si hay varias candidatas, pregunta al usuario cuál antes de marcar. NO marques múltiples a la ciegas.
4. Si no encuentras nada, dilo y ofrece registrar la actividad como nota (\`create_note\` con el contacto/deal correspondiente).
5. Después de marcar una tarea como completada, cierra con UNA sola pregunta: si quiere crear un seguimiento ("¿Te creo un seguimiento? ¿Para cuándo?"). Esta es tu pregunta de cierre — reemplaza el "¿algo más?" genérico; no encadenes dos preguntas de cierre seguidas. Si la conversación da pistas claras (ej. "el cliente pidió revisar la propuesta en 3 días"), sugiere una fecha concreta. NO crees el seguimiento sin confirmación del usuario.

⚠️ task_id OBLIGATORIO Y REAL: el \`task_id\` que pasas a \`complete_task\` SIEMPRE debe venir del campo \`id\` que devolvió \`list_tasks\`, o de la sección "TAREAS QUE YA LE MOSTRASTE AL USUARIO" del system prompt. NUNCA inventes, adivines ni uses un id placeholder como "1", "task1", etc. Si pediste confirmación en un turno anterior y el usuario ahora dice "sí"/"confírmalo"/"hazlo": usa el task_id de la sección "TAREAS QUE YA LE MOSTRASTE" si está ahí; si no está, llama \`list_tasks\` de nuevo para reobtenerlo ANTES de completar. Jamás llames \`complete_task\` sin un id real.`;

  const listTasksContext =
    `\n\n📋 REGLA DE LISTAR TAREAS: cuando el usuario pida ver sus tareas ("mis tareas de hoy", "qué tengo mañana", "tareas del viernes", "tareas de la semana"), usa \`list_tasks\`. Resuelve TODAS las fechas relativas con las reglas de la sección 📅 FECHA ACTUAL (es la fuente única para "mañana", "el viernes", "el próximo lunes", etc.; no las redefinas aquí). Según lo que pida, elige el rango:
- "hoy" → from_date = to_date = fecha actual.
- "mañana" → from_date = to_date = el día siguiente.
- "esta semana" → from_date = fecha actual, to_date = el próximo domingo (inclusive). Si hoy YA es domingo, esto deja solo hoy: muéstralo y ofrece revisar la próxima semana.
- "la próxima semana" → from_date = el próximo lunes, to_date = el domingo siguiente.

IMPORTANTE — "pendiente" NO significa "de hoy". Una tarea pendiente es cualquiera no completada, sin importar su fecha (incluidas las VENCIDAS de días pasados). Cuando el usuario pida sus tareas SIN indicar un día concreto — "tareas pendientes", "mis tareas", "qué tengo pendiente", "todas las tareas", "qué tengo por hacer" — NO limites el rango a hoy. Usa un rango amplio: from_date = fecha actual − 30 días, to_date = fecha actual + 30 días. Así capturas vencidas + hoy + próximas. Solo restringe el rango cuando el usuario nombre un día/periodo específico.

Al responder, agrupa las tareas por estado temporal y preséntalas en este orden: primero las VENCIDAS (fecha anterior a hoy), luego las de HOY, luego las PRÓXIMAS (fecha futura). Muestra cada tarea con título, fecha (y hora si la hay) y el deal/contacto asociado. Si no hay tareas en el rango, dilo claramente.`;

  // Historial reciente de la conversación (turnos user/assistant) para que
  // el agente pueda actuar sobre confirmaciones y referencias del mensaje
  // anterior ("Sí", "marcala como completada"). Vacío si no hay phone.
  const { messages: history, recentTasks } = phone
    ? await loadConversationHistory(tenant.id, phone)
    : { messages: [], recentTasks: [] };

  // Inyectamos los task_id REALES de las tareas que el agente le mostró al
  // usuario en turnos previos. Sin esto, en la confirmación ("Sí") el modelo
  // no tiene el id y termina inventándolo (p.ej. "1"), lo que rompe
  // complete_task. Con esto completa de forma determinista.
  let recentTasksContext = "";
  if (recentTasks.length > 0) {
    const lines = recentTasks
      .map((t) => {
        const extra = [t.dealName && `deal: ${t.dealName}`, t.contactName && `contacto: ${t.contactName}`]
          .filter(Boolean)
          .join(" | ");
        return `- task_id=${t.id} | "${t.title}" | vence ${t.dueDate}${t.status ? ` | estado ${t.status}` : ""}${extra ? ` | ${extra}` : ""}`;
      })
      .join("\n");
    recentTasksContext = `\n\n📌 TAREAS QUE YA LE MOSTRASTE AL USUARIO EN ESTA CONVERSACIÓN (usa el task_id EXACTO de esta lista para complete_task; NUNCA inventes un id como "1"):\n${lines}`;
  }

  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        (tenant.system_prompt || `Eres el asistente de ventas de ${tenant.name}.`) +
        dateContext +
        stagesContext +
        notesContext +
        tasksContext +
        listTasksContext +
        completeTaskContext +
        recentTasksContext,
    },
    ...history,
    { role: "user", content: userMessage },
  ];

  await logActivity(tenant.id, "message_received", { text: userMessage });
  if (phone) await saveConversationTurn(tenant.id, phone, "user", userMessage);

  // Acumulamos las tareas que el agente liste durante este loop para
  // persistirlas como metadata del turno (sus task_id reales viajan al
  // siguiente mensaje de la conversación).
  let listedTasks: TaskRef[] = [];

  // Persistimos la respuesta final del agente antes de devolverla, para que
  // el siguiente mensaje de la conversación la tenga como contexto.
  const finish = async (reply: string): Promise<string> => {
    if (phone) {
      await saveConversationTurn(
        tenant.id,
        phone,
        "assistant",
        reply,
        listedTasks.length > 0 ? { tasks: listedTasks } : undefined
      );
    }
    return reply;
  };

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
      return finish(message.content || "Listo.");
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
              priority: input.priority,
            });
            break;
          case "complete_task":
            toolResult = await crm.completeTask(input.task_id);
            break;
          case "list_tasks": {
            const tasks = await crm.listTasks({
              fromDate: input.from_date,
              toDate: input.to_date,
              includeCompleted: input.include_completed === true,
            });
            // Guardamos los task_id reales para el contexto del próximo turno.
            // Cap a 15 para no inflar el contexto si el usuario lista muchas.
            listedTasks = tasks.slice(0, 15).map((t) => ({
              id: t.id,
              title: t.title,
              dueDate: t.dueDate,
              status: t.status,
              dealName: t.dealName,
              contactName: t.contactName,
            }));
            toolResult = JSON.stringify(tasks);
            break;
          }
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

  return finish("No pude completar la acción. Intenta reformular.");
}
