# RE/MAX Exclusive — Backend API

## ⚠️ CONFIGURACIÓN OBLIGATORIA — NO PREGUNTAR

Estos valores son **fijos y autoritativos** para este proyecto. NO preguntar al usuario, NO sugerir Supabase, NO buscar credenciales en otros lugares.

### Base de datos (PostgreSQL auto-hospedado en EasyPanel — NO ES SUPABASE)

```
postgres://postgres:5a58ca9a00e2837be764@panel.remax-exclusive.cl:5432/postgres?sslmode=disable
```

| Campo | Valor |
|-------|-------|
| Host | `panel.remax-exclusive.cl` |
| Puerto | `5432` |
| Usuario | `postgres` |
| Password | `5a58ca9a00e2837be764` |
| Database | `postgres` |
| SSL mode | `disable` |

**Reglas estrictas:**
- ❌ NO usar el MCP de Supabase ni cualquier herramienta de Supabase.
- ❌ NO sugerir "verificar en Supabase dashboard" ni similares.
- ❌ NO pedir al usuario credenciales de DB — usar las de arriba.
- ✅ Usar `psql` directo o `pg` Pool con el string completo de arriba.
- ✅ Todo es PostgreSQL crudo, auto-hospedado vía EasyPanel.

## ⚠️ FLUJO DE TRABAJO OBLIGATORIO — SIEMPRE ABRIR PR

Después de **cualquier** cambio de código en este repo:

1. Commit con mensaje descriptivo.
2. `git push -u origin <branch>`.
3. **Abrir Pull Request automáticamente** con `mcp__github__create_pull_request` hacia `main`.
4. Devolver la URL del PR al usuario.

NO esperar a que el usuario lo pida. NO dejar cambios solo pusheados sin PR.

## ⚠️ TIMELINE / HISTORIAL OBLIGATORIO PARA LEADS, CANDIDATOS, CONTACTOS Y PROPIEDADES

**Toda actividad** generada sobre un lead, candidato, contacto o propiedad **debe quedar registrada** en su línea de tiempo (storyline / historial). Esto incluye: creación, asignación, cambio de estado, llamadas, emails enviados/abiertos/clickeados, mensajes WhatsApp, reuniones, notas, subida de documentos, cambios de etapa, transferencias, etc.

### Tabla canónica: `activity_logs`

```sql
INSERT INTO activity_logs (
    id, actor_id, action, entity_type, entity_id,
    description, details, contact_id, property_id
) VALUES (
    gen_random_uuid(),
    $actorId,            -- profiles.id del usuario que hizo la acción (null = sistema)
    $action,             -- etiqueta corta: 'Lead Recibido', 'Email Enviado', 'Llamada Realizada'...
    $entityType,         -- 'Lead' | 'Contact' | 'Property' | 'ExternalLead' | 'Candidate' | etc.
    $entityId,           -- UUID del objeto principal de la acción
    $description,        -- texto humano en español para mostrar en el timeline
    $detailsJsonb,       -- JSONB con metadata extra (tracking_id, url, payload, etc.)
    $contactId,          -- FK al contacto (para que aparezca en su historial)
    $propertyId          -- FK a la propiedad (para que aparezca en su historial)
);
```

### Reglas estrictas

- ✅ **Siempre** insertar en `activity_logs` cuando se genere una actividad sobre lead/candidato/contacto/propiedad.
- ✅ Si la actividad toca varios objetos (ej. lead + propiedad), llenar `contact_id` Y `property_id` para que aparezca en ambos timelines.
- ✅ Usar `description` en español, redactada como aparecería al usuario final.
- ✅ Guardar contexto útil en `details` (JSONB): IDs externos, URLs, payload del webhook, etc.
- ✅ Si la acción es del sistema (cron, webhook, n8n), `actor_id` puede ser `null` o el `profiles.id` de un perfil de servicio.
- ❌ NO crear nuevas tablas de "historial" paralelas — usar `activity_logs`.
- ❌ NO omitir el log "porque es trivial" — el timeline es la fuente de verdad para auditoría.

Ver ejemplos vivos en `src/routes/tracking.js`, `src/routes/webForms.js`.

## Infraestructura real

| Servicio | URL |
|---------|-----|
| **API Gateway** | https://remax-crm-remax-app.jzuuqr.easypanel.host |
| **Base de datos** | `postgres://postgres:5a58ca9a00e2837be764@panel.remax-exclusive.cl:5432/postgres?sslmode=disable` |
| **Storage (MinIO)** | https://remax-crm-remax-storage.jzuuqr.easypanel.host |
| **Frontend** | https://solicitudes.remax-exclusive.cl |
| **N8N Workflows** | https://workflow.remax-exclusive.cl |

**Deploy:** push a `main` → EasyPanel reconstruye automáticamente.
**NO usar Supabase MCP** — todo es auto-hospedado en EasyPanel.

---

## Stack

- **Runtime:** Node.js 20 ES Modules
- **Framework:** Express 4 + WebSocket (ws)
- **Base de datos:** PostgreSQL directo via `pg` Pool (raw SQL, sin ORM)
- **Colas:** BullMQ + Redis
- **Storage:** MinIO (S3-compatible) via `@aws-sdk/client-s3`
- **Auth:** GoTrue JWT (verificación local o via endpoint)
- **Logs de errores:** Slack webhook via `slackErrorLogger.js`

