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
      description: "Registra una nota de actividad sobre un contacto",
      parameters: {
        type: "object",
        properties: {
          contact_id: { type: "string" },
          note: { type: "string" },
        },
        required: ["contact_id", "note"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_task",
      description: "Crea una tarea o alerta de seguimiento",
      parameters: {
        type: "object",
        properties: {
          contact_id: { type: "string" },
          title: { type: "string" },
          due_date: {
            type: "string",
            description: "Fecha en formato YYYY-MM-DD",
          },
        },
        required: ["contact_id", "title", "due_date"],
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
  const dateContext = `\n\n📅 FECHA ACTUAL: ${todayInBogota} (zona horaria America/Bogota). Úsala como referencia obligatoria para los due_date de tareas: "el viernes" significa el próximo viernes a partir de esta fecha; "mañana" significa el día siguiente; etc.`;

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

  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        (tenant.system_prompt || `Eres el asistente de ventas de ${tenant.name}.`) +
        dateContext +
        stagesContext,
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
            toolResult = await crm.createNote(input.contact_id, input.note);
            break;
          case "create_task":
            toolResult = await crm.createTask(input.contact_id, input.title, input.due_date);
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
