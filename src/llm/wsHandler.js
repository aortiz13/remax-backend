import Anthropic from '@anthropic-ai/sdk';
import pool from '../lib/db.js';
import { INBOUND_SYSTEM_PROMPT, DEBT_COLLECTION_PROMPT } from './systemPrompt.js';
import { logErrorToSlack } from '../middleware/slackErrorLogger.js';

let _anthropic;
function anthropicClient() {
    if (!_anthropic) {
        if (!process.env.ANTHROPIC_API_KEY) {
            throw new Error('ANTHROPIC_API_KEY is not set in environment');
        }
        _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return _anthropic;
}

const TOOLS = [
    {
        name: 'captureLead',
        description: 'Guarda los datos del lead/cliente en el sistema CRM de RE/MAX.',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Nombre completo' },
                phone: { type: 'string', description: 'Teléfono del cliente' },
                email: { type: 'string', description: 'Email (si lo dio)' },
                operation_type: { type: 'string', enum: ['compra', 'arriendo', 'venta', 'administracion', 'consulta'] },
                property_interest: { type: 'string', description: 'Descripción de la propiedad buscada' },
                budget_range: { type: 'string', description: 'Presupuesto aproximado' },
                notes: { type: 'string', description: 'Notas adicionales' }
            },
            required: ['name', 'phone', 'operation_type']
        }
    },
    {
        name: 'sendWhatsAppToRemax',
        description: 'Envía WhatsApp al equipo interno de RE/MAX con datos del cliente.',
        input_schema: {
            type: 'object',
            properties: {
                message: { type: 'string', description: 'Resumen de la llamada para el equipo' },
                priority: { type: 'string', enum: ['normal', 'high'] }
            },
            required: ['message']
        }
    },
    {
        name: 'sendWhatsAppToClient',
        description: 'Envía WhatsApp de confirmación al cliente.',
        input_schema: {
            type: 'object',
            properties: {
                phone: { type: 'string', description: 'Teléfono con código país, ej: +56912345678' },
                message: { type: 'string' }
            },
            required: ['phone', 'message']
        }
    },
    {
        name: 'sendEmail',
        description: 'Envía email al equipo de RE/MAX con el resumen de la llamada.',
        input_schema: {
            type: 'object',
            properties: {
                subject: { type: 'string' },
                body: { type: 'string' },
                to: { type: 'string', description: 'Destinatario opcional' }
            },
            required: ['subject', 'body']
        }
    },
    {
        name: 'transferToHuman',
        description: 'Transfiere la llamada a un agente humano de RE/MAX.',
        input_schema: {
            type: 'object',
            properties: { reason: { type: 'string' } },
            required: ['reason']
        }
    }
];

function toAnthropicMessages(transcript) {
    return (transcript || [])
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role === 'agent' ? 'assistant' : 'user', content: m.content }));
}

async function getCallDbId(retellCallId) {
    const { rows } = await pool.query('SELECT id FROM voice_calls WHERE retell_call_id = $1', [retellCallId]);
    return rows[0]?.id || null;
}

