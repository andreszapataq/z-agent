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

Z-Agent is a **multi-tenant WhatsApp AI agent** that connects Meta WhatsApp Business API to CRMs. Each tenant (client company) has its own WhatsApp credentials, CRM type, and OpenAI system prompt.

### Message flow

```
WhatsApp user → Meta API → POST /api/webhook
  → getTenantByPhone()        (match phone_number_id to tenant)
  → processMessage()          (OpenAI agent loop in lib/agent.ts)
  → CrmAdapter methods        (HubSpot or native Supabase)
  → sendWhatsAppMessage()     (reply back via Meta API)
```

The webhook responds 200 immediately and processes async (`processIncomingMessage` is fire-and-forget). Only messages from `tenant.owner_number` are processed — one authorized phone per tenant.

### Agent loop (`lib/agent.ts`)

Runs up to 10 OpenAI iterations using `openai.chat.completions.create` with `tools`. Each iteration either returns a final text response (no `tool_calls`) or executes one or more tool calls. Tool results are pushed to the messages array as `role: "tool"` and fed back. The model defaults to `gpt-4.1-mini` (override via `OPENAI_MODEL`). No conversation history is persisted — each WhatsApp message starts a fresh context. All iterations are logged to the `activity_log` table.

### CRM adapter pattern (`lib/crm/`)

`CrmAdapter` interface in `types.ts` defines 8 action methods: `searchContact`, `createContact`, `searchDeal`, `createDeal`, `moveDeal`, `createNote`, `createTask`, `listTasks` (plus `listStages` for pipeline labels). Two implementations exist:

- **`HubSpotAdapter`** — calls HubSpot CRM v3 API with the tenant's `hubspot_token`. Stage names are resolved via per-tenant `tenant.stage_map` (Spanish → real HubSpot stageIds for that tenant's pipeline). Falls back to `DEFAULT_HUBSPOT_STAGE_MAP` (default HubSpot pipeline) if the tenant hasn't configured a map.
- **`NativeAdapter`** — reads/writes directly to Supabase tables (`contacts`, `deals`, `notes`, `tasks`) scoped by `tenant_id`.

`lib/crm/index.ts` is the factory — `getCrmAdapter(tenant)` returns the right implementation. To add Salesforce or any new CRM: implement `CrmAdapter`, add the case in `index.ts`.

### Multi-tenancy

Tenants live in the `tenants` Supabase table (text primary key, e.g. `"qna-medical"`). Each tenant row holds its own WhatsApp credentials, CRM type, HubSpot token (if applicable), and system prompt. `lib/tenants.ts` exposes CRUD helpers. The admin panel at `/admin` manages tenants via the REST API at `/api/admin/tenants`. Bodies are validated with Zod (`lib/schemas.ts`).

### Auth (admin panel)

Single shared secret stored in `ADMIN_SECRET`. The login page POSTs to `/api/admin/auth`; on success the server sets an **HttpOnly, SameSite=Lax, Secure (in prod) cookie** named `z-admin-session` containing a SHA-256 hash of the secret (12h TTL). All admin endpoints check the cookie via `isAuthenticated()` in `lib/admin-auth.ts` (uses `crypto.timingSafeEqual`). Logout posts to `/api/admin/logout` which clears the cookie. No JWT, no DB sessions.

### Proposal notification (proactive WhatsApp)

When a HubSpot deal enters a configured "proposal sent" stage, the system sends a pre-approved WhatsApp template message to the deal's contact phone — without manual intervention by the commercial.

- **Trigger**: Vercel Cron hits `/api/cron/check-deals` once per day at 14:00 UTC (Hobby plan limit; pipeline business rule is "notify the day after the proposal", so daily fits the requirement).
- **Polling logic**: `lib/hubspot-poll.ts` queries each active HubSpot tenant's deals via `POST /crm/v3/objects/deals/search` filtered by `dealstage = tenant.proposal_stage_id` AND `hs_date_entered_<stageId> >= last_polled_at`.
- **Dedup**: before sending, queries `activity_log` for `action = 'proposal_notified'` matching the `deal_id` — if found, skip.
- **Template**: `sendWhatsAppTemplate()` in `lib/whatsapp.ts` calls Meta's template API with `tenant.proposal_template_name` and `proposal_template_lang`. Variables passed: `{{1}}` = contact firstname, `{{2}}` = deal name.
- **Auth**: cron endpoint requires `Authorization: Bearer <CRON_SECRET>`. Vercel Cron sends this automatically when `CRON_SECRET` env var is set.
- **Required tenant config**: `proposal_stage_id`, `proposal_template_name`, plus the standard HubSpot/WhatsApp credentials. If any are missing, the tenant is skipped silently.

The Meta WhatsApp template **must be pre-approved** by Meta (24-48h human review). Each tenant approves their own template.

### Rate limiting (`lib/ratelimit.ts`)

Uses `@upstash/ratelimit` + `@upstash/redis`. Two limiters:
- `webhookLimiter` — 60 msg/min keyed by `phone_number_id`.
- `adminAuthLimiter` — 5 attempts/5min keyed by client IP (anti brute-force).

If `UPSTASH_REDIS_REST_URL`/`_TOKEN` are not set, `checkLimit` fails-open (dev convenience). **In production these MUST be configured.**

### Supabase client

`lib/supabase.ts` exports only `createAdminClient()` — uses the `SUPABASE_SERVICE_ROLE_KEY` which bypasses RLS. This is intentional: all server-side operations run as admin. RLS is enabled on all tables but no row-level policies are defined yet (service_role bypasses automatically).

### Database migrations

The source of truth for schema is `supabase/migrations/` (versioned). `supabase/schema.sql` is a snapshot kept for reference. New schema changes go in a new timestamped migration file.

## Environment variables

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key (used by client SDK init in some contexts) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (bypasses RLS) |
| `OPENAI_API_KEY` | OpenAI API key |
| `OPENAI_MODEL` | (optional) Override model name. Default: `gpt-4.1-mini` |
| `WEBHOOK_VERIFY_TOKEN` | Token Meta uses to verify the webhook on setup |
| `META_APP_SECRET` | Meta App Secret — used to verify HMAC signature on incoming webhook POSTs |
| `ADMIN_SECRET` | Shared password for the admin panel |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL (rate limiting) |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token |
| `CRON_SECRET` | Bearer token Vercel Cron sends to `/api/cron/check-deals` |

## Key constraints

- **WhatsApp API version**: pinned via `GRAPH_API_VERSION` constant in `lib/whatsapp.ts` (currently `v22.0`) — bump when upgrading the Meta API version.
- **Webhook signature**: incoming POSTs to `/api/webhook` are verified against `META_APP_SECRET` using HMAC-SHA256 (`verifyMetaSignature` in `lib/whatsapp.ts`). Requests without a valid `x-hub-signature-256` header return 403.
- **Agent tool set**: tools are defined statically in `TOOLS` array in `lib/agent.ts`. Adding a new CRM action requires adding both a tool definition there and a case in the switch.
- **No conversation memory**: each incoming WhatsApp message is a standalone context; the agent has no memory of prior messages in the same conversation.
- **`maxDuration = 60`** on the webhook route — if the agent loop takes longer (e.g. many tool calls), Vercel will cut it off. Admin endpoints have `maxDuration = 30`.
- **Security headers** are applied globally via `next.config.js` (X-Frame-Options DENY, HSTS, nosniff, restrictive Permissions-Policy).
