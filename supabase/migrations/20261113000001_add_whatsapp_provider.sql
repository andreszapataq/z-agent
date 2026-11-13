-- Canal de WhatsApp por tenant: Meta directo o Kapso (proxy compatible con Graph).
-- Con "kapso", whatsapp_token guarda la API key del proyecto de Kapso.
alter table public.tenants
  add column if not exists whatsapp_provider text not null default 'meta';

alter table public.tenants
  drop constraint if exists tenants_whatsapp_provider_check;
alter table public.tenants
  add constraint tenants_whatsapp_provider_check
  check (whatsapp_provider in ('meta', 'kapso'));
