-- Sync de correos con un template específico de HubSpot hacia la etapa
-- "propuesta" de un deal. Ver lib/hubspot-poll.ts → pollProposalEmails.
alter table tenants
  add column if not exists proposal_email_template_id text,
  add column if not exists last_email_polled_at timestamptz;
