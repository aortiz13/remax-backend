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

        if (formType === 'comprar') {
            const result = await processComprarForm(body);
            return res.json({ success: true, ...result });
        }

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

        // 2b. Link contact ↔ property in junction table (CRM relationship)
        await client.query(`
            INSERT INTO property_contacts (id, property_id, contact_id, role, agent_id)
            VALUES (
                gen_random_uuid(), $1, $2, 'propietario',
                (SELECT id FROM profiles WHERE role = 'comercial' LIMIT 1)
            )
        `, [property.id, contact.id]);

        // 3. Create external_lead (raw data backup)
        const { rows: [extLead] } = await client.query(`
            INSERT INTO external_leads (id, raw_data, status, short_id)
            VALUES (gen_random_uuid(), $1, 'pending', $2)
            RETURNING id, short_id
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

        // 5. Timeline: log lead creation event
        await client.query(`
            INSERT INTO activity_logs (id, actor_id, action, entity_type, entity_id, description, details, property_id, contact_id)
            VALUES (
                gen_random_uuid(),
                (SELECT id FROM profiles WHERE role = 'comercial' LIMIT 1),
                'Lead Recibido',
                'ExternalLead',
                $1,
                $2,
                $3,
                $4,
                $5
            )
        `, [
            extLead.id,
            `Nuevo lead desde Formulario Web — ${data.operation_type || 'Venta'} ${data.property_type || ''} en ${data.commune || data.address || ''}`,
            JSON.stringify({
                source: 'Formulario Web',
                operation_type: data.operation_type,
                property_type: data.property_type,
                address: data.address,
                commune: data.commune,
                short_id: extLead.short_id,
            }),
            property.id,
            contact.id,
        ]);

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
            shortId: extLead.short_id,
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

function mapNeedComprar(operationType) {
    if (!operationType) return 'Comprar';
    if (operationType.toLowerCase().includes('arriendo')) return 'Arrendar';
    return 'Comprar';
}

// ============================================================
// Process "Comprar/Buscar" form
// Creates: contact → external_lead → shift_guard_lead + activity_log
// ============================================================
async function processComprarForm(data) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Create contact
        const { rows: [contact] } = await client.query(`
            INSERT INTO contacts (
                id, agent_id, first_name, last_name, email, phone,
                source, source_detail, need, status, barrio_comuna
            ) VALUES (
                gen_random_uuid(),
                (SELECT id FROM profiles WHERE role = 'comercial' LIMIT 1),
                $1, $2, $3, $4,
                'Web - Buscar Inmueble', 'Formulario web buscar-inmueble',
                $5, 'Nuevo', $6
            ) RETURNING id
        `, [
            data.first_name || '',
            data.last_name || '',
            data.email || null,
            data.phone || null,
            mapNeedComprar(data.operation_type),
            data.zone || null,
        ]);

        // 2. Create external_lead
        const { rows: [extLead] } = await client.query(`
            INSERT INTO external_leads (id, raw_data, status, short_id)
            VALUES (gen_random_uuid(), $1, 'pending', $2)
            RETURNING id, short_id
        `, [
            JSON.stringify([{
                'Datos Contacto': {
                    nombre_apellido: `${data.first_name} ${data.last_name}`,
                    email: data.email,
                    telefono: data.phone,
                },
                'Búsqueda': {
                    tipo_operacion: data.operation_type,
                    tipo_propiedad: data.property_type,
                    presupuesto_maximo: data.max_budget,
                    zona: data.zone,
                    dormitorios: data.bedrooms,
                    banos: data.bathrooms,
                    amenities: data.amenities,
                },
                'Fuente': 'Web - Formulario Buscar Inmueble',
            }]),
            `WEB-${Date.now().toString(36).toUpperCase()}`,
        ]);

        // 3. Create shift_guard_lead
        await client.query(`
            INSERT INTO shift_guard_leads (
                id, external_lead_id, contact_id, assigned_at, is_guard,
                agent_id
            ) VALUES (
                gen_random_uuid(), $1, $2, NOW(), false,
                (SELECT id FROM profiles WHERE role = 'comercial' LIMIT 1)
            )
        `, [extLead.id, contact.id]);

        // 4. Timeline: log lead creation
        await client.query(`
            INSERT INTO activity_logs (id, actor_id, action, entity_type, entity_id, description, details, contact_id)
            VALUES (
                gen_random_uuid(),
                (SELECT id FROM profiles WHERE role = 'comercial' LIMIT 1),
                'Lead Recibido',
                'ExternalLead',
                $1,
                $2,
                $3,
                $4
            )
        `, [
            extLead.id,
            `Nuevo lead desde Formulario Web — Busca ${data.operation_type || 'Comprar'} ${data.property_type || ''} en ${data.zone || 'Sin zona'}`,
            JSON.stringify({
                source: 'Formulario Web - Buscar Inmueble',
                operation_type: data.operation_type,
                property_type: data.property_type,
                zone: data.zone,
                max_budget: data.max_budget,
                bedrooms: data.bedrooms,
                bathrooms: data.bathrooms,
                amenities: data.amenities,
                short_id: extLead.short_id,
            }),
            contact.id,
        ]);

        await client.query('COMMIT');

        // 5. Notify Slack
        logErrorToSlack('info', {
            category: 'web-forms',
            action: 'comprar.submitted',
            message: `🔍 Nuevo lead Buscar Inmueble: ${data.first_name} ${data.last_name} — ${data.operation_type} ${data.property_type} en ${data.zone || 'Sin zona'}`,
            module: 'web-forms',
            details: {
                contactId: contact.id,
                email: data.email,
                phone: data.phone,
                zone: data.zone,
                max_budget: data.max_budget,
            },
        });

        // 6. Notify n8n → WhatsApp Staff Comercial
        const FORMS_URL = process.env.FORMS_URL || 'https://forms.remax-exclusive.cl';
        const amenityLabels = {
            parking: 'Estacionamiento', garden: 'Jardín', pool: 'Piscina',
            elevator: 'Ascensor', terrace: 'Terraza', gym: 'Gimnasio',
            storage: 'Bodega', security: 'Conserje',
        };
        const amenitiesStr = (data.amenities || []).map(a => amenityLabels[a] || a).join(', ');
        try {
            await fetch('https://workflow.remax-exclusive.cl/webhook/nuevo_lead_buscar', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    nombre: `${data.first_name} ${data.last_name}`.trim(),
                    telefono: data.phone || '',
                    email: data.email || '',
                    operacion: data.operation_type || 'Compra',
                    tipo_propiedad: data.property_type || '',
                    presupuesto: data.max_budget || '',
                    zona: data.zone || '',
                    dormitorios: data.bedrooms || '',
                    banos: data.bathrooms || '',
                    amenities: amenitiesStr,
                    lead_link: `${FORMS_URL}/lead/${extLead.short_id}`,
                }),
            });
        } catch (n8nErr) {
            console.error('n8n buscar webhook call failed:', n8nErr.message);
        }

        return {
            contactId: contact.id,
            externalLeadId: extLead.id,
            shortId: extLead.short_id,
        };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

// ============================================================
// GET /api/webhooks/web-forms/lead/:shortId — Public lead page
// ============================================================
router.get('/web-forms/lead/:shortId', async (req, res) => {
    try {
        const { shortId } = req.params;

        // Get external_lead
        const { rows: [lead] } = await pool.query(`
            SELECT el.id, el.raw_data, el.status, el.short_id, el.created_at, el.assigned_agent_id,
                   p_agent.first_name AS assigned_first, p_agent.last_name AS assigned_last,
                   p_agent.email AS assigned_email
            FROM external_leads el
            LEFT JOIN profiles p_agent ON el.assigned_agent_id = p_agent.id
            WHERE el.short_id = $1
        `, [shortId]);

        if (!lead) return res.status(404).json({ error: 'Lead not found' });

        // Get linked contact + property via shift_guard_leads
        const { rows: [sgl] } = await pool.query(`
            SELECT sgl.contact_id, sgl.agent_id, sgl.is_guard
            FROM shift_guard_leads sgl
            WHERE sgl.external_lead_id = $1
            LIMIT 1
        `, [lead.id]);

        let contact = null;
        let property = null;

        if (sgl?.contact_id) {
            const { rows: [c] } = await pool.query(
                `SELECT id, first_name, last_name, email, phone, address, barrio_comuna, need, source FROM contacts WHERE id = $1`,
                [sgl.contact_id]
            );
            contact = c;

            // Get property linked to this contact
            const { rows: [p] } = await pool.query(`
                SELECT p.id, p.property_type, p.address, p.commune, p.operation_type,
                       p.bedrooms, p.bathrooms, p.parking_spaces, p.m2_total, p.m2_built,
                       p.latitude, p.longitude, p.notes
                FROM properties p
                WHERE p.owner_id = $1
                ORDER BY p.created_at DESC LIMIT 1
            `, [sgl.contact_id]);
            property = p;
        }

        res.json({
            lead: {
                id: lead.id,
                shortId: lead.short_id,
                status: lead.status,
                createdAt: lead.created_at,
                rawData: lead.raw_data,
                assigned: lead.assigned_agent_id ? {
                    agentId: lead.assigned_agent_id,
                    name: `${lead.assigned_first} ${lead.assigned_last}`,
                    email: lead.assigned_email,
                } : null,
            },
            contact,
            property,
        });
    } catch (error) {
        console.error('Get lead error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// GET /api/webhooks/web-forms/agents — List agents for dropdown
// ============================================================
router.get('/web-forms/agents', async (_req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT id, first_name, last_name, email
            FROM profiles
            WHERE role = 'agent'
            ORDER BY first_name
        `);

        // Add RE/MAX Chile option
        const agents = [
            ...rows.map(r => ({
                id: r.id,
                name: `${r.first_name} ${r.last_name}`,
                email: r.email,
            })),
            { id: 'remax-chile', name: 'RE/MAX Chile (Regional)', email: 'regional@remax.cl' },
        ];

        res.json({ agents });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// POST /api/webhooks/web-forms/lead/:shortId/assign — Derive lead
