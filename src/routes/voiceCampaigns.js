import { Router } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import pool from '../lib/db.js';
import authMiddleware from '../middleware/auth.js';
import { logErrorToSlack } from '../middleware/slackErrorLogger.js';
import { createOutboundCall } from '../services/retellService.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// All routes require auth
router.use(authMiddleware);

// GET /api/voice/campaigns
router.get('/', async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT c.*,
                COUNT(cc.id)::int AS total_contacts,
                COUNT(cc.id) FILTER (WHERE cc.call_status = 'called')::int AS calls_made,
                COUNT(cc.id) FILTER (WHERE cc.call_status = 'pending')::int AS pending
            FROM outbound_campaigns c
            LEFT JOIN campaign_contacts cc ON cc.campaign_id = c.id
            GROUP BY c.id
            ORDER BY c.created_at DESC
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/voice/campaigns
router.post('/', async (req, res) => {
    try {
        const { name, type = 'debt_collection', scheduled_at, script_prompt } = req.body;
        if (!name) return res.status(400).json({ error: 'name is required' });
        const { rows: [campaign] } = await pool.query(
            `INSERT INTO outbound_campaigns (name, type, scheduled_at, script_prompt, status, created_by)
             VALUES ($1,$2,$3,$4,'draft',$5) RETURNING *`,
            [name, type, scheduled_at || null, script_prompt || null, req.user.id]
        );
        res.status(201).json(campaign);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/voice/campaigns/:id/upload — carga Excel de contactos
router.post('/:id/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No se envió archivo' });

    let workbook;
    try {
        workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    } catch {
        return res.status(400).json({ error: 'Archivo Excel inválido' });
    }

    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);
    if (!rows.length) return res.status(400).json({ error: 'El archivo está vacío' });

    // Flexible column name matching (case-insensitive)
    const get = (row, ...keys) => keys.map(k =>
        row[k] || row[k.toLowerCase()] || row[k.toUpperCase()] || row[k.charAt(0).toUpperCase() + k.slice(1)]
    ).find(v => v != null) ?? null;

    const contacts = rows.map(row => ({
        campaign_id: req.params.id,
        name: get(row, 'Nombre', 'nombre', 'Name', 'name'),
        phone: String(get(row, 'Telefono', 'Teléfono', 'teléfono', 'Phone', 'phone', 'Celular') || ''),
        property_address: get(row, 'Dirección', 'Direccion', 'direccion', 'Dirección Propiedad', 'address'),
        debt_amount: parseFloat(get(row, 'Monto', 'monto', 'Deuda', 'deuda', 'Amount') || 0) || null,
        debt_months: parseInt(get(row, 'Meses', 'meses', 'Months') || 0) || null,
        manager_name: get(row, 'Agente', 'agente', 'Administrador', 'Manager', 'Encargado'),
        manager_phone: get(row, 'Teléfono Agente', 'telefono agente', 'Tel Agente', 'Manager Phone'),
        additional_data: row,
    })).filter(c => c.name && c.phone);

    if (!contacts.length) return res.status(400).json({ error: 'No se encontraron filas válidas (requiere columnas Nombre y Telefono)' });

    // Bulk insert
    const values = contacts.map((c, i) => {
        const base = i * 9;
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9})`;
    }).join(',');
    const flat = contacts.flatMap(c => [
        c.campaign_id, c.name, c.phone, c.property_address,
        c.debt_amount, c.debt_months, c.manager_name, c.manager_phone,
        JSON.stringify(c.additional_data)
    ]);

    await pool.query(
        `INSERT INTO campaign_contacts (campaign_id,name,phone,property_address,debt_amount,debt_months,manager_name,manager_phone,additional_data) VALUES ${values}`,
        flat
    );

    res.json({ imported: contacts.length, skipped: rows.length - contacts.length });
});

// POST /api/voice/campaigns/:id/start — inicia campaña
router.post('/:id/start', async (req, res) => {
    const { rows: [campaign] } = await pool.query('SELECT * FROM outbound_campaigns WHERE id = $1', [req.params.id]);
    if (!campaign) return res.status(404).json({ error: 'Campaña no encontrada' });
    if (campaign.status === 'running') return res.status(400).json({ error: 'La campaña ya está en ejecución' });

    await pool.query(`UPDATE outbound_campaigns SET status = 'running' WHERE id = $1`, [req.params.id]);

    const { rows: contacts } = await pool.query(
        `SELECT * FROM campaign_contacts WHERE campaign_id = $1 AND call_status = 'pending'`,
        [req.params.id]
    );

    res.json({ started: true, contacts_to_call: contacts.length });

    // Fire-and-forget campaign execution
    runCampaignCalls(campaign, contacts).catch(err =>
        logErrorToSlack('error', { category: 'voice-agent', action: 'campaign.run', message: err.message })
    );
});

// POST /api/voice/call — llamada outbound manual individual
router.post('/call', async (req, res) => {
    const { phone, name, notes } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone es requerido' });
    try {
        const call = await createOutboundCall({ toPhone: phone, metadata: { contact_name: name, notes, manual: true } });
        res.json({ call_id: call.call_id, status: call.call_status });
    } catch (err) {
        logErrorToSlack('error', { category: 'voice-agent', action: 'manual.call', message: err.message });
        res.status(500).json({ error: err.message });
    }
});

async function runCampaignCalls(campaign, contacts) {
    let answered = 0;
    for (const contact of contacts) {
        try {
            await createOutboundCall({
                toPhone: contact.phone,
                metadata: {
                    campaign_id: campaign.id,
                    contact_id: contact.id,
                    contact_name: contact.name,
                    property_address: contact.property_address,
                    debt_amount: contact.debt_amount,
                    debt_months: contact.debt_months,
                    manager_name: contact.manager_name,
                }
            });
            await pool.query(`UPDATE campaign_contacts SET call_status = 'called' WHERE id = $1`, [contact.id]);
            answered++;
        } catch (err) {
            await pool.query(`UPDATE campaign_contacts SET call_status = 'failed' WHERE id = $1`, [contact.id]);
            logErrorToSlack('warning', { category: 'voice-agent', action: 'campaign.call_failed', message: `${contact.phone}: ${err.message}` });
        }
        // 10 second gap between calls
        await new Promise(r => setTimeout(r, 10_000));
    }
    await pool.query(
        `UPDATE outbound_campaigns SET status = 'completed', calls_made = $2, calls_answered = $3, completed_at = NOW() WHERE id = $1`,
        [campaign.id, contacts.length, answered]
    );
}

export { runCampaignCalls };
export default router;
