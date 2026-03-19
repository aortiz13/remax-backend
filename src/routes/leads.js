import express from 'express';
import pool from '../lib/db.js';
import { logErrorToSlack } from '../middleware/slackErrorLogger.js';

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
            $13, 'Nuevo',
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
            source = 'Linkedin';
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

        logErrorToSlack('info', {
            category: 'recruitment', action: 'lead.created',
            message: `✅ Nuevo lead desde ${source}: ${candidateData.nombreCompleto || candidateData.nombre || 'Sin nombre'}`,
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

export default router;
