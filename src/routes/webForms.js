import express from 'express';
import pool from '../lib/db.js';
import { logErrorToSlack } from '../middleware/slackErrorLogger.js';

const router = express.Router();

const FORM_SECRET = process.env.WEB_FORM_SECRET || 'remax-web-forms-2026';

// ============================================================
// POST /api/webhooks/web-forms — Custom forms from website
// ============================================================
router.post('/web-forms', async (req, res) => {
    try {
        // Validate secret
        const secret = req.headers['x-wf-secret'];
        if (secret !== FORM_SECRET) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const body = req.body;
        const formType = body.form_type;

        if (formType === 'vender') {
            const result = await processVenderForm(body);
            return res.json({ success: true, ...result });
        }

        // Future: buscar, hazte-agente
        return res.status(400).json({ error: `Unknown form_type: ${formType}` });
    } catch (error) {
        console.error('Web form webhook error:', error);
        logErrorToSlack('error', {
            category: 'web-forms',
            action: 'webhook.error',
            message: error.message,
            module: 'web-forms',
            details: { stack: error.stack?.substring(0, 500) },
        });
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// Process "Vender/Arrendar" form
// Creates: contact → property → external_lead → shift_guard_lead
// ============================================================
async function processVenderForm(data) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Create contact
        const { rows: [contact] } = await client.query(`
            INSERT INTO contacts (
                id, agent_id, first_name, last_name, email, phone,
                source, source_detail, need, status, address, barrio_comuna
            ) VALUES (
                gen_random_uuid(),
                (SELECT id FROM profiles WHERE role = 'comercial' LIMIT 1),
                $1, $2, $3, $4,
                'Web - Vender', 'Formulario web remax-exclusive.cl',
                $5, 'Nuevo', $6, $7
            ) RETURNING id
        `, [
            data.first_name || '',
            data.last_name || '',
            data.email || null,
            data.phone || null,
            mapNeed(data.operation_type),
            data.address || null,
            data.commune || null,
        ]);

        // 2. Create property (linked to contact as owner)
        const { rows: [property] } = await client.query(`
            INSERT INTO properties (
                id, owner_id, property_type, address, commune,
                latitude, longitude, m2_total, m2_built,
                bedrooms, bathrooms, parking_spaces, year_built,
                operation_type, source, notes
            ) VALUES (
                gen_random_uuid(), $1, $2, $3, $4,
                $5, $6, $7, $8,
                $9, $10, $11, $12,
                $13, 'Web - Formulario Vender', $14
            ) RETURNING id
        `, [
            contact.id,
            data.property_type || null,
            data.address || null,
            data.commune || null,
            data.latitude || null,
            data.longitude || null,
            data.m2_total || null,
            data.m2_built || null,
            data.bedrooms || null,
            data.bathrooms || null,
            data.parking_spaces ? String(data.parking_spaces) : null,
            data.year_built || null,
            data.operation_type || null,
            data.observations || null,
        ]);

        // 3. Create external_lead (raw data backup)
        const { rows: [extLead] } = await client.query(`
            INSERT INTO external_leads (id, raw_data, status, short_id)
            VALUES (gen_random_uuid(), $1, 'pending', $2)
            RETURNING id
        `, [
            JSON.stringify([{
                'Datos Contacto': {
                    nombre_apellido: `${data.first_name} ${data.last_name}`,
                    email: data.email,
                    telefono: data.phone,
                },
                'Datos Propiedad': {
                    tipo_operacion: data.operation_type,
                    tipo_propiedad: data.property_type,
                    direccion: data.address,
                    comuna: data.commune,
                    m2_total: data.m2_total,
                    dormitorios: data.bedrooms,
                    banos: data.bathrooms,
                },
                'Fuente': 'Web - Formulario Vender',
            }]),
            `WEB-${Date.now().toString(36).toUpperCase()}`,
        ]);

        // 4. Create shift_guard_lead (for commercial team to assign)
        await client.query(`
            INSERT INTO shift_guard_leads (
                id, external_lead_id, contact_id, assigned_at, is_guard,
                agent_id
            ) VALUES (
                gen_random_uuid(), $1, $2, NOW(), false,
                (SELECT id FROM profiles WHERE role = 'comercial' LIMIT 1)
            )
        `, [extLead.id, contact.id]);

        await client.query('COMMIT');

        // 5. Notify Slack
        logErrorToSlack('info', {
            category: 'web-forms',
            action: 'lead.created',
            message: `🏠 Nuevo lead Web: ${data.first_name} ${data.last_name} — ${data.operation_type} ${data.property_type} en ${data.commune || data.address}`,
            module: 'web-forms',
            details: {
                contactId: contact.id,
                propertyId: property.id,
                email: data.email,
                phone: data.phone,
                address: data.address,
            },
        });

        return {
            contactId: contact.id,
            propertyId: property.id,
            externalLeadId: extLead.id,
        };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

function mapNeed(operationType) {
    if (!operationType) return 'Vender';
    if (operationType.toLowerCase().includes('arriendo')) return 'Arrendar';
    if (operationType.toLowerCase().includes('ambos') || operationType.toLowerCase().includes('y')) return 'Vender y Arrendar';
    return 'Vender';
}

export default router;
