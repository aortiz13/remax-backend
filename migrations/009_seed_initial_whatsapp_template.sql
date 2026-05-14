-- ============================================================
-- 009 — Seed default "Invitación Reunión" WhatsApp template
--
-- Plain-text WhatsApp version of the "Correo Inicial A — Preselección"
-- email (migration 007). Same placeholders so the backend can render
-- both messages from the same lead trigger.
--
-- Idempotent: removes the row by name first, then re-inserts.
-- ============================================================

BEGIN;

DELETE FROM recruitment_whatsapp_templates
 WHERE name = 'Invitación Reunión Agente Inmobiliario';

INSERT INTO recruitment_whatsapp_templates (name, body, category, is_default)
VALUES (
    'Invitación Reunión Agente Inmobiliario',
    $msg$¡Hola {{nombre}}! 👋

Te escribimos desde *RE/MAX Exclusive Chile* en respuesta a tu postulación. ¡Has sido preseleccionado/a! 🎉

Te invitamos a una reunión presencial donde nuestro Broker te presentará en detalle la oportunidad de ser *Agente Inmobiliario* en la red inmobiliaria más grande del mundo.

📅 *Fecha:* {{evento:Reunión Agente Inmobiliario}}
📍 *Lugar:* Dr. Carlos Charlin 1539, Providencia (Metro Manuel Montt)
⏱️ *Duración:* 60 minutos aproximadamente

Por favor confirmanos tu asistencia respondiendo este mensaje o solicitanos otra fecha.

ℹ️ Recordá que no es una oferta de empleo con sueldo fijo: los ingresos se obtienen por comisiones de ventas y arriendos.

Si querés conocer más antes de la reunión, mirá nuestros videos:
• https://www.instagram.com/reel/DDb9HUWRf4y/
• https://remax-exclusive.cl/emprende-con-nosotros/

¡Te esperamos!$msg$,
    'Invitación',
    true
);

COMMIT;
