import express from 'express';
import pool from '../lib/db.js';
import { logErrorToSlack } from '../middleware/slackErrorLogger.js';
import { recruitmentEmailQueue, recruitmentWhatsappQueue } from '../queues/index.js';
import { uploadFile } from '../lib/storage.js';
import { resolveCalendarEventVars } from '../lib/calendarVariables.js';
import { isChatwootConfigured, getChatwootPublicConfig } from '../services/chatwootService.js';
import Busboy from 'busboy';
import crypto from 'crypto';

const router = express.Router();

// ============================================================
// Helpers (ported from n8n Code nodes)
// ============================================================

function cleanPhone(phoneText) {
    if (!phoneText) return '';
    let cleaned = phoneText.replace(/\b(Chile|Argentina|Peru|Mexico|Colombia|España|Spain)\b/gi, '');
    cleaned = cleaned.replace(/\D/g, '');
    // Remove duplicate country prefixes
    const prefijos = ['5656', '5454', '5151', '5252', '5757'];
    for (const p of prefijos) {
        if (cleaned.startsWith(p) && cleaned.length > 11) {
            cleaned = cleaned.substring(2);
            break;
        }
    }
    return cleaned;
}

function cleanText(text) {
    if (!text) return '';
    return text
        .replace(/&NoBreak;/gi, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&iquest;/gi, '¿')
        .replace(/&iacute;/gi, 'í').replace(/&aacute;/gi, 'á').replace(/&eacute;/gi, 'é')
        .replace(/&oacute;/gi, 'ó').replace(/&uacute;/gi, 'ú').replace(/&ntilde;/gi, 'ñ')
        .replace(/&Ntilde;/gi, 'Ñ').replace(/&mldr;/gi, '...')
        .replace(/&#225;/g, 'á').replace(/&#233;/g, 'é').replace(/&#237;/g, 'í')
        .replace(/&#243;/g, 'ó').replace(/&#250;/g, 'ú').replace(/&#241;/g, 'ñ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanPhoneNumber(phone) {
    if (!phone) return null;
    let c = phone.replace(/-/g, '');
    const prefijosLatam = ['52','53','54','55','56','57','58','591','592','593','594','595','596','597','598','506','507','503','504','505','502'];
    for (const p of prefijosLatam) {
        const pat = new RegExp(`^(${p})(${p})(\\d+)$`);
        if (pat.test(c)) { c = c.replace(pat, `$1$3`); break; }
    }
    return c;
}

async function verifyWhatsApp(phone) {
    if (!phone) return false;
    try {
        const res = await fetch('https://api.remax-exclusive.cl/chat/whatsappNumbers/Remax%20Exclusive', {
            method: 'POST',
            headers: { apikey: 'A47DF197AC02-4F21-BEB4-9F3485E5E4EB', 'Content-Type': 'application/json' },
            body: JSON.stringify({ numbers: [phone] }),
        });
        const data = await res.json();
        return data?.exists === true || (Array.isArray(data) && data[0]?.exists === true);
    } catch { return false; }
}

async function checkDuplicate(email) {
    if (!email) return null;
    const { rows } = await pool.query(
        `SELECT id FROM recruitment_candidates WHERE LOWER(email) = LOWER($1) LIMIT 1`,
        [email]
    );
    return rows[0]?.id || null;
}

// ============================================================
// Computrabajo HTML Parser (ported from n8n "purgar" node)
// ============================================================
function parseComputrabajo(html) {
    const c = {
        nombreCompleto: null, urlFotografia: null, titulo: null, resumen: null,
        email: null, telefono: null, identificacion: null, ubicacion: null,
        edad: null, salarioNetoMensual: null, noTengoEmpleo: false,
        carnetConducir: false, vehiculoPropio: false, disponibilidadViajar: false,
        disponibilidadCambioResidencia: false, experienciaProfesional: [],
        formacion: [], habilidades: [], idiomas: [], profileLink: null,
    };

    // Profile link
    const oiM = html.match(/IdOfferEncrypted:\s*'([^']+)'/);
    const imsM = html.match(/MatchDetail\?oi=[^&]+&amp;ims=([^&]+)/);
    const cfM = html.match(/MatchDetail\?oi=[^&]+&amp;ims=[^&]+&amp;cf=([^"]+)/);
    if (oiM && imsM && cfM) {
        const domM = html.match(/https?:\/\/(empresa\.[^/]+\.computrabajo\.com)/);
        const dom = domM ? domM[1] : 'empresa.cl.computrabajo.com';
        c.profileLink = `https://${dom}/Company/MatchCvDetail/MatchDetail?oi=${oiM[1]}&ims=${imsM[1]}&cf=${cfM[1]}`;
    }

    const nombreM = html.match(/Currículum de\s+([^<\n]+)/);
    if (nombreM) c.nombreCompleto = cleanText(nombreM[1]);

    const fotoM = html.match(/photo_cand[\s\S]{0,300}?<img src="(https:\/\/[^"]+)"/);
    if (fotoM) c.urlFotografia = fotoM[1];

    const titM = html.match(/<div class="bb1 pbB">[\s\S]*?<h2[^>]*>([^<]+)<\/h2>\s*<p>([^<]+)<\/p>[\s\S]*?<\/div>/);
    if (titM) { c.titulo = cleanText(titM[1]); c.resumen = cleanText(titM[2]); }

    const emailM = html.match(/[\w.-]+@[\w.-]+\.\w+/);
    if (emailM) c.email = emailM[0];

    const telM = html.match(/(\d{2,3}-\d{8,11})/);
    if (telM) c.telefono = cleanPhoneNumber(telM[1]);

    const idM = html.match(/i_card[^>]*>[\s\S]{0,100}?<span[^>]*>([\d\s.-]+)<\/span>/);
    if (idM) c.identificacion = idM[1].replace(/[\s.-]/g, '');

    const ubM = html.match(/i_flag[^>]*>[\s\S]{0,200}?<span[^>]*>([^<]+)<\/span>/);
    if (ubM) c.ubicacion = cleanText(ubM[1]);

    const edM = html.match(/(\d+)\s+años/);
    if (edM) c.edad = parseInt(edM[1], 10);

    const salM = html.match(/Neto\/Mensual\s*\$\s*([\d,.]+)/);
    if (salM) c.salarioNetoMensual = `$ ${salM[1]}`;

    c.noTengoEmpleo = !!html.match(/<li>[\s\S]{0,100}?i_yes[\s\S]{0,100}?No tengo empleo/);
    const carM = html.match(/i_(yes|no)[\s\S]{0,100}?Carnet de conducir/);
    if (carM) c.carnetConducir = carM[1] === 'yes';
    const vehM = html.match(/i_(yes|no)[\s\S]{0,100}?Vehículo propio/);
    if (vehM) c.vehiculoPropio = vehM[1] === 'yes';
    const viaM = html.match(/i_(yes|no)[\s\S]{0,100}?Disponibilidad para viajar/);
    if (viaM) c.disponibilidadViajar = viaM[1] === 'yes';
    const resM = html.match(/i_(yes|no)[\s\S]{0,100}?Disponibilidad para cambio de residencia/);
    if (resM) c.disponibilidadCambioResidencia = resM[1] === 'yes';

    // Experience
    const expSec = html.match(/<h2[^>]*>Experiencia profesional<\/h2>[\s\S]*?<\/ul>/);
    if (expSec) {
        for (const item of expSec[0].matchAll(/<li>([\s\S]*?)<\/li>/g)) {
            const h = item[1];
            const per = h.match(/w20[\s\S]{0,200}?<\/div>/)?.[0]; 
            const puesto = h.match(/<span class="fwB">([^<]+)<\/span>/)?.[1];
            const empresa = h.match(/fc_aux list_dot[\s\S]*?<span>([^<]+)<\/span>/)?.[1];
            const desc = h.match(/Descripción de funciones:\s*([^<]+)</)?.[1];
            if (puesto || empresa) {
                c.experienciaProfesional.push({
                    puesto: cleanText(puesto), empresa: cleanText(empresa),
                    periodo: cleanText(per), descripcion: cleanText(desc),
                });
            }
        }
    }

    // Education
    const formSec = html.match(/<h2[^>]*>Formación<\/h2>[\s\S]*?<ul class="list_timeline small">([\s\S]*?)<\/ul>/);
    if (formSec) {
        for (const item of formSec[1].matchAll(/<li>([\s\S]*?)<\/li>/g)) {
            const h = item[1];
            const centro = h.match(/<span class="fwB">\s*([^<]+)\s*<\/span>/)?.[1];
            const detM = h.match(/fc_aux list_dot[^>]*>([\s\S]*?)<\/div>/);
            let tipo = null, titulo = null;
            if (detM) {
                const spans = [...detM[1].matchAll(/<span>\s*([^<]*)\s*<\/span>/g)];
                if (spans[0]) tipo = cleanText(spans[0][1]);
                if (spans[1]) titulo = cleanText(spans[1][1]);
            }
            c.formacion.push({ centroEstudio: cleanText(centro), tipo, titulo });
        }
    }

    // Skills
    const skillSec = html.match(/<h3 class="fwB[^>]*>Otros<\/h3>[\s\S]*?<div[^>]*>([\s\S]*?)<\/div>/);
    if (skillSec) {
        for (const t of skillSec[1].matchAll(/<span class="tag big bg_premium[^>]*>([^<]+)<\/span>/g)) {
            c.habilidades.push(cleanText(t[1]));
        }
    }

    // Languages
    const langSec = html.match(/<h3 class="fwB[^>]*>Idiomas<\/h3>[\s\S]*?<div[^>]*>([\s\S]*?)<\/div>/);
    if (langSec) {
        for (const t of langSec[1].matchAll(/<span class="tag big bg_premium[^>]*>([^<]+)<\/span>/g)) {
            c.idiomas.push(cleanText(t[1]));
        }
    }

    return c;
}

// ============================================================
// Web Form Email Parser (ported from n8n "Limpiar Info" node)
// ============================================================
function parseWebFormEmail(html) {
    function normalizeKey(key) {
        return key.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[¿?:]/g, '').replace(/\s+/g, '_').trim();
    }

    const lines = html.split(/<\/p>/i);
    const data = {};

    for (let line of lines) {
        const raw = line.trim();
        if (!raw || raw === '<p>----' || raw.startsWith('<p><a href=')) continue;
        const cleaned = cleanText(raw);
        if (!cleaned) continue;

        let parts;
        if (raw.includes('<br/>')) {
            parts = raw.split(/<br\/>/i).map(cleanText).filter(s => s.length > 0);
        } else if (cleaned.includes(':')) {
            parts = cleaned.split(':').map(s => cleanText(s)).filter(s => s.length > 0);
        } else continue;

        if (parts.length < 2) continue;
        let key = parts[0], value = parts[1];

        if (key && key.toLowerCase().includes('teléfono')) value = cleanPhone(value);
        if (key && key.toLowerCase().includes('correo electrónico')) {
            const em = raw.match(/mailto:([^"]+)"/);
            if (em) value = cleanText(em[1]);
        }

        if (key && value) {
            const nk = normalizeKey(key);
            if (nk) data[nk] = value;
        }
    }

    // Boolean conversions
    const boolFields = {
        'tienes_un_trabajo_fijo_a_tiempo_completo_o_part_time_en_la_actualidad': 'trabajo_fijo_actual',
        'te_interesa_tener_tu_propio_negocio': 'interesa_negocio_propio',
        'tienes_experiencia_previa_en_bienes_raices_o_en_ventas': 'experiencia_bienes_raices',
        'estas_actualmente_involucrado_en_bienes_raices': 'involucrado_bienes_raices_actual',
    };
    for (const [oldKey, newKey] of Object.entries(boolFields)) {
        if (data[oldKey]) { data[newKey] = data[oldKey].toLowerCase() === 'si'; delete data[oldKey]; }
    }

    // Rename fields
    const renames = {
        correo_electronico: 'email', nombre: 'nombre_candidato', apellidos: 'apellido_candidato',
        numero_de_telefono: 'telefono', ciudad_de_residencia: 'ciudad',
        como_te_enteraste_de_nosotros: 'fuente_conocimiento',
        tienes_alguna_consulta_o_comentario_adicional: 'consulta_adicional',
    };
    for (const [o, n] of Object.entries(renames)) {
        if (data[o]) { data[n] = data[o]; delete data[o]; }
    }
    if (data.edad) data.edad = parseInt(String(data.edad).replace(/\D/g, ''));

    data.fuente = 'Web';
    return data;
}

// ============================================================
// Create candidate in DB
// ============================================================
async function createCandidate(data, source) {
    // Extract first/last name
    let firstName = '', lastName = '';
    if (data.nombreCompleto) {
        const parts = data.nombreCompleto.split(' ');
        firstName = parts[0] || '';
        lastName = parts.slice(1).join(' ') || '';
    } else if (data.nombre_candidato) {
        firstName = data.nombre_candidato;
        lastName = data.apellido_candidato || '';
    } else if (data.nombre) {
        firstName = Array.isArray(data.nombre) ? data.nombre[0] : data.nombre;
    }

    const email = data.email || null;
    const phone = data.telefono || data.phone || null;
    const whatsapp = data.whatsapp || null;

    const { rows } = await pool.query(`
        INSERT INTO recruitment_candidates (
            first_name, last_name, email, phone, whatsapp, city, age, rut,
            job_title, profile_photo_url, linkedin_url, cv_summary,
            source, pipeline_stage,
            trabajo_fijo_actual, interesa_negocio_propio, experiencia_bienes_raices,
            involucrado_bienes_raices, fuente_conocimiento, consulta_adicional,
            experience_json, education_json, skills, languages,
            has_drivers_license, has_vehicle, willing_to_travel, willing_to_relocate,
            current_salary, profile_source_url
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            $9, $10, $11, $12,
            $13, 'nuevo_lead',
            $14, $15, $16,
            $17, $18, $19,
            $20, $21, $22, $23,
            $24, $25, $26, $27,
            $28, $29
        ) RETURNING id
    `, [
        firstName, lastName, email, phone, whatsapp,
        data.ubicacion || data.ciudad || data.city || null,
        data.edad || null,
        data.identificacion || data.rut || null,
        data.titulo || data.job_title || data.cargo || null,
        data.urlFotografia || null,
        null, // linkedin_url
        data.resumen || null,
        source,
        data.trabajo_fijo_actual ?? null,
        data.interesa_negocio_propio ?? null,
        data.experiencia_bienes_raices ?? null,
        data.involucrado_bienes_raices_actual ?? data.involucrado_bienes_raices ?? null,
        data.fuente_conocimiento || null,
        data.consulta_adicional || null,
        data.experienciaProfesional ? JSON.stringify(data.experienciaProfesional) : null,
        data.formacion ? JSON.stringify(data.formacion) : null,
        data.habilidades?.length ? data.habilidades : null,
        data.idiomas?.length ? data.idiomas : null,
        data.carnetConducir ?? null,
        data.vehiculoPropio ?? null,
        data.disponibilidadViajar ?? null,
        data.disponibilidadCambioResidencia ?? null,
        data.salarioNetoMensual || null,
        data.profileLink || null,
    ]);

    return rows[0].id;
}

// ============================================================
// POST /api/recruitment/leads/webhook — Chrome Extension
// ============================================================
router.post('/leads/webhook', async (req, res) => {
    try {
        const { url, HTML, html, nombre, correo, email, wssp, comuna, cargo, edad, titulo } = req.body;
        const sourceUrl = url || '';

        let source = 'Desconocido';
        let candidateData = {};

        if (sourceUrl.match(/linkedin\.com\/talent/i)) {
            // ─── LinkedIn ───
            source = 'LinkedIn';
            const cleanWssp = wssp ? wssp.replace(/^\+/, '') : null;
            const hasWssp = cleanWssp ? await verifyWhatsApp(cleanWssp) : false;
            candidateData = {
                nombre: nombre,
                email: email || correo,
                telefono: cleanWssp,
                whatsapp: hasWssp ? cleanWssp : null,
                titulo: Array.isArray(titulo) ? titulo[0] : titulo,
            };

        } else if (sourceUrl.match(/computrabajo\.com/i)) {
            // ─── Computrabajo ───
            source = 'Computrabajo';
            const parsed = parseComputrabajo(HTML || html);
            const hasWssp = parsed.telefono ? await verifyWhatsApp(parsed.telefono) : false;
            candidateData = {
                ...parsed,
                whatsapp: hasWssp ? parsed.telefono : null,
            };

        } else if (sourceUrl.match(/trabajando\.cl/i)) {
            // ─── Trabajando ───
            source = 'Trabajando';
            const cleanWssp = wssp ? wssp.replace(/^\+/, '') : null;
            const hasWssp = cleanWssp ? await verifyWhatsApp(cleanWssp) : false;
            candidateData = {
                nombre: nombre,
                email: email || correo,
                telefono: cleanWssp,
                whatsapp: hasWssp ? cleanWssp : null,
                cargo: cargo,
                ciudad: comuna,
                edad: edad ? (Array.isArray(edad) ? parseInt(String(edad[1]).replace(/\D/g, '')) : parseInt(String(edad).replace(/\D/g, ''))) : null,
            };
        } else {
            // Generic webhook — try to extract what we can
            source = 'Extensión';
            candidateData = {
                nombre: nombre,
                email: email || correo,
                telefono: wssp ? wssp.replace(/^\+/, '') : null,
                cargo: cargo,
                titulo: titulo ? (Array.isArray(titulo) ? titulo[0] : titulo) : null,
            };
        }

        // Duplicate check
        const dupEmail = candidateData.email || candidateData.correo;
        const existingId = await checkDuplicate(dupEmail);
        if (existingId) {
            return res.json({ success: true, duplicate: true, candidateId: existingId, message: 'Candidato ya existe' });
        }

        const candidateId = await createCandidate(candidateData, source);

        const candidateName = candidateData.nombreCompleto
            || candidateData.nombre_candidato
            || (Array.isArray(candidateData.nombre) ? candidateData.nombre[0] : candidateData.nombre)
            || 'Sin nombre';

        await pool.query(`
            INSERT INTO activity_logs (id, actor_id, action, entity_type, entity_id, description, details)
            VALUES (gen_random_uuid(), NULL, 'Lead Recibido', 'Candidate', $1, $2, $3)
        `, [
            candidateId,
            `Nuevo lead desde ${source}: ${candidateName}`,
            JSON.stringify({
                source,
                profile_url: sourceUrl,
                email: dupEmail,
                phone: candidateData.telefono || candidateData.phone || null,
                whatsapp_verified: !!candidateData.whatsapp,
            }),
        ]);

        logErrorToSlack('info', {
            category: 'recruitment', action: 'lead.created',
            message: `✅ Nuevo lead desde ${source}: ${candidateName}`,
            module: 'leads-webhook',
            details: { candidateId, source, email: dupEmail },
        });

        res.json({ success: true, candidateId, source });
    } catch (error) {
        console.error('Lead webhook error:', error);
        logErrorToSlack('error', {
            category: 'recruitment', action: 'lead.webhook_error',
            message: error.message, module: 'leads-webhook',
        });
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// POST /api/recruitment/upload-attachment
// Uploads a single file from the rule editor (multipart/form-data) to
// MinIO under email-attachments/recruitment-rules/<uuid>/<filename>.
// Returns { url, filename, mimeType, size } ready to push into a rule's
// attachments_json array.
// ============================================================
function parseMultipartFile(req) {
    return new Promise((resolve, reject) => {
        const bb = Busboy({ headers: req.headers, limits: { fileSize: 25 * 1024 * 1024 } });
        let captured = null;
        let truncated = false;
        bb.on('file', (_name, file, info) => {
            const chunks = [];
            file.on('data', (d) => chunks.push(d));
            file.on('limit', () => { truncated = true; });
            file.on('end', () => {
                captured = {
                    body: Buffer.concat(chunks),
                    filename: info.filename || 'attachment',
                    mimeType: info.mimeType || 'application/octet-stream',
                };
            });
        });
        bb.on('finish', () => {
            if (truncated) return reject(new Error('File exceeds 25 MB limit'));
            if (!captured) return reject(new Error('No file in request'));
            resolve(captured);
        });
        bb.on('error', reject);
        req.pipe(bb);
    });
}

router.post('/upload-attachment', async (req, res) => {
    try {
        const { body, filename, mimeType } = await parseMultipartFile(req);
        if (!body || body.length === 0) {
            return res.status(400).json({ error: 'Empty file' });
        }
        // Sanitize filename and store under a per-upload uuid prefix
        const safeName = String(filename).replace(/[^\w.\-]/g, '_').slice(0, 200) || 'attachment';
        const uuid = crypto.randomUUID();
        const key = `recruitment-rules/${uuid}/${safeName}`;
        const url = await uploadFile('email-attachments', key, body, mimeType);

        res.json({
            url,
            filename: filename,
            mimeType,
            size: body.length,
        });
    } catch (error) {
        console.error('Recruitment attachment upload error:', error);
        logErrorToSlack('error', {
            category: 'recruitment',
            action: 'attachment.upload_error',
            message: error.message,
            module: 'leads-attachment',
        });
        res.status(400).json({ error: error.message });
    }
});

// ============================================================
// POST /api/recruitment/candidates/:id/stage-changed
// Endpoint genérico: el frontend lo llama con cualquier stage al que
// se mueva el candidato. El backend lee recruitment_automation_rules
// activas para esa etapa y las ejecuta (email + tareas).
//
// El antiguo /post-meeting-decision queda como wrapper retrocompatible
// y delega acá.
// ============================================================
const APROBADO_PDF_URL = process.env.APROBADO_PDF_URL ||
    'https://res.cloudinary.com/dhzmkxbek/image/upload/v1771201266/Por_que%CC%81_ser_un_Agente_REMAX_-_I_Trimestre_2026_veqbvc.pdf';

function renderTemplateVars(text, vars) {
    let out = String(text || '');
    for (const [key, value] of Object.entries(vars)) {
        out = out.split(key).join(value);
    }
    return out;
}

function buildTemplateVars(candidate) {
    const FORMS_URL = process.env.FORMS_URL || 'https://forms.remax-exclusive.cl';
    const fullName = `${candidate.first_name || ''} ${candidate.last_name || ''}`.trim() || 'Candidato';
    return {
        '{{nombre}}': candidate.first_name || '',
        '{{apellido}}': candidate.last_name || '',
        '{{nombre_completo}}': fullName,
        '{{email}}': candidate.email || '',
        '{{telefono}}': candidate.phone || candidate.whatsapp || '',
        '{{ciudad}}': candidate.city || '',
        '{{form_url}}': `${FORMS_URL}/postular?cid=${candidate.id}`,
        '{{oficinas_url}}': 'https://rem.ax/OficinasREMAXChile',
        '{{candidate_id}}': candidate.id,
    };
}

async function executeEmailRule(rule, candidate) {
    if (!candidate.email) {
        throw new Error('Candidate has no email');
    }

    // A/B pick
    let templateId = rule.template_id;
    let abVariant = null;
    if (rule.ab_enabled && rule.ab_template_b_id) {
        const useB = Math.random() < 0.5;
        templateId = useB ? rule.ab_template_b_id : rule.template_id;
        abVariant = useB ? 'B' : 'A';
    }

    if (!templateId) throw new Error(`Rule ${rule.id} has no template_id`);

    const { rows: tplRows } = await pool.query(
        `SELECT id, subject, body_html FROM recruitment_email_templates WHERE id = $1`,
        [templateId],
    );
    if (!tplRows.length) throw new Error(`Template ${templateId} not found`);
    const tpl = tplRows[0];

    const { rows: accountRows } = await pool.query(
        `SELECT email_address FROM gmail_accounts WHERE purpose = 'recruitment' LIMIT 1`,
    );
    if (!accountRows.length) throw new Error('emprendedores@ Gmail account not connected');
    const accountEmail = accountRows[0].email_address;

    const vars = buildTemplateVars(candidate);
    let subject = renderTemplateVars(tpl.subject, vars);
    let bodyHtml = renderTemplateVars(tpl.body_html, vars);

    // Resolve {{evento:NombreDelEvento}} placeholders against the recruitment /
    // CRM calendars (replicates the n8n "Buscar_eventos" + "Formatear fecha" flow).
    subject = await resolveCalendarEventVars(subject);
    bodyHtml = await resolveCalendarEventVars(bodyHtml);

    const attachments = Array.isArray(rule.attachments_json) ? rule.attachments_json : [];

    await recruitmentEmailQueue.add('send-recruitment-email', {
        accountEmail,
        to: candidate.email,
        subject,
        bodyHtml,
        candidateId: candidate.id,
        templateId,
        abVariant,
        attachments,
        sentBy: null,
    }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        delay: (rule.delay_minutes || 0) * 60 * 1000,
    });

    await pool.query(`
        INSERT INTO recruitment_email_logs
            (candidate_id, email_type, subject, body_html, to_email, status, sent_at, ab_variant, metadata)
        VALUES ($1, $2, $3, $4, $5, 'queued', NOW(), $6, $7)
    `, [
        candidate.id, 'Automation', subject, bodyHtml, candidate.email,
        abVariant,
        JSON.stringify({ rule_id: rule.id, template_id: templateId, trigger: 'automation_rule' }),
    ]);
}

async function executeTaskRule(rule, candidate) {
    if (!rule.task_title) throw new Error(`Rule ${rule.id} has no task_title`);
    const vars = buildTemplateVars(candidate);
    let title = renderTemplateVars(rule.task_title, vars);
    title = await resolveCalendarEventVars(title);
    await pool.query(`
        INSERT INTO recruitment_tasks (candidate_id, title, task_type, priority, completed, due_date)
        VALUES ($1, $2, $3, 'media', false, NOW() + INTERVAL '1 day')
    `, [candidate.id, title, rule.task_type || 'Seguimiento']);
}

// ============================================================
// WhatsApp rule — sends a message via Chatwoot (in parallel to any
// email rule that may exist for the same stage). Picks an A/B variant
// when ab_enabled, renders {{nombre}}/{{evento:...}}, then enqueues to
// the recruitment-whatsapp BullMQ queue (the worker calls Chatwoot).
// ============================================================
async function executeWhatsappRule(rule, candidate) {
    const phone = candidate.whatsapp || candidate.phone;
    if (!phone) throw new Error('Candidate has no whatsapp/phone');
    if (!isChatwootConfigured()) {
        throw new Error('Chatwoot env vars missing (CHATWOOT_API_URL / TOKEN / ACCOUNT_ID / INBOX_ID)');
    }

    let templateId = rule.whatsapp_template_id;
    let abVariant = null;
    if (rule.ab_enabled && rule.ab_whatsapp_template_b_id) {
        const useB = Math.random() < 0.5;
        templateId = useB ? rule.ab_whatsapp_template_b_id : rule.whatsapp_template_id;
        abVariant = useB ? 'B' : 'A';
    }
    if (!templateId) throw new Error(`Rule ${rule.id} has no whatsapp_template_id`);

    const { rows: tplRows } = await pool.query(
        `SELECT id, body, attachments_json FROM recruitment_whatsapp_templates WHERE id = $1`,
        [templateId],
    );
    if (!tplRows.length) throw new Error(`WhatsApp template ${templateId} not found`);
    const tpl = tplRows[0];

    const vars = buildTemplateVars(candidate);
    let body = renderTemplateVars(tpl.body, vars);
    body = await resolveCalendarEventVars(body);

    const attachments = Array.isArray(tpl.attachments_json) ? tpl.attachments_json : [];

    // Persist the log row first so we have an id to update from the worker.
    const { rows: logRows } = await pool.query(
        `INSERT INTO recruitment_whatsapp_logs
            (candidate_id, template_id, ab_variant, body, to_phone, message_type, status, metadata)
         VALUES ($1, $2, $3, $4, $5, 'outgoing', 'queued', $6)
         RETURNING id`,
        [
            candidate.id,
            templateId,
            abVariant,
            body,
            phone,
            JSON.stringify({ rule_id: rule.id, trigger: 'automation_rule', attachments_count: attachments.length }),
        ],
    );
    const logId = logRows[0].id;

    await recruitmentWhatsappQueue.add(
        'send-recruitment-whatsapp',
        { logId, candidateId: candidate.id, content: body, attachments },
        {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            delay: (rule.delay_minutes || 0) * 60 * 1000,
        },
    );
}

async function executeRulesForStage(candidate, stage) {
    const { rows: rules } = await pool.query(
        `SELECT id, action_type, template_id, ab_enabled, ab_template_b_id,
                whatsapp_template_id, ab_whatsapp_template_b_id,
                task_title, task_type, delay_minutes, attachments_json
           FROM recruitment_automation_rules
          WHERE trigger_stage = $1 AND is_active = true`,
        [stage],
    );

    if (!rules.length) return { rulesFound: 0, rulesExecuted: 0 };

    let executed = 0;
    const failures = [];
    for (const rule of rules) {
        try {
            if (rule.action_type === 'send_email') {
                await executeEmailRule(rule, candidate);
            } else if (rule.action_type === 'send_whatsapp') {
                await executeWhatsappRule(rule, candidate);
            } else if (rule.action_type === 'create_task') {
                await executeTaskRule(rule, candidate);
            } else {
                throw new Error(`Unknown action_type: ${rule.action_type}`);
            }
            executed++;
        } catch (err) {
            console.error(`[Automation] Rule ${rule.id} failed:`, err.message);
            failures.push({ ruleId: rule.id, error: err.message });
            logErrorToSlack('error', {
                category: 'recruitment',
                action: 'automation_rule.error',
                message: `❌ Regla ${rule.id} (${rule.action_type}) falló para candidato ${candidate.id} en etapa ${stage}: ${err.message}`,
                module: 'leads-automation',
                details: { candidateId: candidate.id, stage, ruleId: rule.id, error: err.message },
            });
        }
    }
    return { rulesFound: rules.length, rulesExecuted: executed, failures };
}

router.post('/candidates/:id/stage-changed', async (req, res) => {
    const { id } = req.params;
    const { stage } = req.body || {};
    if (!stage) return res.status(400).json({ error: 'stage is required in body' });
    const normalizedStage = String(stage).toLowerCase();

    try {
        const { rows } = await pool.query(
            `SELECT id, first_name, last_name, email, phone, whatsapp, city
               FROM recruitment_candidates WHERE id = $1 LIMIT 1`,
            [id],
        );
        if (!rows.length) return res.status(404).json({ error: 'Candidate not found' });
        const candidate = rows[0];

        const result = await executeRulesForStage(candidate, normalizedStage);

        if (result.rulesExecuted > 0) {
            const fullName = `${candidate.first_name || ''} ${candidate.last_name || ''}`.trim() || 'Candidato';
            logErrorToSlack('info', {
                category: 'recruitment',
                action: 'stage_changed.rules_executed',
                message: `🤖 ${result.rulesExecuted}/${result.rulesFound} reglas ejecutadas para ${fullName} → ${normalizedStage}`,
                module: 'leads-automation',
                details: { candidateId: id, stage: normalizedStage, ...result },
            });
        }

        res.json({ success: true, candidateId: id, stage: normalizedStage, ...result });
    } catch (error) {
        console.error('Stage-changed automation error:', error);
        logErrorToSlack('error', {
            category: 'recruitment',
            action: 'stage_changed.error',
            message: error.message,
            module: 'leads-automation',
            details: { candidateId: id, stage: normalizedStage },
        });
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// POST /api/recruitment/candidates/:id/post-meeting-decision (deprecated)
// Wrapper retrocompatible. Mantiene la API anterior pero ahora
// delega al motor de reglas de stage-changed.
// ============================================================
router.post('/candidates/:id/post-meeting-decision', async (req, res) => {
    const { id } = req.params;
    const { decision } = req.body || {};
    const normalized = String(decision || '').toLowerCase();
    if (normalized !== 'aprobado' && normalized !== 'desaprobado') {
        return res.status(400).json({ error: 'decision must be "aprobado" or "desaprobado"' });
    }
    try {
        const { rows } = await pool.query(
            `SELECT id, first_name, last_name, email, phone, whatsapp, city
               FROM recruitment_candidates WHERE id = $1 LIMIT 1`,
            [id],
        );
        if (!rows.length) return res.status(404).json({ error: 'Candidate not found' });
        const result = await executeRulesForStage(rows[0], normalized);
        res.json({ success: true, candidateId: id, estado: normalized, ...result });
    } catch (error) {
        console.error('Post-meeting decision error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// POST /api/recruitment/leads/from-email — Process web form email
// Called by the cron worker
// ============================================================
router.post('/leads/from-email', async (req, res) => {
    try {
        const { html, messageId } = req.body;
        if (!html) return res.status(400).json({ error: 'html required' });

        const parsed = parseWebFormEmail(html);

        // Check duplicate
        if (parsed.email) {
            const existingId = await checkDuplicate(parsed.email);
            if (existingId) {
                return res.json({ success: true, duplicate: true, candidateId: existingId });
            }
        }

        // Verify WhatsApp
        if (parsed.telefono) {
            const hasWssp = await verifyWhatsApp(parsed.telefono);
            if (hasWssp) parsed.whatsapp = parsed.telefono;
        }

        const candidateId = await createCandidate(parsed, 'Web');

        logErrorToSlack('info', {
            category: 'recruitment', action: 'lead.created',
            message: `✅ Nuevo lead desde Web Form: ${parsed.nombre_candidato || 'Sin nombre'} ${parsed.apellido_candidato || ''}`,
            module: 'leads-email',
            details: { candidateId, email: parsed.email, messageId },
        });

        res.json({ success: true, candidateId });
    } catch (error) {
        console.error('Email lead error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// POST /api/recruitment/templates/ai-generate
// Genera el HTML brandeado de una plantilla de email desde un prompt
// libre. Llama al LLM (OpenAI Chat Completions) y devuelve
// { subject, body_html } listo para pegarse en el editor.
//
// La env var ANTHROPIC_API_KEY actualmente contiene una API key de
// OpenAI (naming legacy) — se usa contra api.openai.com.
// ============================================================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_TEMPLATE_MODEL || 'gpt-4o';

const TEMPLATE_SYSTEM_PROMPT = `Sos un asistente que genera plantillas de email para RE/MAX Exclusive (inmobiliaria, oficina en Chile). Tu output va a ser pegado directamente en un editor de plantillas que ya hace la sustitución de variables Mustache-style.

DEBÉS responder EXCLUSIVAMENTE con un JSON válido con esta forma:
{
  "subject": "...asunto del email...",
  "body_html": "<!DOCTYPE html>...HTML completo del cuerpo del email..."
}

NUNCA agregues texto antes o después del JSON. Nada de markdown, ni \`\`\`json. Solo el objeto.

Brand del HTML:
- Familia tipográfica: 'Open Sans', Arial, sans-serif.
- Colores: azul RE/MAX #003DA5, rojo RE/MAX #E11B22.
- Container blanco \`max-width:800px;border-radius:20px;box-shadow:0 4px 20px rgba(0,0,0,0.1)\` sobre fondo \`#f5f5f5\`.
- Padding interno 40px 35px, color de texto #333, line-height 1.8, font-size 15px, text-align justify.
- Botón CTA: \`display:inline-block;background-color:#E11B22;color:#ffffff;text-decoration:none;padding:14px 35px;border-radius:50px;font-weight:600;font-size:15px\`.
- Saludo en 16px, margin-bottom 25px, con \`<strong>\` alrededor del nombre.
- Firma al final, centrada, usando esta imagen exacta: \`<img src="https://res.cloudinary.com/dhzmkxbek/image/upload/v1765805558/FIRMA_EMAIL_600_x_400_px_KAREM_BRUSCA_sh0ng4.jpg" alt="Karem Brusca - Reclutamiento" style="max-width:100%;height:auto;">\` dentro de un \`<div style="margin:40px 0 20px 0;text-align:center;">\`.
- Todo el styling debe ir inline (Gmail no soporta <style>).

Usá las siguientes variables Mustache cuando corresponda (no las "rellenes", dejalas literales con doble llave):
- {{nombre}} → primer nombre del candidato.
- {{apellido}} → apellido.
- {{nombre_completo}} → nombre completo.
- {{email}}, {{telefono}}, {{ciudad}}.
- {{fecha_reunion}}, {{ubicacion_reunion}}.
- {{form_url}} → link al formulario de aprobación, personalizado por candidato.
- {{oficinas_url}} → link al directorio de oficinas RE/MAX Chile.
- {{candidate_id}} → UUID interno del candidato (usar solo si el usuario lo pide explícitamente).

El HTML debe empezar con \`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>RE/MAX Exclusive Chile</title></head><body style="margin:0;padding:0;font-family:'Open Sans',Arial,sans-serif;background-color:#f5f5f5;">\` y respetar la estructura del template ya existente.

Si el usuario pide un email que ya tiene asunto definido, usalo. Si no, generá un asunto corto y profesional.`;

router.post('/templates/ai-generate', async (req, res) => {
    try {
        if (!OPENAI_API_KEY) {
            return res.status(503).json({ error: 'AI provider not configured (OPENAI_API_KEY / ANTHROPIC_API_KEY missing)' });
        }
        const { prompt, currentBodyHtml, currentSubject } = req.body || {};
        if (!prompt || !String(prompt).trim()) {
            return res.status(400).json({ error: 'prompt is required' });
        }

        const userMessage = [
            `Necesito que generes una plantilla de email con este pedido:`,
            ``,
            String(prompt).trim(),
            ``,
            currentSubject ? `Asunto actual: ${currentSubject}` : null,
            currentBodyHtml
                ? `HTML actual (mejorá/reescribí sobre esto):\n${currentBodyHtml.slice(0, 8000)}`
                : null,
        ].filter(Boolean).join('\n');

        const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: OPENAI_MODEL,
                messages: [
                    { role: 'system', content: TEMPLATE_SYSTEM_PROMPT },
                    { role: 'user', content: userMessage },
                ],
                response_format: { type: 'json_object' },
                max_tokens: 4096,
                temperature: 0.5,
            }),
        });

        if (!r.ok) {
            const errBody = await r.text().catch(() => '');
            throw new Error(`OpenAI ${r.status}: ${errBody.slice(0, 300)}`);
        }

        const data = await r.json();
        const text = data?.choices?.[0]?.message?.content || '';
        if (!text) throw new Error('LLM returned empty response');

        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch {
            const match = text.match(/\{[\s\S]*\}/);
            if (!match) throw new Error('LLM did not return JSON');
            parsed = JSON.parse(match[0]);
        }

        if (!parsed.subject || !parsed.body_html) {
            throw new Error('LLM response missing subject or body_html');
        }

        res.json({ subject: parsed.subject, body_html: parsed.body_html });
    } catch (error) {
        console.error('AI generate template error:', error);
        logErrorToSlack('error', {
            category: 'recruitment', action: 'templates.ai_generate_error',
            message: error.message,
            module: 'leads-ai',
        });
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// Chatwoot public config — base URL + account_id + inbox_id, so the
// frontend can build "Abrir chat" links without duplicating env vars.
// Safe to expose: these values are already visible to anyone who opens
// the Chatwoot widget (ChatwootWidget.jsx hardcodes the same baseUrl).
// ============================================================
router.get('/chatwoot-config', (_req, res) => {
    res.json(getChatwootPublicConfig());
});

// ============================================================
// WhatsApp templates CRUD  (/api/recruitment/whatsapp-templates)
// Mirrors the email templates endpoints but with a plain-text body
// instead of HTML. Body may contain {{nombre}}, {{evento:...}}, etc.
// ============================================================
router.get('/whatsapp-templates', async (_req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, name, body, category, is_default, attachments_json, created_by, created_at, updated_at
               FROM recruitment_whatsapp_templates
              ORDER BY is_default DESC NULLS LAST, name ASC`,
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/whatsapp-templates/:id', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, name, body, category, is_default, attachments_json, created_by, created_at, updated_at
               FROM recruitment_whatsapp_templates WHERE id = $1`,
            [req.params.id],
        );
        if (!rows.length) return res.status(404).json({ error: 'Not found' });
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/whatsapp-templates', async (req, res) => {
    try {
        const { name, body, category, is_default, attachments_json, created_by } = req.body || {};
        if (!name || !body) return res.status(400).json({ error: 'name and body are required' });
        const { rows } = await pool.query(
            `INSERT INTO recruitment_whatsapp_templates (name, body, category, is_default, attachments_json, created_by)
             VALUES ($1, $2, COALESCE($3, 'General'), COALESCE($4, false), COALESCE($5, '[]'::jsonb), $6)
             RETURNING *`,
            [
                name,
                body,
                category || null,
                is_default || false,
                JSON.stringify(Array.isArray(attachments_json) ? attachments_json : []),
                created_by || null,
            ],
        );
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/whatsapp-templates/:id', async (req, res) => {
    try {
        const { name, body, category, is_default, attachments_json } = req.body || {};
        const attachmentsParam = attachments_json === undefined
            ? null
            : JSON.stringify(Array.isArray(attachments_json) ? attachments_json : []);
        const { rows } = await pool.query(
            `UPDATE recruitment_whatsapp_templates
                SET name             = COALESCE($1, name),
                    body             = COALESCE($2, body),
                    category         = COALESCE($3, category),
                    is_default       = COALESCE($4, is_default),
                    attachments_json = COALESCE($5::jsonb, attachments_json),
                    updated_at       = NOW()
              WHERE id = $6
              RETURNING *`,
            [
                name ?? null,
                body ?? null,
                category ?? null,
                is_default ?? null,
                attachmentsParam,
                req.params.id,
            ],
        );
        if (!rows.length) return res.status(404).json({ error: 'Not found' });
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/whatsapp-templates/:id', async (req, res) => {
    try {
        await pool.query(`DELETE FROM recruitment_whatsapp_templates WHERE id = $1`, [req.params.id]);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// Send a WhatsApp manually to a candidate (ad-hoc, not from a rule).
// Body: { templateId?: string, content?: string }
// Either templateId (renders from a stored template) or content (raw
// text) is required.
// ============================================================
// ============================================================
// Reset the cached Chatwoot ids on a candidate. Use this when the
// stored chatwoot_conversation_id was created with the wrong
// source_id format (pre-JID fix) and Evolution silently dropped the
// outgoing messages. After resetting, the next send rebuilds the
// contact + conversation with the correct JID source_id.
// ============================================================
router.post('/candidates/:id/reset-chatwoot-cache', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `UPDATE recruitment_candidates
                SET chatwoot_contact_id      = NULL,
                    chatwoot_conversation_id = NULL,
                    updated_at = NOW()
              WHERE id = $1
              RETURNING id`,
            [req.params.id],
        );
        if (!rows.length) return res.status(404).json({ error: 'Candidate not found' });
        res.json({ ok: true, candidateId: rows[0].id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/candidates/:id/send-whatsapp', async (req, res) => {
    try {
        const { templateId, content, attachments } = req.body || {};
        if (!templateId && !content) {
            return res.status(400).json({ error: 'templateId or content is required' });
        }

        const { rows: candRows } = await pool.query(
            `SELECT id, first_name, last_name, email, phone, whatsapp, city
               FROM recruitment_candidates WHERE id = $1`,
            [req.params.id],
        );
        if (!candRows.length) return res.status(404).json({ error: 'Candidate not found' });
        const candidate = candRows[0];

        let body = content;
        let finalAttachments = Array.isArray(attachments) ? attachments : [];
        if (templateId) {
            const { rows: tplRows } = await pool.query(
                `SELECT body, attachments_json FROM recruitment_whatsapp_templates WHERE id = $1`,
                [templateId],
            );
            if (!tplRows.length) return res.status(404).json({ error: 'Template not found' });
            body = tplRows[0].body;
            // Override attachments with the template's if the caller didn't supply any.
            if (!finalAttachments.length && Array.isArray(tplRows[0].attachments_json)) {
                finalAttachments = tplRows[0].attachments_json;
            }
        }

        const vars = buildTemplateVars(candidate);
        body = renderTemplateVars(body, vars);
        body = await resolveCalendarEventVars(body);

        const { rows: logRows } = await pool.query(
            `INSERT INTO recruitment_whatsapp_logs
                (candidate_id, template_id, body, to_phone, message_type, status, metadata)
             VALUES ($1, $2, $3, $4, 'outgoing', 'queued', $5)
             RETURNING id`,
            [
                candidate.id,
                templateId || null,
                body,
                candidate.whatsapp || candidate.phone,
                JSON.stringify({
                    trigger: 'manual',
                    actor: req.headers['x-user-id'] || null,
                    attachments_count: finalAttachments.length,
                }),
            ],
        );
        await recruitmentWhatsappQueue.add(
            'send-recruitment-whatsapp',
            { logId: logRows[0].id, candidateId: candidate.id, content: body, attachments: finalAttachments },
            { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
        );

        res.json({ ok: true, logId: logRows[0].id });
    } catch (err) {
        logErrorToSlack('error', {
            category: 'recruitment', action: 'whatsapp.manual_send_error',
            message: err.message, module: 'leads-whatsapp',
        });
        res.status(500).json({ error: err.message });
    }
});

export default router;