async function executeTool(toolName, toolArgs, retellCallId) {
    try {
        const callId = await getCallDbId(retellCallId);

        switch (toolName) {
            case 'captureLead': {
                if (callId) {
                    await pool.query(
                        `INSERT INTO call_leads (call_id, name, phone, email, operation_type, property_interest, budget_range, additional_info)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                        [callId, toolArgs.name, toolArgs.phone, toolArgs.email || null,
                            toolArgs.operation_type, toolArgs.property_interest || null,
                            toolArgs.budget_range || null, JSON.stringify({ notes: toolArgs.notes })]
                    );
                    await pool.query(
                        `INSERT INTO call_actions (call_id, action_type, action_data) VALUES ($1, 'lead_captured', $2)`,
                        [callId, JSON.stringify(toolArgs)]
                    );
                }
                return { success: true };
            }

            case 'sendWhatsAppToRemax': {
                const n8nUrl = process.env.N8N_WHATSAPP_WEBHOOK_URL || process.env.N8N_WEBHOOK_URL;
                if (n8nUrl) {
                    await fetch(n8nUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ type: 'voice_agent_notification', priority: toolArgs.priority || 'normal', message: toolArgs.message, timestamp: new Date().toISOString() })
                    });
                }
                if (callId) await pool.query(
                    `INSERT INTO call_actions (call_id, action_type, action_data) VALUES ($1, 'whatsapp_remax', $2)`,
                    [callId, JSON.stringify(toolArgs)]
                );
                return { success: true };
            }

            case 'sendWhatsAppToClient': {
                const n8nUrl = process.env.N8N_WHATSAPP_WEBHOOK_URL || process.env.N8N_WEBHOOK_URL;
                if (n8nUrl) {
                    await fetch(n8nUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ type: 'client_confirmation', to: toolArgs.phone, message: toolArgs.message })
                    });
                }
                if (callId) await pool.query(
                    `INSERT INTO call_actions (call_id, action_type, action_data) VALUES ($1, 'whatsapp_client', $2)`,
                    [callId, JSON.stringify(toolArgs)]
                );
                return { success: true };
            }

            case 'sendEmail': {
                const { sendAgentEmail } = await import('../services/voiceEmailService.js');
                await sendAgentEmail(toolArgs);
                if (callId) await pool.query(
                    `INSERT INTO call_actions (call_id, action_type, action_data) VALUES ($1, 'email_sent', $2)`,
                    [callId, JSON.stringify(toolArgs)]
                );
                return { success: true };
            }

            case 'transferToHuman': {
                if (callId) await pool.query(
                    `INSERT INTO call_actions (call_id, action_type, action_data) VALUES ($1, 'transfer', $2)`,
                    [callId, JSON.stringify(toolArgs)]
                );
                return { success: true, transfer_to: process.env.REMAX_TRANSFER_PHONE };
            }

            default:
                return { success: false, error: 'Unknown tool' };
        }
    } catch (err) {
        logErrorToSlack('error', { category: 'voice-agent', action: `tool.${toolName}`, message: err.message });
        return { success: false, error: err.message };
    }
}

export function handleLlmWebSocket(ws, req) {
    // Retell sends the call ID in the URL query or header
    const url = new URL(req.url, 'http://localhost');
    const retellCallId = url.searchParams.get('call_id') || req.headers['x-retell-call-id'] || null;

    // Determine system prompt — if metadata has campaign contact, use debt collection prompt
    let systemPrompt = INBOUND_SYSTEM_PROMPT;

    ws.on('message', async (rawMsg) => {
        let request;
        try { request = JSON.parse(rawMsg.toString()); } catch { return; }

        if (request.interaction_type === 'ping_pong') {
            ws.send(JSON.stringify({ response_type: 'ping_pong', timestamp: request.timestamp }));
            return;
        }

        // On first call_details message, check if it's a campaign call with debt context
        if (request.interaction_type === 'call_details') {
            const meta = request.call?.metadata || {};
            if (meta.contact_name && meta.debt_amount) {
                systemPrompt = DEBT_COLLECTION_PROMPT(meta);
            }
            return;
        }

        if (request.interaction_type !== 'response_required' && request.interaction_type !== 'reminder_required') return;

        const messages = toAnthropicMessages(request.transcript);

        let response;
        try {
            response = await anthropicClient().messages.create({
                model: 'claude-sonnet-4-6',
                max_tokens: 512,
                system: systemPrompt,
                messages,
                tools: TOOLS
            });
        } catch (err) {
            logErrorToSlack('error', { category: 'voice-agent', action: 'llm.error', message: err.message });
            ws.send(JSON.stringify({
                response_type: 'response',
                content: 'Disculpe, tuve un inconveniente. ¿Podría repetir lo que me dijo?',
                content_complete: true
            }));
            return;
        }

        // Handle tool use
        if (response.stop_reason === 'tool_use') {
            const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
            const toolResults = [];
            let transferPhone = null;

            for (const tool of toolUseBlocks) {
                const result = await executeTool(tool.name, tool.input, retellCallId);
                toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: JSON.stringify(result) });
                if (tool.name === 'transferToHuman' && result.transfer_to) transferPhone = result.transfer_to;
            }

            const followUp = await anthropicClient().messages.create({
                model: 'claude-sonnet-4-6',
                max_tokens: 256,
                system: systemPrompt,
                messages: [
                    ...messages,
                    { role: 'assistant', content: response.content },
                    { role: 'user', content: toolResults }
                ]
            });

            const text = followUp.content.find(b => b.type === 'text')?.text || '';
            const payload = { response_type: 'response', content: text, content_complete: true };
            if (transferPhone) payload.transfer_destination = { type: 'phone_number', number: transferPhone };
            ws.send(JSON.stringify(payload));
            return;
        }

        const text = response.content.find(b => b.type === 'text')?.text || '';
        ws.send(JSON.stringify({ response_type: 'response', content: text, content_complete: true }));
    });

    ws.on('error', err => logErrorToSlack('warning', { category: 'voice-agent', action: 'ws.error', message: err.message }));
}
