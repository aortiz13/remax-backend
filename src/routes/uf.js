import { Router } from 'express';

const router = Router();

/**
 * GET /api/uf
 * Proxy for fetching UF value server-side (avoids CORS issues in the browser).
 * Tries mindicador.cl first, then CMF Chile API as fallback.
 */
router.get('/', async (req, res) => {
    const endpoints = [
        {
            url: 'https://mindicador.cl/api/uf',
            extract: (data) => {
                if (data?.serie?.[0]?.valor) {
                    return {
                        valor: data.serie[0].valor,
                        fecha: (data.serie[0].fecha || '').split('T')[0],
                        source: 'mindicador'
                    };
                }
                return null;
            }
        },
        {
            url: 'https://mindicador.cl/api',
            extract: (data) => {
                if (data?.uf?.valor) {
                    return {
                        valor: data.uf.valor,
                        fecha: (data.uf.fecha || '').split('T')[0],
                        source: 'mindicador-general'
                    };
                }
                return null;
            }
        },
    ];

    for (const endpoint of endpoints) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);

            const response = await fetch(endpoint.url, { signal: controller.signal });
            clearTimeout(timeout);

            if (!response.ok) continue;

            const data = await response.json();
            const result = endpoint.extract(data);

            if (result) {
                // Cache for 1 hour via standard HTTP caching
                res.setHeader('Cache-Control', 'public, max-age=3600');
                return res.json(result);
            }
        } catch {
            // Try next endpoint
        }
    }

    res.status(503).json({ error: 'Unable to fetch UF value from any source' });
});

export default router;
