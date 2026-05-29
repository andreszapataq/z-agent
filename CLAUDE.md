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

Runs up to 10 OpenAI iterations using `openai.chat.completions.create` with `tools`. Each iteration either returns a final text response (no `tool_calls`) or executes one or more tool calls. Tool results are pushed to the messages array as `role: "tool"` and fed back. The model defaults to `gpt-4.1-mini` (override via `OPENAI_MODEL`). Recent conversation turns are reinjected (see [Conversation memory](#conversation-memory-libconversationts)). All iterations are logged to the `activity_log` table.

### Where the agent's instructions live (and when to touch each)

The system prompt the model sees is assembled in `processMessage` from **three layers**. Knowing which layer to edit is the difference between a one-line fix and chasing the same bug twice.

| Layer | What it is | Lives in | Needs deploy? | Scope |
|---|---|---|---|---|
| **1. Logic / tools** | `TOOLS` array, the tool-dispatch `switch`, the CRM adapters. The ground truth of what the agent *can* do and how it actually behaves. | Code (repo) | Yes | All tenants |
| **2. Code prompt blocks** | `dateContext`, `stagesContext`, `notesContext`, `tasksContext`, `listTasksContext`, `completeTaskContext`, `recentTasksContext` — concatenated onto the system prompt. Shared guidance on *how to use* the tools. | Code (`lib/agent.ts`) | Yes | All tenants |
| **3. `tenant.system_prompt`** | Persona, business context, tone, per-client policy. Prepended as the first block. | **Supabase `tenants` table** | **No** — effect is immediate | One tenant |

Mental model: **code = what the agent CAN do; prompt = what it SHOULD do.** A behavior bug can live in either, or in a *mismatch* between them.

Decision heuristic when adjusting behavior:

1. **Is the desired behavior even possible with current code/tools/data?** If not → code change (layer 1), usually plus a layer-2 block telling the model how to use the new capability. (Example: conversation memory — no prompt wording can create memory the code doesn't pass in.)
2. **Possible, but the agent does the wrong thing** → it's a prompt issue. Cross-tenant? → layer 2. Specific to one client (business/tone/policy)? → layer 3. (Example: "pendiente ≠ hoy" was a pure layer-2 fix; adding the `negociación` stage description was a layer-3 fix.)
3. **After ANY code change, scan all prompt layers for statements that now contradict what the code does.** This step is easy to skip and bites hard: when conversation memory was added (code), `tenant.system_prompt` still said *"cada mensaje llega sin memoria… pide que repita el contacto"* — the stale prompt actively sabotaged the new capability until it was rewritten.

⚠️ **Process caveat**: layer 3 lives only in the DB, not in git — fast to change (no deploy, per-client) but **unversioned**, no review, and prone to silently drifting from code reality. When editing a `tenant.system_prompt`, consider whether it should also be captured somewhere reviewable; as more tenants onboard, versioning/seeding tenant prompts becomes worthwhile.

### Conversation memory (`lib/conversation.ts`)

Each incoming WhatsApp message used to start a fresh OpenAI context, which broke any multi-turn flow: when the agent asked "¿Confirmas que marque la tarea?" and the user replied "Sí", the next message had no idea which task — and the model would hallucinate a `task_id` (e.g. `"1"`), causing a 404 on `complete_task`.

Now `processMessage(userMessage, tenant, phone)` loads and reinjects recent turns:

- **Storage**: `conversation_messages` table (`tenant_id`, `phone`, `role`, `content`, `metadata jsonb`), keyed by tenant + the interlocutor's phone (the owner's number). Only the **textual** user/assistant turns are stored — not the intermediate `tool_calls`/`tool` messages.
- **Window**: last 12 messages within the last 6h (`HISTORY_WINDOW_MINUTES` / `HISTORY_MAX_MESSAGES` in `lib/conversation.ts`). Reinjected between the system prompt and the current user message.
- **Real task IDs**: textual turns alone don't carry the `task_id`, so a confirmation turn ("Sí") had no real ID to act on. When the agent runs `list_tasks`, the loop captures the returned tasks (id/title/dueDate/status/deal/contact, capped at 15) and persists them in `metadata.tasks` on that turn's assistant message. On the next turn, `loadConversationHistory` returns these as `recentTasks`, which are injected into the system prompt ("📌 TAREAS QUE YA LE MOSTRASTE..."). The prompt forbids inventing IDs and requires using a real `id` from `list_tasks` or that section. This makes completion-by-confirmation deterministic.
- **Persistence points**: the user turn is saved on entry; the final assistant reply is saved via the `finish()` helper before every return (with `metadata.tasks` when tasks were listed). All saves fail-open — a Supabase error logs and continues, never breaking the agent.
- **Not stored here**: the daily digest is sent by the cron (`lib/daily-digest.ts`), not through `processMessage`, so it is **not** in conversation memory. Replies to the digest work anyway because the agent re-runs `list_tasks`.

### CRM adapter pattern (`lib/crm/`)

`CrmAdapter` interface in `types.ts` defines 9 action methods: `searchContact`, `createContact`, `searchDeal`, `createDeal`, `moveDeal`, `createNote`, `createTask`, `listTasks`, `completeTask` (plus `listStages` for pipeline labels). Two implementations exist:

- **`HubSpotAdapter`** — calls HubSpot CRM v3 API with the tenant's `hubspot_token`. Stage names are resolved via per-tenant `tenant.stage_map` (Spanish → real HubSpot stageIds for that tenant's pipeline). Falls back to `DEFAULT_HUBSPOT_STAGE_MAP` (default HubSpot pipeline) if the tenant hasn't configured a map.
- **`NativeAdapter`** — reads/writes directly to Supabase tables (`contacts`, `deals`, `notes`, `tasks`) scoped by `tenant_id`.

`lib/crm/index.ts` is the factory — `getCrmAdapter(tenant)` returns the right implementation. To add Salesforce or any new CRM: implement `CrmAdapter`, add the case in `index.ts`.

### Multi-tenancy

Tenants live in the `tenants` Supabase table (text primary key, e.g. `"qna-medical"`). Each tenant row holds its own WhatsApp credentials, CRM type, HubSpot token (if applicable), and system prompt. `lib/tenants.ts` exposes CRUD helpers. The admin panel at `/admin` manages tenants via the REST API at `/api/admin/tenants`. Bodies are validated with Zod (`lib/schemas.ts`).

### Auth (admin panel)

Single shared secret stored in `ADMIN_SECRET`. The login page POSTs to `/api/admin/auth`; on success the server sets an **HttpOnly, SameSite=Lax, Secure (in prod) cookie** named `z-admin-session` containing a SHA-256 hash of the secret (12h TTL). All admin endpoints check the cookie via `isAuthenticated()` in `lib/admin-auth.ts` (uses `crypto.timingSafeEqual`). Logout posts to `/api/admin/logout` which clears the cookie. No JWT, no DB sessions.

### Proposal follow-up (HubSpot task only)

When a HubSpot deal enters the configured proposal stage (or when `pollProposalEmails` syncs an email sent with the proposal template), the cron creates a follow-up **HubSpot task** for the commercial. **No WhatsApp message is sent per deal** — that role is covered by the consolidated [daily digest](#daily-task-digest-proactive-whatsapp). Sending one push per proposal proved noisy (50+ per day) and unreliable (24h WhatsApp service window often closed over weekends; Meta's Cloud API accepts the request with 2xx then silently fails delivery via a status webhook).

- **Trigger**: `/api/cron/check-deals` runs at 12:00 UTC daily (= 7am Bogotá). It runs **before** the daily digest (8am Bogotá) so the newly-created tasks are visible in the same morning's digest. Two stages inside: `pollProposalEmails` → `pollProposalNotifications` (in `lib/hubspot-poll.ts`).
- **Task shape**: title `Enviar WhatsApp de seguimiento a {firstname} de {company} ({phone}) — {deal label}`. Due **today 09:00 Bogotá** — i.e. ~2 hours after the cron run. Since the cron only picks up emails sent _before_ today's 7am scan, "today" from the cron's perspective is "next day" from the email's perspective (≥16h of review time for the client in the typical 9am–6pm proposal-send window).
- **Reminder**: `hs_task_reminders` is set as a **raw epoch-ms timestamp** (`dueTs`, e.g. `1780408800000`) in `HubSpotAdapter.createTask`. The JSON-array form (`[dueTs]`) used previously is now rejected by HubSpot with `INVALID_DATE` ("Expected to be an epoch timestamp") and 400s the whole task creation — this broke both chat-created tasks and proposal follow-ups until fixed. A single reminder at the due time fires the notification (requires the task to have an owner).
- **Owner**: prefers the deal's `hubspot_owner_id`, falls back to `tenant.hubspot_owner_id`. If neither is set we log a warning — without owner, HubSpot won't fire the reminder.
- **Dedup**: `activity_log.action = 'proposal_followup_queued'` keyed on `details->>deal_id`.
- **Auth**: `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends this when `CRON_SECRET` is set).

### Daily task digest (proactive WhatsApp)

When `tenant.daily_digest_enabled = true`, the system sends a daily WhatsApp **free-form** message to `tenant.owner_number` summarizing pending tasks.

- **Trigger**: Vercel Cron hits `/api/cron/daily-tasks` once per day at 13:00 UTC (= 8am Bogotá).
- **Polling logic**: `lib/daily-digest.ts` calls `crm.listTasks({ fromDate: today-30d, toDate: today+7d, includeCompleted: false })` for each active tenant with the flag on. Buckets results into **overdue** (`due_date < today`), **today** (`= today`), and **upcoming** (`> today`, `≤ today+7d`). The 7-day rolling horizon (vs a Sun-anchored week) keeps the digest predictable: every day shows today + the next 6 days, no shrinking-window oddity on Fri/Sat. All date comparisons are anchored to America/Bogota.
- **Dedup**: queries `activity_log` for `action = 'daily_digest_sent'` matching `details->>date = today` — if found, skip. Vercel Cron may retry on failure; this prevents double sends within the same day.
- **No-op when empty**: if there are no pending tasks in any bucket, logs `daily_digest_skipped` and sends nothing.
- **Free-form, not template**: uses `sendWhatsAppMessage()` (text). Requires the 24h WhatsApp customer-service window to be open on the owner's number. If Meta returns out-of-window error, logs `daily_digest_failed` and continues — no fallback template is configured.
- **Auth**: cron endpoint requires `Authorization: Bearer <CRON_SECRET>` (same secret as `/api/cron/check-deals`).
- **Required tenant config**: `daily_digest_enabled = true`, `whatsapp_phone_id`, `whatsapp_token`, `owner_number`. Tenants without the flag (or missing credentials) are filtered out at the query level.

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
- **Conversation memory**: recent textual turns (last 12 / 6h) are reinjected per conversation — see [Conversation memory](#conversation-memory-libconversationts). Intermediate `tool_calls` are not stored; real `task_id`s are carried forward via `metadata.tasks` so confirmations ("Sí") complete deterministically.
- **`maxDuration = 60`** on the webhook route — if the agent loop takes longer (e.g. many tool calls), Vercel will cut it off. Admin endpoints have `maxDuration = 30`.
- **Security headers** are applied globally via `next.config.js` (X-Frame-Options DENY, HSTS, nosniff, restrictive Permissions-Policy).
