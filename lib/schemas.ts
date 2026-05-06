import { z } from "zod";

const slugRegex = /^[a-z0-9][a-z0-9-_]{1,63}$/;

export const tenantCreateSchema = z.object({
  id: z.string().regex(slugRegex, "id debe ser slug minúsculas/números/guiones (2-64 chars)"),
  name: z.string().min(1).max(120),
  crm_type: z.enum(["hubspot", "native", "salesforce"]).default("native"),
  status: z.enum(["active", "paused"]).optional(),
  whatsapp_phone_id: z.string().max(64).nullable().optional(),
  whatsapp_token: z.string().max(2048).nullable().optional(),
  owner_number: z
    .string()
    .regex(/^\d{8,16}$/, "owner_number debe ser dígitos en formato E.164 sin '+'")
    .nullable()
    .optional(),
  hubspot_token: z.string().max(2048).nullable().optional(),
  system_prompt: z.string().max(8000).nullable().optional(),

  // Proposal notification config
  proposal_stage_id: z.string().max(64).nullable().optional(),
  proposal_template_name: z.string().max(128).nullable().optional(),
  proposal_template_lang: z.string().max(10).nullable().optional(),

  // Mapeo de stages en español → stageId real del pipeline del tenant
  stage_map: z.record(z.string()).nullable().optional(),
});

export const tenantUpdateSchema = tenantCreateSchema.partial().extend({
  name: z.string().min(1).max(120).optional(),
});

export type TenantCreateInput = z.infer<typeof tenantCreateSchema>;
export type TenantUpdateInput = z.infer<typeof tenantUpdateSchema>;
