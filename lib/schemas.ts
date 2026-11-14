import { z } from "zod";

const slugRegex = /^[a-z0-9][a-z0-9-_]{1,63}$/;

export const tenantCreateSchema = z.object({
  id: z.string().regex(slugRegex, "id debe ser slug minúsculas/números/guiones (2-64 chars)"),
  name: z.string().min(1).max(120),
  crm_type: z.enum(["hubspot", "native", "salesforce"]).default("native"),
  status: z.enum(["active", "paused"]).optional(),
  whatsapp_phone_id: z.string().max(64).nullable().optional(),
  whatsapp_token: z.string().max(2048).nullable().optional(),
  whatsapp_provider: z.enum(["meta", "kapso"]).optional(),
  owner_number: z
    .string()
    .regex(/^\d{8,16}$/, "owner_number debe ser dígitos en formato E.164 sin '+'")
    .nullable()
    .optional(),
  authorized_numbers: z
    .array(z.string().regex(/^\d{8,16}$/, "Cada número autorizado debe ser dígitos en formato E.164 sin '+'"))
    .max(10)
    .optional(),
  hubspot_token: z.string().max(2048).nullable().optional(),
  hubspot_owner_id: z
    .string()
    .regex(/^\d+$/, "hubspot_owner_id debe ser numérico (ID de HubSpot)")
    .max(32)
    .nullable()
    .optional(),
  system_prompt: z.string().max(20000).nullable().optional(),

  // Proposal notification config
  proposal_stage_id: z.string().max(64).nullable().optional(),
  proposal_email_template_id: z.string().max(64).nullable().optional(),

  // Mapeo de stages en español → stageId real del pipeline del tenant
  stage_map: z.record(z.string()).nullable().optional(),

  // Resumen diario de tareas pendientes via WhatsApp libre
  daily_digest_enabled: z.boolean().optional(),
});

export const tenantUpdateSchema = tenantCreateSchema.partial().extend({
  name: z.string().min(1).max(120).optional(),
});

export type TenantCreateInput = z.infer<typeof tenantCreateSchema>;
export type TenantUpdateInput = z.infer<typeof tenantUpdateSchema>;
