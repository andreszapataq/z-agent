-- ============================================================
-- Z-Agent · Supabase schema
-- Multi-tenant WhatsApp AI Agent with multi-CRM support
-- ============================================================

-- ─── TENANTS ──────────────────────────────────────────────
-- Cada cliente del sistema. Define qué CRM usa y sus credenciales.
create table tenants (
  id text primary key,                    -- "qna-medical", "clinica-norte"
  name text not null,
  crm_type text not null default 'native', -- 'hubspot' | 'native' | 'salesforce' (future)
  status text not null default 'active',   -- 'active' | 'paused'
  
  -- WhatsApp / Meta credentials
  whatsapp_phone_id text,
  whatsapp_token text,
  owner_number text,                      -- Solo este número puede usar el agente
  
  -- HubSpot (solo si crm_type = 'hubspot')
  hubspot_token text,
  
  -- Agent configuration
  system_prompt text,
  
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ─── CONTACTS (CRM nativo) ────────────────────────────────
-- Solo se usa cuando crm_type = 'native'.
create table contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text references tenants(id) on delete cascade,
  
  full_name text not null,
  company text,
  email text,
  phone text,
  position text,
  
  -- Origen del contacto
  source text default 'whatsapp',         -- 'whatsapp' | 'manual' | 'import'
  
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index idx_contacts_tenant on contacts(tenant_id);
create index idx_contacts_company on contacts(tenant_id, company);

-- ─── DEALS (CRM nativo) ───────────────────────────────────
create table deals (
  id uuid primary key default gen_random_uuid(),
  tenant_id text references tenants(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  
  name text not null,
  stage text not null default 'saludo',   -- saludo | presentación | propuesta | cierre | perdido
  amount numeric(12, 2),
  expected_close_date date,
  
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index idx_deals_tenant on deals(tenant_id);
create index idx_deals_stage on deals(tenant_id, stage);

-- ─── NOTES ────────────────────────────────────────────────
-- Notas de actividad. Se asocian a contactos.
create table notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id text references tenants(id) on delete cascade,
  contact_id uuid references contacts(id) on delete cascade,
  
  body text not null,
  
  created_at timestamptz default now()
);
create index idx_notes_tenant on notes(tenant_id);
create index idx_notes_contact on notes(contact_id);

-- ─── TASKS ────────────────────────────────────────────────
create table tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id text references tenants(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  
  title text not null,
  description text,
  due_date date,
  status text default 'pending',          -- 'pending' | 'completed'
  
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index idx_tasks_tenant on tasks(tenant_id);
create index idx_tasks_due on tasks(tenant_id, due_date) where status = 'pending';

-- ─── ACTIVITY LOG ─────────────────────────────────────────
-- Cada acción del agente queda registrada para auditoría.
create table activity_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id text references tenants(id) on delete cascade,
  
  action text not null,                   -- 'message_received' | 'tool_used' | 'crm_action'
  details jsonb,
  
  created_at timestamptz default now()
);
create index idx_activity_tenant on activity_log(tenant_id, created_at desc);

-- ─── ROW LEVEL SECURITY ───────────────────────────────────
-- Por ahora, el panel admin usa el service_role key.
-- Cuando agregues auth multi-usuario, activa RLS en todas las tablas.

alter table tenants enable row level security;
alter table contacts enable row level security;
alter table deals enable row level security;
alter table notes enable row level security;
alter table tasks enable row level security;
alter table activity_log enable row level security;

-- Política temporal: todo bloqueado al anon, todo permitido al service_role
-- (el service_role bypass-ea RLS automáticamente, así que no se necesita policy)

-- ─── TRIGGER: updated_at automático ───────────────────────
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger tenants_updated_at before update on tenants
  for each row execute function update_updated_at();
create trigger contacts_updated_at before update on contacts
  for each row execute function update_updated_at();
create trigger deals_updated_at before update on deals
  for each row execute function update_updated_at();
create trigger tasks_updated_at before update on tasks
  for each row execute function update_updated_at();
