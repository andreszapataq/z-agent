-- ─── CONVERSATION MEMORY ──────────────────────────────────
-- Cada mensaje entrante de WhatsApp era un contexto aislado: el agente
-- no recordaba el turno anterior, así que confirmaciones como "Sí" o
-- "marcala como completada" nunca podían actuar sobre la tarea que el
-- agente había encontrado en el mensaje previo. Esta tabla guarda los
-- turnos textuales (user/assistant) por conversación (tenant + teléfono)
-- para reinyectarlos en `processMessage`.
create table if not exists conversation_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id text references tenants(id) on delete cascade,

  -- Teléfono del interlocutor (owner_number del tenant). Identifica la
  -- conversación junto con tenant_id.
  phone text not null,

  role text not null check (role in ('user', 'assistant')),
  content text not null,

  created_at timestamptz default now()
);

-- Para cargar el historial reciente de una conversación rápido.
create index if not exists idx_conversation_tenant_phone
  on conversation_messages(tenant_id, phone, created_at desc);

alter table conversation_messages enable row level security;
