/**
 * Multi-provider translator for Fathom meeting summaries.
 *
 * Fathom returns the summary in English even when the meeting is in Spanish
 * (its template language is account-wide, not per-recording). We translate
 * to Spanish on ingest preserving the markdown structure exactly — headings
 * (`###`), bullet lists, and the timestamp links to fathom.video/share/...
 *
 * Provider routing is auto-detected from the API key prefix:
 *   - sk-ant-...   → Anthropic Claude (/v1/messages)
 *   - sk-...       → OpenAI GPT       (/v1/chat/completions)
 * Both env vars are read; if both exist, ANTHROPIC_API_KEY wins.
 */

import { logErrorToSlack } from '../middleware/slackErrorLogger.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;
const FORCE_PROVIDER    = process.env.FATHOM_TRANSLATE_PROVIDER; // 'anthropic' | 'openai'
const ANTHROPIC_MODEL   = process.env.FATHOM_TRANSLATE_MODEL_ANTHROPIC || 'claude-haiku-4-5-20251001';
const OPENAI_MODEL      = process.env.FATHOM_TRANSLATE_MODEL_OPENAI    || 'gpt-4o-mini';

const TRANSLATE_PROMPT = `Eres un traductor profesional. Recibirás un resumen de reunión en formato Markdown.

Tu tarea:
1. Traduce el texto a español neutro, profesional, claro.
2. Preserva EXACTAMENTE la estructura Markdown: encabezados con ###, enlaces [texto](url), listas con guiones, saltos de línea.
3. NO modifiques las URLs de los enlaces (https://fathom.video/share/...) ni los timestamps numéricos.
4. Si el texto ya está en español, devuélvelo tal cual sin cambios.
5. Mantén nombres propios de personas, productos y marcas sin traducir.

Devuelve SOLO el markdown traducido, sin explicaciones adicionales, sin comillas de código, sin "Aquí está la traducción:".`;

/**
 * Decide which provider+key to use based on env vars and key prefixes.
 * @returns {{ provider: 'anthropic'|'openai'|null, key: string|null, reason: string }}
 */
function pickProvider() {
    // Explicit override wins.
    if (FORCE_PROVIDER === 'anthropic' && ANTHROPIC_API_KEY) {
        return { provider: 'anthropic', key: ANTHROPIC_API_KEY, reason: 'forced anthropic' };
    }
    if (FORCE_PROVIDER === 'openai' && OPENAI_API_KEY) {
        return { provider: 'openai', key: OPENAI_API_KEY, reason: 'forced openai' };
    }

    // Auto-detect by key prefix. ANTHROPIC_API_KEY wins if it's actually a Claude key.
    if (ANTHROPIC_API_KEY?.startsWith('sk-ant-')) {
        return { provider: 'anthropic', key: ANTHROPIC_API_KEY, reason: 'sk-ant- in ANTHROPIC_API_KEY' };
    }
    if (OPENAI_API_KEY?.startsWith('sk-') && !OPENAI_API_KEY.startsWith('sk-ant-')) {
        return { provider: 'openai', key: OPENAI_API_KEY, reason: 'sk- in OPENAI_API_KEY' };
    }
    // Fallback: if ANTHROPIC_API_KEY contains an OpenAI-style key (sk-... not sk-ant-),
    // route it to OpenAI. This is the exact misconfiguration the user reported.
    if (ANTHROPIC_API_KEY?.startsWith('sk-') && !ANTHROPIC_API_KEY.startsWith('sk-ant-')) {
        return { provider: 'openai', key: ANTHROPIC_API_KEY, reason: 'sk- (non-ant) in ANTHROPIC_API_KEY → routing to OpenAI' };
    }
    return { provider: null, key: null, reason: 'no usable key found' };
}

async function callAnthropic(key, markdown) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: ANTHROPIC_MODEL,
            max_tokens: 4096,
            system: TRANSLATE_PROMPT,
            messages: [{ role: 'user', content: markdown }],
        }),
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Anthropic ${res.status}: ${errText.substring(0, 300)}`);
    }
    const data = await res.json();
    return data.content?.[0]?.text?.trim() || null;
}

async function callOpenAI(key, markdown) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'authorization': `Bearer ${key}`,
        },
        body: JSON.stringify({
            model: OPENAI_MODEL,
            temperature: 0.2,
            messages: [
                { role: 'system', content: TRANSLATE_PROMPT },
                { role: 'user',   content: markdown },
            ],
        }),
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OpenAI ${res.status}: ${errText.substring(0, 300)}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
}

/**
 * Translate a Fathom-formatted markdown summary to Spanish.
 * @param {string} markdown
 * @returns {Promise<{ text: string, status: 'translated'|'no_key'|'empty'|'failed', provider?: string, error?: string }>}
 */
export async function translateSummaryToSpanish(markdown) {
    if (!markdown || typeof markdown !== 'string' || !markdown.trim()) {
        return { text: markdown, status: 'empty' };
    }
    const { provider, key, reason } = pickProvider();
    if (!provider) {
        console.warn('[Fathom] No translation API key configured:', reason);
        return { text: markdown, status: 'no_key' };
    }

    try {
        const translated = provider === 'anthropic'
            ? await callAnthropic(key, markdown)
            : await callOpenAI(key, markdown);
        if (!translated) {
            logErrorToSlack('warning', {
                category: 'fathom', action: 'translation.empty_response',
                message: `${provider} returned empty content`,
                module: 'fathom-translator',
                details: { provider, reason },
            });
            return { text: markdown, status: 'failed', provider, error: `empty content from ${provider}` };
        }
        return { text: translated, status: 'translated', provider };
    } catch (err) {
        console.error(`[Fathom] Translation via ${provider} failed:`, err.message);
        logErrorToSlack('warning', {
            category: 'fathom', action: 'translation.api_error',
            message: `${provider} error translating summary`,
            module: 'fathom-translator',
            details: { provider, reason, message: err.message?.substring(0, 400) },
        });
        return { text: markdown, status: 'failed', provider, error: err.message };
    }
}
