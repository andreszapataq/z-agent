-- Columnas obsoletas del flujo viejo de notificación con templates Meta.
-- El flujo actual no envía al cliente final, le avisa al comercial vía
-- WhatsApp libre + tarea HubSpot, sin templates ni costo.
alter table tenants
  drop column if exists proposal_template_name,
  drop column if exists proposal_template_lang;
