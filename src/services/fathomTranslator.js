/**
 * Anthropic translator for Fathom meeting summaries.
 *
 * Fathom returns the summary in English even when the meeting is in Spanish
 * (its template language is account-wide, not per-recording). We translate
 * to Spanish on ingest preserving the markdown structure exactly — headings
 * (`###`), bullet lists, and the timestamp links to fathom.video/share/...
 *
 * Uses Anthropic's Claude API (the backend already has ANTHROPIC_API_KEY
 * configured for the voice agent).
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.FATHOM_TRANSLATE_MODEL || 'claude-haiku-4-5-20251001';

const TRANSLATE_PROMPT = `Eres un traductor profesional. Recibirás un resumen de reunión en formato Markdown.

Tu tarea:
1. Traduce el texto a español neutro, profesional, claro.
2. Preserva EXACTAMENTE la estructura Markdown: encabezados con ###, enlaces [texto](url), listas con guiones, saltos de línea.
3. NO modifiques las URLs de los enlaces (https://fathom.video/share/...) ni los timestamps numéricos.
4. Si el texto ya está en español, devuélvelo tal cual sin cambios.
5. Mantén nombres propios de personas, productos y marcas sin traducir.

Devuelve SOLO el markdown traducido, sin explicaciones adicionales, sin comillas de código, sin "Aquí está la traducción:".`;

/**
 * Translate a Fathom-formatted markdown summary to Spanish.
 * Returns the original text on error or when ANTHROPIC_API_KEY is missing.
 * @param {string} markdown
 * @returns {Promise<string>}
 */
export async function translateSummaryToSpanish(markdown) {
    if (!markdown || typeof markdown !== 'string' || !markdown.trim()) return markdown;
    if (!ANTHROPIC_API_KEY) {
        console.warn('[Fathom] ANTHROPIC_API_KEY not set, skipping summary translation');
        return markdown;
    }

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: MODEL,
                max_tokens: 4096,
                system: TRANSLATE_PROMPT,
                messages: [{ role: 'user', content: markdown }],
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error('[Fathom] Anthropic API error:', response.status, errText.substring(0, 300));
            return markdown;
        }

        const data = await response.json();
        const translated = data.content?.[0]?.text?.trim();
        return translated || markdown;
    } catch (err) {
        console.error('[Fathom] Translation failed:', err.message);
        return markdown;
    }
}
