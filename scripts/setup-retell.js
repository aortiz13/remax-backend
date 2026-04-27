/**
 * Provisiona el agente de voz "Catalina" en Retell.ai vía API.
 *
 * Uso:
 *   node --env-file=.env scripts/setup-retell.js [--list-voices] [--voice-id=...] [--update=AGENT_ID]
 *
 * Variables de entorno requeridas (.env):
 *   RETELL_API_KEY           — API key de Retell (https://dashboard.retellai.com)
 *   BACKEND_BASE_URL         — Base URL pública del backend (default: easypanel)
 *
 * Salida:
 *   Imprime el agent_id. Cópialo a RETELL_AGENT_ID en EasyPanel y reinicia el servicio.
 */

const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
        const [k, v] = a.replace(/^--/, '').split('=')
        return [k, v ?? true]
    })
)

const API_KEY = process.env.RETELL_API_KEY
if (!API_KEY) {
    console.error('❌ Falta RETELL_API_KEY en el entorno.')
    process.exit(1)
}

const BASE = process.env.BACKEND_BASE_URL || 'https://remax-crm-remax-app.jzuuqr.easypanel.host'
const WSS = BASE.replace(/^https?:/, 'wss:')
const RETELL_API = 'https://api.retellai.com'

async function retell(method, path, body) {
    const res = await fetch(`${RETELL_API}${path}`, {
        method,
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let json
    try { json = text ? JSON.parse(text) : {} } catch { json = { raw: text } }
    if (!res.ok) {
        const err = new Error(`Retell ${method} ${path} → ${res.status} ${res.statusText}`)
        err.status = res.status
        err.body = json
        throw err
    }
    return json
}

// ─── Listar voces en español ──────────────────────────────────────────────────

async function listSpanishVoices() {
    const voices = await retell('GET', '/list-voices')
    return voices.filter(v => {
        const a = (v.accent || '').toLowerCase()
        const n = (v.voice_name || '').toLowerCase()
        return a.includes('spanish') || a.includes('españ') || /\bes[-_]/i.test(v.voice_id) ||
            n.includes('españ') || n.includes('latin')
    })
}

if (args['list-voices']) {
    const voices = await listSpanishVoices()
    if (!voices.length) {
        console.log('⚠️  No se encontraron voces en español filtrando por accent/name.')
        console.log('Mostrando todas las voces disponibles para inspección manual:')
        const all = await retell('GET', '/list-voices')
        for (const v of all) console.log(`  ${(v.voice_id||'').padEnd(40)} ${v.voice_name || ''} (${v.gender || '?'}, ${v.accent || '?'}, ${v.provider || '?'})`)
    } else {
        console.log(`\n🎙  Voces en español (${voices.length}):\n`)
        for (const v of voices) {
            console.log(`  ${(v.voice_id||'').padEnd(40)} ${(v.voice_name||'').padEnd(20)} ${(v.gender||'').padEnd(8)} ${v.accent || ''}  (${v.provider || ''})`)
        }
    }
    process.exit(0)
}

// ─── Selección de voz por defecto ─────────────────────────────────────────────

async function pickVoice(preferred) {
    if (preferred) return preferred
    const voices = await listSpanishVoices()
    const isLatam = v => /latin|latam|419|méxico|mexico|chile|colombia/i.test(
        `${v.accent || ''} ${v.voice_name || ''} ${v.voice_id || ''}`
    )
    const female = voices.find(v => v.gender?.toLowerCase() === 'female' && isLatam(v))
        || voices.find(v => v.gender?.toLowerCase() === 'female')
        || voices[0]
    if (!female) throw new Error('No hay voces en español disponibles. Ejecuta con --list-voices.')
    return { id: female.voice_id, name: female.voice_name, accent: female.accent, gender: female.gender }
}

// ─── Configuración del agente ─────────────────────────────────────────────────

const buildConfig = (voice_id) => ({
    response_engine: {
        type: 'custom-llm',
        llm_websocket_url: `${WSS}/llm-websocket`,
    },
    voice_id,
    agent_name: 'Catalina — RE/MAX Exclusive',
    language: 'es-419',
    voice_speed: 1.0,
    voice_temperature: 1.0,
    responsiveness: 0.9,
    interruption_sensitivity: 0.7,
    enable_backchannel: true,
    backchannel_frequency: 0.7,
    backchannel_words: ['ya', 'claro', 'mhm', 'entiendo'],
    enable_voicemail_detection: true,
    voicemail_message: 'Hola, le habla Catalina de RE/MAX Exclusive. Le devolveremos la llamada. Gracias.',
    end_call_after_silence_ms: 30000,
    max_call_duration_ms: 1800000,
    webhook_url: `${BASE}/api/voice/webhook`,
    post_call_analysis_data: [
        {
            type: 'enum',
            name: 'intent',
            description: 'Intención principal de la llamada del cliente.',
            choices: ['compra', 'arriendo', 'venta', 'administracion', 'consulta_pago', 'reclamo', 'informacion_general', 'otro'],
        },
        {
            type: 'boolean',
            name: 'lead_captured',
            description: 'Se capturó nombre y teléfono del contacto durante la llamada.',
        },
        {
            type: 'boolean',
            name: 'transferred_to_human',
            description: 'La llamada fue transferida a un agente humano.',
        },
        {
            type: 'boolean',
            name: 'voicemail_detected',
            description: 'La llamada cayó en buzón de voz / contestador automático.',
        },
        {
            type: 'string',
            name: 'property_interest',
            description: 'Tipo y zona de propiedad mencionada por el cliente (ej: "casa en Las Condes").',
        },
        {
            type: 'string',
            name: 'budget_mentioned',
            description: 'Presupuesto o monto mencionado por el cliente, si lo dio.',
        },
        {
            type: 'enum',
            name: 'urgency',
            description: 'Urgencia percibida del contacto.',
            choices: ['alta', 'normal', 'baja'],
        },
        {
            type: 'string',
            name: 'next_action',
            description: 'Acción de seguimiento recomendada para el equipo de RE/MAX.',
        },
    ],
})

// ─── Crear o actualizar agente ────────────────────────────────────────────────

const voicePick = await pickVoice(args['voice-id'])
const voice_id = typeof voicePick === 'string' ? voicePick : voicePick.id

console.log('\n📞  RE/MAX Exclusive — Provisión de agente Retell.ai\n')
console.log(`  Backend:        ${BASE}`)
console.log(`  WebSocket:      ${WSS}/llm-websocket`)
console.log(`  Webhook:        ${BASE}/api/voice/webhook`)
if (typeof voicePick === 'object') {
    console.log(`  Voz elegida:    ${voicePick.name} (${voicePick.gender}, ${voicePick.accent})`)
}
console.log(`  Voice ID:       ${voice_id}`)
console.log(`  Idioma:         es-419`)
console.log(`  Modo:           Custom LLM (Claude vía WebSocket en backend)`)

const config = buildConfig(voice_id)

let agent
try {
    if (args.update && typeof args.update === 'string') {
        console.log(`\n🔄  Actualizando agente existente: ${args.update}`)
        agent = await retell('PATCH', `/update-agent/${args.update}`, config)
    } else {
        console.log('\n🚀  Creando agente nuevo...')
        agent = await retell('POST', '/create-agent', config)
    }
} catch (err) {
    console.error('\n❌  Error al provisionar agente:', err.message)
    if (err.body) console.error(JSON.stringify(err.body, null, 2))
    process.exit(1)
}

console.log('\n✅  Agente provisionado:\n')
console.log(`  agent_id:       ${agent.agent_id}`)
console.log(`  version:        ${agent.version}`)
console.log(`  is_published:   ${agent.is_published}`)

console.log('\n📋  Próximos pasos:\n')
console.log(`  1. Pega esta variable en el .env de EasyPanel y reinicia el servicio:`)
console.log(`     RETELL_AGENT_ID=${agent.agent_id}\n`)
console.log(`  2. Importa el número de Twilio en el dashboard de Retell.ai`)
console.log(`     apuntándolo al agent_id de arriba.\n`)
console.log(`  3. Configura el webhook secret en el dashboard de Retell.ai`)
console.log(`     y pégalo en EasyPanel como RETELL_WEBHOOK_SECRET.\n`)
console.log(`  4. Para volver a publicar tras cambios, re-corre con:`)
console.log(`     node --env-file=.env scripts/setup-retell.js --update=${agent.agent_id}\n`)
