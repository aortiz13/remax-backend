import { Router } from 'express';

const router = Router();

// In-memory cache
let ufCache = null; // { valor, fecha, fetchedAt, source }
const CACHE_TTL = 1000 * 60 * 60; // 1 hour

/**
 * GET /api/uf
 * Server-side proxy for fetching UF value (avoids CORS issues in the browser).
 * Priority: mindicador.cl → SII scraping fallback
 */
router.get('/', async (req, res) => {
    // Return cache if fresh
    if (ufCache && Date.now() - ufCache.fetchedAt < CACHE_TTL) {
        return res.json({ valor: ufCache.valor, fecha: ufCache.fecha, source: ufCache.source, cached: true });
    }

    // --- Endpoint 1: mindicador.cl/api/uf ---
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const response = await fetch('https://mindicador.cl/api/uf', { signal: controller.signal });
        clearTimeout(timeout);
        if (response.ok) {
            const data = await response.json();
            if (data?.serie?.[0]?.valor) {
                const result = {
                    valor: data.serie[0].valor,
                    fecha: (data.serie[0].fecha || '').split('T')[0],
                    source: 'mindicador',
                };
                ufCache = { ...result, fetchedAt: Date.now() };
                res.setHeader('Cache-Control', 'public, max-age=3600');
                return res.json(result);
            }
        }
    } catch { /* try next */ }

    // --- Endpoint 2: mindicador.cl/api (general) ---
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const response = await fetch('https://mindicador.cl/api', { signal: controller.signal });
        clearTimeout(timeout);
        if (response.ok) {
            const data = await response.json();
            if (data?.uf?.valor) {
                const result = {
                    valor: data.uf.valor,
                    fecha: (data.uf.fecha || '').split('T')[0],
                    source: 'mindicador-general',
                };
                ufCache = { ...result, fetchedAt: Date.now() };
                res.setHeader('Cache-Control', 'public, max-age=3600');
                return res.json(result);
            }
        }
    } catch { /* try next */ }

    // --- Endpoint 3: SII scraping fallback ---
    try {
        const ufFromSII = await scrapeUFFromSII();
        if (ufFromSII) {
            ufCache = { ...ufFromSII, fetchedAt: Date.now() };
            res.setHeader('Cache-Control', 'public, max-age=3600');
            return res.json(ufFromSII);
        }
    } catch { /* fall through */ }

    // Return stale cache if available
    if (ufCache) {
        return res.json({ valor: ufCache.valor, fecha: ufCache.fecha, source: ufCache.source, cached: true, stale: true });
    }

    res.status(503).json({ error: 'Unable to fetch UF value from any source' });
});

/**
 * Scrape today's UF from the SII website (always available, no API key needed).
 * URL: https://www.sii.cl/valores_y_fechas/uf/uf{YYYY}.htm
 *
 * HTML structure per month:
 *   <div class='meses' id='mes_marzo'>
 *     <table>
 *       <tr><th colspan='6'><h2>Marzo</h2></th></tr>
 *       <tr>
 *         <th>1</th><td>39.796,31</td>
 *         <th>11</th><td>39.841,72</td>
 *         <th>21</th><td>39.841,72</td>
 *       </tr>
 *       <tr>
 *         <th>2</th><td>39.801,98</td>
 *         <th>12</th><td>...</td>
 *         <th>22</th><td>...</td>
 *       </tr>
 *       ...
 *     </table>
 *   </div>
 */
async function scrapeUFFromSII() {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth(); // 0-indexed
    const day = now.getDate();

    const monthIds = [
        'mes_enero', 'mes_febrero', 'mes_marzo', 'mes_abril',
        'mes_mayo', 'mes_junio', 'mes_julio', 'mes_agosto',
        'mes_septiembre', 'mes_octubre', 'mes_noviembre', 'mes_diciembre'
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(`https://www.sii.cl/valores_y_fechas/uf/uf${year}.htm`, {
        signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return null;

    const html = await response.text();

    // Extract the month section
    const monthId = monthIds[month];
    const sectionStart = html.indexOf(`id='${monthId}'`);
    if (sectionStart < 0) return null;

    // Find the end of this month section (next <div class='meses' or end of content)
    const nextSection = html.indexOf("<div class='meses'", sectionStart + 1);
    const sectionHtml = nextSection > 0
        ? html.substring(sectionStart, nextSection)
        : html.substring(sectionStart);

    // Extract all day-value pairs: <th...><strong>DAY</strong></th><td...>VALUE</td>
    const pairRegex = /<th[^>]*>\s*<strong>(\d+)<\/strong>\s*<\/th>\s*<td[^>]*>([\d.,]*)<\/td>/g;
    const dayValues = {};
    let match;
    while ((match = pairRegex.exec(sectionHtml)) !== null) {
        const dayNum = parseInt(match[1], 10);
        const rawValue = match[2].trim();
        if (rawValue) {
            // Parse Chilean number format: "39.841,72" → 39841.72
            const parsed = parseFloat(rawValue.replace(/\./g, '').replace(',', '.'));
            if (!isNaN(parsed) && parsed > 0) {
                dayValues[dayNum] = parsed;
            }
        }
    }

    // Try today first, then go backwards to find most recent value
    for (let d = day; d >= 1; d--) {
        if (dayValues[d]) {
            const fecha = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            return { valor: dayValues[d], fecha, source: 'sii' };
        }
    }

    return null;
}

export default router;
