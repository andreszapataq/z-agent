-- ============================================================
-- Z-Agent · Proposal notification feature
-- Polling de HubSpot para notificar al cliente vía WhatsApp
-- cuando un deal entra a la etapa "propuesta enviada".
-- ============================================================

alter table tenants add column if not exists proposal_stage_id text;
alter table tenants add column if not exists proposal_template_name text;
alter table tenants add column if not exists proposal_template_lang text default 'es';
alter table tenants add column if not exists last_polled_at timestamptz;

-- Mapeo de etapas en español (las del enum del agente) → stageId real del pipeline
-- de cada tenant en HubSpot. Si está null, se usan los stages default de HubSpot.
-- Ej: {"saludo":"123","presentación":"124","propuesta":"125","cierre":"126","perdido":"127"}
alter table tenants add column if not exists stage_map jsonb;

-- Índice para deduplicar notificaciones consultando activity_log por deal_id
create index if not exists idx_activity_proposal_notified
  on activity_log(tenant_id, action, created_at desc)
  where action = 'proposal_notified';
