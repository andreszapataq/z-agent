-- Permite anclar notas también a deals (no solo a contactos), espejando
-- el comportamiento de HubSpot (associationTypeId 214 = note↔deal).
-- Para el adapter Native, la columna contact_id deja de ser obligatoria;
-- una nota válida tiene contact_id o deal_id (o ambos).
alter table notes
  add column if not exists deal_id uuid references deals(id) on delete cascade;

alter table notes
  alter column contact_id drop not null;

create index if not exists idx_notes_deal on notes(deal_id);

alter table notes
  drop constraint if exists notes_anchor_required;

alter table notes
  add constraint notes_anchor_required
  check (contact_id is not null or deal_id is not null);
