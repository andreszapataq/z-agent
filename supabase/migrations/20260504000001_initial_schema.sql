-- ============================================================
-- Z-Agent · Initial schema migration (versionada)
-- Multi-tenant WhatsApp AI Agent with multi-CRM support
-- ============================================================
-- Aplicar con Supabase CLI:  supabase db push
-- O manualmente en SQL Editor de Supabase.
-- ============================================================

-- ─── TENANTS ──────────────────────────────────────────────
create table if not exists tenants (
  id text primary key,
  name text not null,
  crm_type text not null default 'native',
  status text not null default 'active',

  whatsapp_phone_id text,
  whatsapp_token text,
  owner_number text,

  hubspot_token text,

  system_prompt text,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ─── CONTACTS ─────────────────────────────────────────────
create table if not exists contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text references tenants(id) on delete cascade,

  full_name text not null,
  company text,
  email text,
  phone text,
  position text,

  source text default 'whatsapp',

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_contacts_tenant on contacts(tenant_id);
create index if not exists idx_contacts_company on contacts(tenant_id, company);

-- ─── DEALS ────────────────────────────────────────────────
create table if not exists deals (
  id uuid primary key default gen_random_uuid(),
  tenant_id text references tenants(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,

  name text not null,
  stage text not null default 'saludo',
  amount numeric(12, 2),
  expected_close_date date,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_deals_tenant on deals(tenant_id);
create index if not exists idx_deals_stage on deals(tenant_id, stage);

-- ─── NOTES ────────────────────────────────────────────────
create table if not exists notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id text references tenants(id) on delete cascade,
  contact_id uuid references contacts(id) on delete cascade,

  body text not null,

  created_at timestamptz default now()
);
create index if not exists idx_notes_tenant on notes(tenant_id);
create index if not exists idx_notes_contact on notes(contact_id);

-- ─── TASKS ────────────────────────────────────────────────
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id text references tenants(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,

  title text not null,
  description text,
  due_date date,
  status text default 'pending',

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_tasks_tenant on tasks(tenant_id);
create index if not exists idx_tasks_due on tasks(tenant_id, due_date) where status = 'pending';

-- ─── ACTIVITY LOG ─────────────────────────────────────────
create table if not exists activity_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id text references tenants(id) on delete cascade,

  action text not null,
  details jsonb,

  created_at timestamptz default now()
);
create index if not exists idx_activity_tenant on activity_log(tenant_id, created_at desc);

-- ─── ROW LEVEL SECURITY ───────────────────────────────────
alter table tenants enable row level security;
alter table contacts enable row level security;
alter table deals enable row level security;
alter table notes enable row level security;
alter table tasks enable row level security;
alter table activity_log enable row level security;

-- ─── TRIGGER: updated_at automático ───────────────────────
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists tenants_updated_at on tenants;
create trigger tenants_updated_at before update on tenants
  for each row execute function update_updated_at();

drop trigger if exists contacts_updated_at on contacts;
create trigger contacts_updated_at before update on contacts
  for each row execute function update_updated_at();

drop trigger if exists deals_updated_at on deals;
create trigger deals_updated_at before update on deals
  for each row execute function update_updated_at();

drop trigger if exists tasks_updated_at on tasks;
create trigger tasks_updated_at before update on tasks
  for each row execute function update_updated_at();
