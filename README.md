# Z-Agent

Multi-tenant WhatsApp AI Agent con soporte para múltiples CRMs.

## Arquitectura

- **Next.js 15** (App Router, Server Components)
- **Supabase** (PostgreSQL + Auth)
- **Claude Sonnet 4** (Agente con tool use)
- **Meta WhatsApp Business API** (mensajería)
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
│   └── schema.sql                    ← Schema completo
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
3. Pega el contenido de `supabase/schema.sql` y ejecuta
4. Ve a **Settings → API** y copia:
   - Project URL
   - anon (public) key
   - service_role (secret) key

### 3. Configurar variables de entorno

```bash
cp .env.local.example .env.local
```

Edita `.env.local` con tus valores.

### 4. Correr en local

```bash
npm run dev
```

Abre [http://localhost:3000](http://localhost:3000) — te redirige a `/admin`.

### 5. Deploy a Vercel

```bash
git init
git add .
git commit -m "feat: z-agent initial setup"
git remote add origin https://github.com/TU_USUARIO/z-agent.git
git push -u origin main
```

En Vercel: Import repo → agregar las variables de entorno → Deploy.

### 6. Webhook en Meta Developers

URL: `https://tu-proyecto.vercel.app/api/webhook`
Token de verificación: el valor de `WEBHOOK_VERIFY_TOKEN`.

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
