-- Números adicionales que pueden hablar con el agente de un tenant, además del
-- owner_number (que sigue siendo el principal y el único que recibe el resumen
-- diario). Formato E.164 sin "+", p.ej. '573001234567'.
alter table public.tenants
  add column if not exists authorized_numbers text[] not null default '{}';
