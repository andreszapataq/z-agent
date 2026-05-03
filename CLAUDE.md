# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start dev server (http://localhost:3000 → redirects to /admin)
npm run build    # Production build
npm run start    # Run production build locally
npm run lint     # ESLint
```

There are no tests in this project.

## Architecture

Z-Agent is a **multi-tenant WhatsApp AI agent** that connects Meta WhatsApp Business API to CRMs. Each tenant (client company) has its own WhatsApp credentials, CRM type, and Claude system prompt.

### Message flow

```
WhatsApp user → Meta API → POST /api/webhook
  → getTenantByPhone()        (match phone_number_id to tenant)
  → processMessage()          (Claude agent loop in lib/agent.ts)
  → CrmAdapter methods        (HubSpot or native Supabase)
  → sendWhatsAppMessage()     (reply back via Meta API)
```

The webhook responds 200 immediately and processes async (`processIncomingMessage` is fire-and-forget). Only messages from `tenant.owner_number` are processed — one authorized phone per tenant.

### Agent loop (`lib/agent.ts`)

Runs up to 10 Claude iterations. Each iteration either returns a final text response (`end_turn`) or executes a tool (`tool_use`). Tool results are appended to the message array and fed back to Claude. No conversation history is persisted — each WhatsApp message starts a fresh context. All iterations are logged to the `activity_log` table.

### CRM adapter pattern (`lib/crm/`)

`CrmAdapter` interface in `types.ts` defines 6 methods: `searchContact`, `createContact`, `searchDeal`, `moveDeal`, `createNote`, `createTask`. Two implementations exist:

- **`HubSpotAdapter`** — calls HubSpot CRM v3 API with the tenant's `hubspot_token`. Stage names are mapped via `HUBSPOT_STAGE_MAP` (Spanish → HubSpot internal IDs).
- **`NativeAdapter`** — reads/writes directly to Supabase tables (`contacts`, `deals`, `notes`, `tasks`) scoped by `tenant_id`.

`lib/crm/index.ts` is the factory — `getCrmAdapter(tenant)` returns the right implementation. To add Salesforce or any new CRM: implement `CrmAdapter`, add the case in `index.ts`.

### Multi-tenancy

Tenants live in the `tenants` Supabase table (text primary key, e.g. `"qna-medical"`). Each tenant row holds its own WhatsApp credentials, CRM type, HubSpot token (if applicable), and system prompt. `lib/tenants.ts` exposes CRUD helpers. The admin panel at `/admin` manages tenants via the REST API at `/api/admin/tenants`.

### Auth (admin panel)

Single shared secret stored in `ADMIN_SECRET` env var. The login page (`/admin/login`) POSTs to `/api/admin/auth`, which checks the secret and returns 200/401. On success the secret is stored in `sessionStorage` and sent as the `x-admin-secret` header on all subsequent admin API calls. Not JWT-based — no expiry.

### Supabase client

`lib/supabase.ts` exports only `createAdminClient()` — uses the `SUPABASE_SERVICE_ROLE_KEY` which bypasses RLS. This is intentional: all server-side operations run as admin. RLS is enabled on all tables but no row-level policies are defined yet (service_role bypasses automatically).

## Environment variables

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (bypasses RLS) |
| `ANTHROPIC_API_KEY` | Claude API key |
| `WEBHOOK_VERIFY_TOKEN` | Token Meta uses to verify the webhook on setup |
| `META_APP_SECRET` | Meta App Secret — used to verify HMAC signature on incoming webhook POSTs |
| `ADMIN_SECRET` | Shared password for the admin panel |

## Key constraints

- **WhatsApp API version**: pinned via `GRAPH_API_VERSION` constant in `lib/whatsapp.ts` (currently `v22.0`) — bump when upgrading the Meta API version.
- **Webhook signature**: incoming POSTs to `/api/webhook` are verified against `META_APP_SECRET` using HMAC-SHA256 (`verifyMetaSignature` in `lib/whatsapp.ts`). Requests without a valid `x-hub-signature-256` header return 403.
- **Agent tool set**: tools are defined statically in `TOOLS` array in `lib/agent.ts`. Adding a new CRM action requires adding both a tool definition there and a case in the switch.
- **`create_deal` is missing**: the agent can search and move deals but cannot create them. This is a known gap.
- **No conversation memory**: each incoming WhatsApp message is a standalone context; the agent has no memory of prior messages in the same conversation.
- **`maxDuration = 60`** on the webhook route — if the agent loop takes longer (e.g. many tool calls), Vercel will cut it off.
