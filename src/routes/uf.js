import { Router } from 'express';

const router = Router();

// In-memory cache
let ufCache = null; // { valor, fecha, fetchedAt }
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
 * URL pattern: https://www.sii.cl/valores_y_fechas/uf/uf{YYYY}.htm
 */
async function scrapeUFFromSII() {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth(); // 0-indexed
    const day = now.getDate();

    const monthNames = [
        'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
        'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(`https://www.sii.cl/valores_y_fechas/uf/uf${year}.htm`, {
        signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return null;

    const html = await response.text();

    // The SII table has rows for each month, with columns for days 1-31
    // Each row starts with the month name, then has <td> values for each day
    const targetMonth = monthNames[month];

    // Find the table rows containing month data
    // Pattern: find the row that contains the month name, then extract td values
    const rowRegex = new RegExp(
        `<tr[^>]*>\\s*<th[^>]*>[^<]*${targetMonth}[^<]*</th>([\\s\\S]*?)</tr>`,
        'i'
    );
    const rowMatch = html.match(rowRegex);

    if (!rowMatch) return null;

    // Extract all td values from this row
    const tdRegex = /<td[^>]*>([\d.,]*)<\/td>/g;
    const values = [];
    let m;
    while ((m = tdRegex.exec(rowMatch[1])) !== null) {
        values.push(m[1]);
    }

    // Day index is (day - 1), since values[0] = day 1
    // Try today first, then go backwards to find the most recent value
    for (let d = day; d >= 1; d--) {
        const val = values[d - 1];
        if (val && val.trim()) {
            // Parse Chilean number format: "39.841,72" → 39841.72
            const parsed = parseFloat(val.replace(/\./g, '').replace(',', '.'));
            if (!isNaN(parsed) && parsed > 0) {
                const fecha = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                return { valor: parsed, fecha, source: 'sii' };
            }
        }
    }

    return null;
}

export default router;
