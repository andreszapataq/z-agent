import Anthropic from "@anthropic-ai/sdk";
import { Tenant } from "./tenants";
import { getCrmAdapter } from "./crm";
import { DealStage } from "./crm/types";
import { createAdminClient } from "./supabase";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_contact",
    description: "Busca un contacto en el CRM por nombre o empresa",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Nombre o empresa a buscar" },
      },
      required: ["query"],
    },
  },
  {
    name: "create_contact",
    description: "Crea un nuevo contacto en el CRM. Úsalo cuando el usuario mencione una persona/empresa que no existe aún.",
    input_schema: {
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
  {
    name: "search_deal",
    description: "Busca un negocio/deal en el CRM",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Nombre del negocio o empresa" },
      },
      required: ["query"],
    },
  },
  {
    name: "move_deal",
    description: "Mueve un negocio a una etapa del pipeline",
    input_schema: {
      type: "object",
      properties: {
        deal_id: { type: "string" },
        stage: {
          type: "string",
          enum: ["saludo", "presentación", "propuesta", "cierre", "perdido"],
        },
      },
      required: ["deal_id", "stage"],
    },
  },
  {
    name: "create_note",
    description: "Registra una nota de actividad sobre un contacto",
    input_schema: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        note: { type: "string" },
      },
      required: ["contact_id", "note"],
    },
  },
  {
    name: "create_task",
    description: "Crea una tarea o alerta de seguimiento",
    input_schema: {
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
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userMessage }];

  await logActivity(tenant.id, "message_received", { text: userMessage });

  // Loop del agente: usa tools hasta llegar a una respuesta final
  for (let i = 0; i < 10; i++) {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: tenant.system_prompt || `Eres el asistente de ventas de ${tenant.name}.`,
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find((b) => b.type === "text") as
        | Anthropic.TextBlock
        | undefined;
      return textBlock?.text || "Listo.";
    }

    if (response.stop_reason === "tool_use") {
      const toolUse = response.content.find(
        (b) => b.type === "tool_use"
      ) as Anthropic.ToolUseBlock;

      let toolResult = "";
      try {
        const i: any = toolUse.input;
        switch (toolUse.name) {
          case "search_contact":
            toolResult = JSON.stringify(await crm.searchContact(i.query));
            break;
          case "create_contact":
            toolResult = JSON.stringify(await crm.createContact(i));
            break;
          case "search_deal":
            toolResult = JSON.stringify(await crm.searchDeal(i.query));
            break;
          case "move_deal":
            toolResult = await crm.moveDeal(i.deal_id, i.stage as DealStage);
            break;
          case "create_note":
            toolResult = await crm.createNote(i.contact_id, i.note);
            break;
          case "create_task":
            toolResult = await crm.createTask(i.contact_id, i.title, i.due_date);
            break;
          default:
            toolResult = `Tool desconocido: ${toolUse.name}`;
        }
        await logActivity(tenant.id, "tool_used", {
          tool: toolUse.name,
          input: toolUse.input,
        });
      } catch (err: any) {
        toolResult = `Error: ${err.message}`;
        await logActivity(tenant.id, "tool_error", {
          tool: toolUse.name,
          error: err.message,
        });
      }

      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: toolResult,
          },
        ],
      });
    } else {
      break;
    }
  }

  return "No pude completar la acción. Intenta reformular.";
}
