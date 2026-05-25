-- HubSpot owner asignado a tareas creadas vía agente, para que HubSpot dispare los recordatorios al comercial.
alter table tenants
  add column if not exists hubspot_owner_id text;
