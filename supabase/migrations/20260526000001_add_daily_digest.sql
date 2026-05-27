-- Daily digest: cuando está activo, el cron diario manda al owner_number un
-- resumen de tareas vencidas + hoy + esta semana. Por tenant, opt-in.
alter table tenants
  add column if not exists daily_digest_enabled boolean not null default false;