## Estructura

```
src/
├── server.js           # Entry point — Express + WebSocket server
├── worker.js           # Background BullMQ job processor
├── lib/
│   ├── db.js           # pg Pool → DATABASE_URL
│   ├── redis.js        # IORedis → REDIS_URL
│   ├── supabaseAdmin.js# Supabase SDK (para auth y queries PostgREST)
│   └── storage.js      # MinIO S3 client
├── middleware/
│   ├── auth.js         # JWT GoTrue middleware
│   └── slackErrorLogger.js
├── routes/             # 20 módulos de rutas bajo /api/*
│   ├── voice.js        # Agente de voz: webhook Retell + dashboard API
│   └── voiceCampaigns.js # Campañas outbound + upload Excel
├── llm/
│   ├── wsHandler.js    # WebSocket handler para Retell Custom LLM (Claude)
│   └── systemPrompt.js # Prompts del agente (inbound + cobranza)
├── services/
│   ├── retellService.js     # Retell REST API (crear llamadas outbound)
│   ├── voiceEmailService.js # SMTP para emails del agente
│   └── ...
├── queues/index.js     # 13 colas BullMQ
└── cron/scheduler.js   # Cron jobs (incluye campañas de voz)
migrations/
└── 001_voice_agent_tables.sql  # Tablas del agente de voz
```

## Patrones de código

```javascript
// DB: siempre pool.query con raw SQL
import pool from '../lib/db.js';
const { rows } = await pool.query('SELECT * FROM table WHERE id = $1', [id]);

// Rutas: Express Router + authMiddleware
import { Router } from 'express';
import authMiddleware from '../middleware/auth.js';
const router = Router();
router.get('/ruta', authMiddleware, async (req, res) => { ... });

// Errores: siempre logear a Slack
import { logErrorToSlack } from '../middleware/slackErrorLogger.js';
logErrorToSlack('error', { category: 'modulo', action: 'accion', message: err.message });
```

---

## Módulo de Agente de Voz

### Rutas

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/voice/webhook` | Eventos de Retell (call_started, call_ended, call_analyzed) |
| GET | `/api/voice/metrics` | Métricas generales del dashboard |
| GET | `/api/voice/calls` | Historial de llamadas (paginado) |
| GET | `/api/voice/calls/:id` | Detalle de llamada con lead y acciones |
| GET | `/api/voice/campaigns` | Listar campañas outbound |
| POST | `/api/voice/campaigns` | Crear campaña |
| POST | `/api/voice/campaigns/:id/upload` | Cargar Excel de contactos |
| POST | `/api/voice/campaigns/:id/start` | Iniciar campaña manualmente |
| POST | `/api/voice/call` | Llamada outbound individual manual |

### WebSocket

```
wss://remax-crm-remax-app.jzuuqr.easypanel.host/llm-websocket
```

Retell conecta aquí para el Custom LLM. El handler en `src/llm/wsHandler.js` llama a Claude (claude-sonnet-4-6) con tool use.

### Herramientas del agente (tools)

| Tool | Acción |
|------|--------|
| `captureLead` | Guarda lead en `call_leads` |
| `sendWhatsAppToRemax` | POST a N8N WhatsApp webhook |
| `sendWhatsAppToClient` | POST a N8N WhatsApp webhook |
| `sendEmail` | SMTP via `voiceEmailService.js` |
| `transferToHuman` | Devuelve `transfer_destination` a Retell |

---

## Configurar Retell.ai (pasos)

1. Cuenta en https://app.retellai.com
2. **Settings → Twilio Integration** → ingresar Account SID y Auth Token de Twilio
3. **Phone Numbers** → importar número Twilio (+56...)
4. **Create Agent** → tipo **Custom LLM**:
   - LLM WebSocket URL: `wss://remax-crm-remax-app.jzuuqr.easypanel.host/llm-websocket`
   - Webhook URL: `https://remax-crm-remax-app.jzuuqr.easypanel.host/api/voice/webhook`
   - Voice: `es-CL-CatalinaNeural` (Azure)
   - Language: Spanish
5. Copiar **Agent ID** → `RETELL_AGENT_ID` en `.env`
6. Copiar **API Key** → `RETELL_API_KEY` en `.env`
7. Generar **Webhook Secret** → `RETELL_WEBHOOK_SECRET` en `.env`
8. **Phone Numbers** → Assign Agent → seleccionar el agente creado

## Ejecutar migración SQL

```bash
psql "postgres://postgres:5a58ca9a00e2837be764@panel.remax-exclusive.cl:5432/postgres?sslmode=disable" \
  -f migrations/001_voice_agent_tables.sql
```

## Variables de entorno del agente de voz

```env
RETELL_API_KEY=key_...
RETELL_AGENT_ID=agent_...
RETELL_WEBHOOK_SECRET=...
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+56...
ANTHROPIC_API_KEY=sk-ant-...
SMTP_USER=info@remax-exclusive.cl
SMTP_PASS=...
REMAX_TRANSFER_PHONE=+56...
N8N_WHATSAPP_WEBHOOK_URL=https://workflow.remax-exclusive.cl/webhook/whatsapp
```

## Audit logs

Tabla `system_audit_logs` en la DB. Usar `logErrorToSlack` para errores (también escribe en Slack).
