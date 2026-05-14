-- ============================================================
-- Default templates for the post-meeting flow (Aprobado / Rechazo)
-- The backend route /api/recruitment/candidates/:id/post-meeting-decision
-- picks the is_default template for the matching category and sends it via
-- the emprendedores@ Gmail account, attaching the "Por qué ser un Agente RE/MAX"
-- PDF when the decision is Aprobado.
--
-- Idempotent: deletes any existing default for these two categories first.
-- ============================================================

BEGIN;

-- Make sure no other default sits in these two categories
UPDATE recruitment_email_templates
   SET is_default = false
 WHERE is_default = true AND category IN ('Aprobación', 'Rechazo');

-- Template: Aprobación → Formulario de aprobación + PDF adjunto
INSERT INTO recruitment_email_templates (name, subject, body_html, category, is_default, created_at, updated_at)
VALUES (
    'Aprobación post-reunión',
    'Formulario de Ingreso',
    $html$<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>RE/MAX Exclusive Chile</title></head><body style="margin:0;padding:0;font-family:'Open Sans',Arial,sans-serif;background-color:#f5f5f5;"><div style="background-color:#f5f5f5;padding:20px 0;"><div style="max-width:800px;margin:0 auto;background-color:#ffffff;box-shadow:0 4px 20px rgba(0,0,0,0.1);border-radius:20px;overflow:hidden;"><div style="padding:40px 35px;color:#333333;line-height:1.8;font-size:15px;text-align:justify;"><p style="font-size:16px;margin-bottom:25px;">¡Hola <strong>{{nombre}}</strong>!</p><p>Un gusto saludarte nuevamente.</p><p>Primero que todo quiero agradecer tu participación en nuestra reunión el día de hoy.</p><p style="margin-top:25px;">Te invitamos a completar el <strong>formulario de aprobación</strong>. Una vez que lo hayas hecho podremos avanzar hacia la segunda etapa del proceso de selección.</p><p style="text-align:center;margin:30px 0;"><a href="{{form_url}}" style="display:inline-block;background-color:#E11B22;color:#ffffff;text-decoration:none;padding:14px 35px;border-radius:50px;font-weight:600;font-size:15px;">Completar Formulario</a></p><p>Adjunto la presentación de nuestro modelo de negocios <strong>RE/MAX</strong> que te mostré, para que puedas tener una visión más detallada de lo que implica ser parte de la <span style="color:#003DA5;font-weight:600;">red inmobiliaria más grande del mundo</span> y cómo podemos ayudarte a alcanzar el éxito como Agente Inmobiliario.</p><p style="margin-top:25px;">Agradecemos nuevamente tu interés y entusiasmo en este proceso. Estamos emocionados por la posibilidad de contar contigo como parte de nuestro equipo de agentes exitosos <strong>RE/MAX Exclusive</strong>.</p><p style="margin-top:25px;">Quedamos atentos a tu pronta respuesta.</p><div style="margin:40px 0 20px 0;text-align:center;"><img src="https://res.cloudinary.com/dhzmkxbek/image/upload/v1765805558/FIRMA_EMAIL_600_x_400_px_KAREM_BRUSCA_sh0ng4.jpg" alt="Karem Brusca - Reclutamiento" style="max-width:100%;height:auto;"></div></div></div></div></body></html>$html$,
    'Aprobación',
    true,
    NOW(),
    NOW()
);

-- Template: Rechazo → Email de agradecimiento + link a oficinas
INSERT INTO recruitment_email_templates (name, subject, body_html, category, is_default, created_at, updated_at)
VALUES (
    'Rechazo post-reunión',
    'Estatus de proceso de postulación para Agente Inmobiliario RE/MAX Exclusive',
    $html$<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>RE/MAX Exclusive Chile</title></head><body style="margin:0;padding:0;font-family:'Open Sans',Arial,sans-serif;background-color:#f5f5f5;"><div style="background-color:#f5f5f5;padding:20px 0;"><div style="max-width:800px;margin:0 auto;background-color:#ffffff;box-shadow:0 4px 20px rgba(0,0,0,0.1);border-radius:20px;overflow:hidden;"><div style="padding:40px 35px;color:#333333;line-height:1.8;font-size:15px;text-align:justify;"><p style="font-size:16px;margin-bottom:25px;">¡Hola <strong>{{nombre}}</strong>!</p><p>Primero que todo queremos agradecerte por tu tiempo y tu participación en el proceso de selección para ser Agente Inmobiliario en <strong>RE/MAX Exclusive</strong>.</p><p>Después de una cuidadosa evaluación y consideración de todos los candidatos, debemos informarte que no avanzaremos a la siguiente etapa del proceso de selección. Esta decisión no responde a factores personales, sino a criterios específicos del perfil comercial que buscamos.</p><p>Sin embargo, esta decisión no te limita a participar en otro proceso de selección para formar parte de <strong>RE/MAX Chile</strong>, lo puedes hacer en otra oficina de nuestra red, ya que cada una es de operación y propiedad independiente.</p><p style="text-align:center;margin:30px 0;"><a href="{{oficinas_url}}" style="display:inline-block;background-color:#E11B22;color:#ffffff;text-decoration:none;padding:14px 35px;border-radius:50px;font-weight:600;font-size:15px;">Ver Oficinas RE/MAX Chile</a></p><p>Te deseamos mucho éxito y agradecemos una vez más tu interés en unirte a nuestro equipo.</p><p>Sin más a que hacer referencia, nos despedimos.</p><div style="margin:40px 0 20px 0;text-align:center;"><img src="https://res.cloudinary.com/dhzmkxbek/image/upload/v1765805558/FIRMA_EMAIL_600_x_400_px_KAREM_BRUSCA_sh0ng4.jpg" alt="Karem Brusca - Reclutamiento" style="max-width:100%;height:auto;"></div></div></div></div></body></html>$html$,
    'Rechazo',
    true,
    NOW(),
    NOW()
);

COMMIT;