// ============================================================
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://workflow.remax-exclusive.cl/webhook/recibir_datos';

router.post('/web-forms/lead/:shortId/assign', async (req, res) => {
    try {
        const { shortId } = req.params;
        const { agentEmail, agentId } = req.body;

        if (!agentEmail) return res.status(400).json({ error: 'agentEmail is required' });

        // Get lead
        const { rows: [lead] } = await pool.query(
            `SELECT id, raw_data, status, assigned_agent_id FROM external_leads WHERE short_id = $1`,
            [shortId]
        );
        if (!lead) return res.status(404).json({ error: 'Lead not found' });
        if (lead.assigned_agent_id) return res.status(409).json({ error: 'Lead already assigned' });

        // Update external_lead status
        const realAgentId = agentId === 'remax-chile' ? null : agentId;
        await pool.query(
            `UPDATE external_leads SET status = 'assigned', assigned_agent_id = $1 WHERE id = $2`,
            [realAgentId, lead.id]
        );

        // Get contact + property for payload
        const { rows: [sgl] } = await pool.query(
            `SELECT contact_id FROM shift_guard_leads WHERE external_lead_id = $1 LIMIT 1`,
            [lead.id]
        );
        let contact = null;
        let property = null;
        if (sgl?.contact_id) {
            const { rows: [c] } = await pool.query(
                `SELECT first_name, last_name, email, phone FROM contacts WHERE id = $1`,
                [sgl.contact_id]
            );
            contact = c;
            const { rows: [p] } = await pool.query(
                `SELECT property_type, address, commune, operation_type, bedrooms, bathrooms FROM properties WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 1`,
                [sgl.contact_id]
            );
            property = p;
        }

        // Build n8n payload
        const FORMS_URL = process.env.FORMS_URL || 'https://forms.remax-exclusive.cl';
        const n8nPayload = {
            agent: { email: agentEmail },
            lead_data: [{
                'Datos Contacto': {
                    nombre_apellido: contact ? `${contact.first_name} ${contact.last_name}` : '',
                    telefono: contact?.phone || '',
                    correo: contact?.email || '',
                },
                'Datos Propiedad': {
                    tipo_inmueble: property?.property_type || '',
                    direccion_propiedad: property?.address || '',
                    habitaciones: property?.bedrooms || '',
                    banos: property?.bathrooms || '',
                },
                'Tipo de transacción': property?.operation_type || 'Venta',
                'Fuente': agentId === 'remax-chile' ? 'Lead Derivado' : 'Guardia',
            }],
            lead_link: `${FORMS_URL}/lead/${shortId}`,
        };

        // Call n8n webhook
        try {
            await fetch(N8N_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(n8nPayload),
            });
        } catch (n8nErr) {
            console.error('n8n webhook call failed:', n8nErr.message);
            // Don't fail the whole request — assignment is already done
        }

        // If real agent, also update shift_guard_lead
        if (realAgentId && sgl?.contact_id) {
            await pool.query(
                `UPDATE shift_guard_leads SET agent_id = $1, is_guard = true WHERE external_lead_id = $2`,
                [realAgentId, lead.id]
            );
            // Update contact owner + source
            await pool.query(
                `UPDATE contacts SET agent_id = $1, source = 'Guardia' WHERE id = $2`,
                [realAgentId, sgl.contact_id]
            );
        } else if (agentId === 'remax-chile' && sgl?.contact_id) {
            // Update contact source for regional
            await pool.query(
                `UPDATE contacts SET source = 'Lead Derivado' WHERE id = $1`,
                [sgl.contact_id]
            );
        }

        logErrorToSlack('info', {
            category: 'web-forms',
            action: 'lead.assigned',
            message: `📤 Lead ${shortId} derivado a ${agentEmail}`,
            module: 'web-forms',
            details: { shortId, agentEmail, agentId },
        });

        // Timeline: log assignment event
        const assignedName = agentId === 'remax-chile' ? 'RE/MAX Chile (Regional)' : agentEmail;
        if (sgl?.contact_id) {
            await pool.query(`
                INSERT INTO activity_logs (id, actor_id, action, entity_type, entity_id, description, details, contact_id)
                VALUES (
                    gen_random_uuid(),
                    $1,
                    'Lead Derivado',
                    'ExternalLead',
                    $2,
                    $3,
                    $4,
                    $5
                )
            `, [
                realAgentId || (await pool.query(`SELECT id FROM profiles WHERE role = 'comercial' LIMIT 1`)).rows[0]?.id,
                lead.id,
                `Lead derivado a ${assignedName}`,
                JSON.stringify({
                    assigned_to: agentEmail,
                    assigned_agent_id: agentId,
                    short_id: shortId,
                    source: 'Formulario Web',
                }),
                sgl.contact_id,
            ]);
        }

        res.json({ success: true, assigned: agentEmail });
    } catch (error) {
        console.error('Assign lead error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// POST /api/webhooks/whatsapp-leads — WhatsApp Bot Leads (n8n)
// ============================================================
router.post('/whatsapp-leads', async (req, res) => {
    try {
        const {
            source = 'WhatsApp',
            conversation_id,
            phone,
            contact: contactData,
            property: propertyData,
            url_propiedad,
            resumen,
        } = req.body;

        const shortId = `WA-${Date.now().toString(36).toUpperCase()}`;
        const FORMS_URL = process.env.FORMS_URL || 'https://solicitudes.remax-exclusive.cl';

        // Build raw_data in the same format as web leads
        const rawData = [{
            'Datos Contacto': {
                nombre_apellido: contactData?.nombre
                    ? `${contactData.nombre} ${contactData.apellido || ''}`.trim()
                    : null,
                correo: contactData?.email || null,
                telefono: contactData?.telefono || phone || null,
            },
            'Datos Propiedad': {
                tipo_transaccion: propertyData?.tipo_transaccion || null,
                tipo_inmueble: propertyData?.tipo_inmueble || null,
                direccion_propiedad: propertyData?.direccion || null,
                habitaciones: propertyData?.habitaciones || null,
                banos: propertyData?.banos || null,
                superficie_m2: propertyData?.superficie_total_m2 || propertyData?.superficie_m2 || null,
                presupuesto: propertyData?.presupuesto_estimado || propertyData?.presupuesto || null,
            },
            'Fuente': source,
            'URL Propiedad': url_propiedad || null,
            'Resumen': resumen || null,
        }];

        // ── "Ver Agente" → lightweight registration only ──
        if (source === 'WhatsApp - Ver Agente') {
            const { rows: [extLead] } = await pool.query(`
                INSERT INTO external_leads (id, raw_data, status, short_id, source, conversation_id)
                VALUES (gen_random_uuid(), $1, 'pending', $2, $3, $4)
                RETURNING id, short_id
            `, [JSON.stringify(rawData), shortId, source, conversation_id || null]);

            logErrorToSlack('info', {
                category: 'whatsapp-leads',
                action: 'lead.ver_agente',
                message: `📱 WhatsApp Lead (Ver Agente): ${contactData?.telefono || phone || 'Sin teléfono'}`,
                module: 'whatsapp-leads',
                details: { leadId: extLead.id, shortId, url_propiedad },
            });

            return res.json({
                success: true,
                leadId: extLead.id,
                shortId: extLead.short_id,
            });
        }

        // ── "Calificado" → full flow (contact + shift_guard_lead + derivation) ──
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // 1. Create contact
            const firstName = contactData?.nombre || '';
            const lastName = contactData?.apellido || '';
            const fullName = `${firstName} ${lastName}`.trim();

            const { rows: [newContact] } = await client.query(`
                INSERT INTO contacts (
                    id, agent_id, first_name, last_name, email, phone,
                    source, source_detail, need, status
                ) VALUES (
                    gen_random_uuid(),
                    (SELECT id FROM profiles WHERE role = 'comercial' LIMIT 1),
                    $1, $2, $3, $4,
                    'WhatsApp Bot', $5,
                    $6, 'Nuevo'
                ) RETURNING id
            `, [
                firstName || fullName,
                lastName,
                contactData?.email || null,
                contactData?.telefono || phone || null,
                `Calificado vía WhatsApp Bot - Conv #${conversation_id || 'N/A'}`,
                mapNeedFromTransaction(propertyData?.tipo_transaccion),
            ]);

            // 2. Create external_lead
            const { rows: [extLead] } = await client.query(`
                INSERT INTO external_leads (id, raw_data, status, short_id, source, conversation_id)
                VALUES (gen_random_uuid(), $1, 'pending', $2, $3, $4)
                RETURNING id, short_id
            `, [JSON.stringify(rawData), shortId, source, conversation_id || null]);

            // 3. Create shift_guard_lead (for admin to assign)
            await client.query(`
                INSERT INTO shift_guard_leads (
                    id, external_lead_id, contact_id, assigned_at, is_guard,
                    agent_id
                ) VALUES (
                    gen_random_uuid(), $1, $2, NOW(), false,
                    (SELECT id FROM profiles WHERE role = 'comercial' LIMIT 1)
                )
            `, [extLead.id, newContact.id]);

            // 4. Timeline: log lead creation
            await client.query(`
                INSERT INTO activity_logs (id, actor_id, action, entity_type, entity_id, description, details, contact_id)
                VALUES (
                    gen_random_uuid(),
                    (SELECT id FROM profiles WHERE role = 'comercial' LIMIT 1),
                    'Lead Recibido',
                    'ExternalLead',
                    $1,
                    $2,
                    $3,
                    $4
                )
            `, [
                extLead.id,
                `Nuevo lead WhatsApp Bot — ${propertyData?.tipo_transaccion || ''} ${propertyData?.tipo_inmueble || ''} en ${propertyData?.direccion || ''}`.trim(),
                JSON.stringify({
                    source: 'WhatsApp Bot',
                    tipo_transaccion: propertyData?.tipo_transaccion,
                    tipo_inmueble: propertyData?.tipo_inmueble,
                    short_id: extLead.short_id,
                    conversation_id,
                }),
                newContact.id,
            ]);

            await client.query('COMMIT');

            const leadLink = `${FORMS_URL}/nuevolead/${extLead.short_id}`;

            logErrorToSlack('info', {
                category: 'whatsapp-leads',
                action: 'lead.calificado',
                message: `📱✅ WhatsApp Lead Calificado: ${fullName || phone} — ${propertyData?.tipo_transaccion || ''} ${propertyData?.tipo_inmueble || ''}`,
                module: 'whatsapp-leads',
                details: {
                    leadId: extLead.id,
                    shortId: extLead.short_id,
                    contactId: newContact.id,
                    leadLink,
                },
            });

            return res.json({
                success: true,
                leadId: extLead.id,
                shortId: extLead.short_id,
                contactId: newContact.id,
                lead_link: leadLink,
            });

        } catch (txError) {
            await client.query('ROLLBACK');
            throw txError;
        } finally {
            client.release();
        }

    } catch (error) {
        console.error('WhatsApp lead webhook error:', error);
        logErrorToSlack('error', {
            category: 'whatsapp-leads',
            action: 'lead.webhook_error',
            message: error.message,
            module: 'whatsapp-leads',
            details: { stack: error.stack?.substring(0, 500) },
        });
        res.status(500).json({ error: error.message });
    }
});

function mapNeedFromTransaction(tipo) {
    if (!tipo) return 'Otro';
    const t = tipo.toUpperCase();
    if (t === 'VENDEDOR') return 'Vender';
    if (t === 'ARRENDADOR') return 'Arrendar';
    if (t === 'COMPRADOR') return 'Comprar';
    if (t === 'ARRENDATARIO') return 'Arrendar';
    return 'Otro';
}

export default router;
