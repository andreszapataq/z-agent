# Z-Agent

Multi-tenant WhatsApp AI Agent con soporte para múltiples CRMs.

## Arquitectura

- **Next.js 15** (App Router, Server Components)
- **Supabase** (PostgreSQL + Auth)
- **OpenAI gpt-4.1-mini** (Agente con tool use — configurable vía `OPENAI_MODEL`)
- **Meta WhatsApp Business API** (mensajería)
- **Upstash Redis** (rate limiting)
- **Vercel** (hosting)

## Tipos de cliente soportados

| Tipo | crm_type | Datos viven en |
|---|---|---|
| Cliente con HubSpot | `hubspot` | HubSpot del cliente |
| Cliente sin CRM externo | `native` | Supabase (CRM nativo) |
| Cliente con Salesforce | `salesforce` | (a futuro) |

## Estructura

```
z-agent/
├── app/
│   ├── api/
│   │   ├── webhook/route.ts          ← Webhook de WhatsApp
│   │   └── admin/tenants/             ← API REST del panel
│   ├── admin/
│   │   ├── page.tsx                  ← Dashboard principal
│   │   └── login/page.tsx            ← Login
│   ├── layout.tsx
│   └── globals.css
├── lib/
│   ├── agent.ts                      ← Agente Claude
│   ├── tenants.ts                    ← Gestión de tenants
│   ├── whatsapp.ts                   ← Envío WA
│   ├── supabase.ts                   ← Cliente Supabase
│   └── crm/
│       ├── types.ts                  ← Interface CrmAdapter
│       ├── hubspot.ts                ← Adapter HubSpot
│       ├── native.ts                 ← Adapter Supabase nativo
│       └── index.ts                  ← Factory
├── supabase/
│   ├── schema.sql                    ← Snapshot consolidado (referencia)
│   └── migrations/                   ← Migraciones versionadas (fuente de verdad)
├── .env.local.example
└── package.json
```

## Setup

### 1. Instalar dependencias

```bash
npm install
```

### 2. Crear proyecto en Supabase

1. Ve a [supabase.com](https://supabase.com) → New Project
2. Cuando esté listo, ve a **SQL Editor**
3. Pega el contenido de `supabase/migrations/20260504000001_initial_schema.sql` y ejecuta
   (o usa Supabase CLI: `supabase db push`)
4. Ve a **Settings → API** y copia:
   - Project URL
   - anon (public) key
   - service_role (secret) key

### 3. Crear DB de Upstash Redis (rate limiting)

1. Ve a [console.upstash.com/redis](https://console.upstash.com/redis) → Create Database
2. Region: la más cercana a tu deploy de Vercel
3. Copia **REST URL** y **REST Token**

### 4. Configurar variables de entorno

```bash
cp .env.local.example .env.local
```

Edita `.env.local` con tus valores. Genera secrets con:

```bash
openssl rand -hex 32   # ADMIN_SECRET, WEBHOOK_VERIFY_TOKEN
```

### 5. Correr en local

```bash
npm run dev
```

Abre [http://localhost:3000](http://localhost:3000) — te redirige a `/admin`.

### 6. Deploy a Vercel

```bash
git init
git add .
git commit -m "feat: z-agent initial setup"
git remote add origin https://github.com/TU_USUARIO/z-agent.git
git push -u origin main
```

En Vercel: Import repo → agregar las variables de entorno → Deploy.

### 7. Webhook en Meta Developers

URL: `https://tu-proyecto.vercel.app/api/webhook`
Token de verificación: el valor de `WEBHOOK_VERIFY_TOKEN`.

### 8. (Opcional) Notificación de propuesta vía WhatsApp

Cuando un deal entra a la etapa "Propuesta enviada" en HubSpot, el sistema envía un WhatsApp automático al cliente. Para habilitarlo:

**8.1 Crear plantilla en Meta Business Manager**
1. Ve a **WhatsApp Manager → Templates → Create Template**
2. Categoría: `UTILITY`, Idioma: `Español`
3. Nombre: `proposal_sent` (o el que prefieras)
4. Cuerpo:
   ```
   Hola {{1}}, te enviamos la propuesta económica de [Tu Empresa].
   Cualquier pregunta, responde a este mensaje.
   ```
5. Submit → espera 24-48h por aprobación

**8.2 Configurar el tenant**
1. En `/admin`, edita el cliente (ya tiene que existir con su token de HubSpot)
2. Click en **"Cargar pipelines de HubSpot"** — verás todos los stages con sus IDs
3. Click en el botón **"propuesta"** del stage que corresponda al "propuesta enviada" del cliente
4. (Recomendado) Mapea también las otras 4 etapas (`saludo`, `presentación`, `cierre`, `perdido`) con el dropdown `→map` para que el agente pueda mover deals correctamente
5. Pega el nombre del template aprobado (`proposal_sent`)
6. Guarda

**8.3 Vercel Cron**
El cron está en `vercel.json` corriendo cada 5 min. Necesitas la env var `CRON_SECRET` (genera con `openssl rand -hex 32`). Vercel la envía automáticamente al endpoint.

## Uso

### Agregar un cliente

1. Abre `/admin` y haz login
2. Clic en "Nuevo cliente"
3. Selecciona el tipo de CRM:
   - **CRM nativo** — Z-Agent guarda los datos en Supabase
   - **HubSpot** — Z-Agent lee/escribe en el HubSpot del cliente
4. Completa credenciales de WhatsApp y CRM
5. Guarda

### Hablar con el agente

Desde tu WhatsApp personal escríbele al número configurado:

```
Busca el contacto de Hospital San José
Registra que hablé con María Torres, mostró interés
Mueve el deal de Clínica Norte a propuesta
Crea una tarea para llamar a Fundación Valle el lunes
```

El agente decide internamente si la acción va a HubSpot o al CRM nativo
según el `crm_type` del tenant.

## Agregar un nuevo CRM (ej: Salesforce)

1. Crea `lib/crm/salesforce.ts` que implemente `CrmAdapter`
2. En `lib/crm/index.ts`, agrega el case `salesforce`
3. En el panel admin, agrega la opción en el selector
4. Listo — el agente lo usa automáticamente

## Comandos

```bash
npm run dev      # Desarrollo local
npm run build    # Build de producción
npm run start    # Correr build local
npm run lint     # Linter
```
