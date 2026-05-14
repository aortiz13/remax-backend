-- ============================================================
-- 007 — Seed "Correo Inicial A — Preselección" template
--
-- Ports the n8n "ENVIAR CORREO" node (workflow FMcwnmnMezHOfUVm,
-- "Enviar Email Inicial") into recruitment_email_templates so it
-- can be used from the templates UI and by automation rules.
--
-- Placeholder mapping vs. the original n8n template:
--   {{ $('Normalizar datos').first().json.Nombre.split(' ')[0] }}
--       → {{nombre}}                       (first name of the candidate)
--   {{ $json['Día'] }}
--       → {{evento:Reunión Agente Inmobiliario}}
--                                          (next occurrence date/time,
--                                           resolved at send time against
--                                           the emprendedores@ calendar)
--
-- Idempotent: if a template with the same name already exists, it is
-- removed first so re-running this migration always leaves a single,
-- up-to-date row.
-- ============================================================

BEGIN;

DELETE FROM recruitment_email_templates
 WHERE name = 'Correo Inicial A — Preselección';

INSERT INTO recruitment_email_templates (
    name, subject, body_html, category, is_default, created_at, updated_at
)
VALUES (
    'Correo Inicial A — Preselección',
    '¡Has Sido Preseleccionado!',
    $html$<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;600;700&display=swap" rel="stylesheet">
    <title>RE/MAX Exclusive Chile</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { margin: 0; padding: 0; font-family: 'Open Sans', sans-serif; background-color: #f5f5f5; }
        .email-wrapper { background-color: #f5f5f5; padding: 20px 0; }
        .container { max-width: 800px; margin: 0 auto; background-color: #ffffff; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1); border-radius: 20px; overflow: hidden; }
        .hero-banner { background: linear-gradient(135deg, #003DA5 0%, #0052d4 100%); padding: 50px 20px; text-align: center; position: relative; max-width: 600px; margin: 0 auto; }
        .hero-banner h1 { color: #ffffff; font-size: 36px; font-weight: 700; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 2px; }
        .hero-banner p { color: #ffffff; font-size: 18px; margin-bottom: 25px; font-weight: 300; }
        .logo-container { margin-bottom: 20px; }
        .logo-container img { max-width: 175px; height: auto; }
        .content { padding: 40px 35px; color: #333333; line-height: 1.8; font-size: 15px; text-align: justify; }
        .greeting { font-size: 16px; margin-bottom: 25px; }
        .brand-text { font-size: 16px; margin: 25px 0; }
        .remax-red { color: #E11B22; font-weight: 700; }
        .remax-blue { color: #003DA5; font-weight: 700; }
        .highlight { color: #003DA5; font-weight: 600; }
        .alert-box { background: linear-gradient(to right, #fff3cd, #ffffff); border-left: 5px solid #E11B22; padding: 20px; margin: 30px 0; border-radius: 8px; }
        .alert-box strong { color: #E11B22; display: block; margin-bottom: 10px; font-size: 16px; }
        .section-title { color: #003DA5; font-size: 18px; font-weight: 700; margin: 30px 0 15px 0; padding-bottom: 10px; border-bottom: 2px solid #E11B22; }
        .video-section { background-color: #f8f9fa; padding: 25px; border-radius: 10px; text-align: center; margin: 25px 0; }
        .btn { display: inline-flex; align-items: center; gap: 8px; background-color: #E11B22; color: #ffffff !important; text-decoration: none; padding: 14px 30px; border-radius: 50px; font-weight: 600; margin: 8px 5px; font-size: 14px; transition: all 0.3s ease; box-shadow: 0 4px 15px rgba(225, 27, 34, 0.3); }
        .btn:hover { background-color: #c01018; transform: translateY(-2px); box-shadow: 0 6px 20px rgba(225, 27, 34, 0.4); }
        .btn-outline { background-color: transparent; border: 2px solid #003DA5; color: #003DA5 !important; box-shadow: none; }
        .btn-outline:hover { background-color: #003DA5; color: #ffffff !important; transform: translateY(-2px); }
        .cta-card { background: linear-gradient(135deg, #003DA5 0%, #0052d4 100%); color: #ffffff; padding: 40px 30px; text-align: center; margin: 40px 0; border-radius: 15px; box-shadow: 0 10px 30px rgba(0, 61, 165, 0.3); }
        .cta-card h2 { margin: 0 0 15px 0; font-size: 28px; font-weight: 700; }
        .cta-card p { margin: 10px 0 25px 0; font-size: 16px; opacity: 0.95; }
        .meeting-details { background-color: #ffffff; border-radius: 10px; padding: 25px; margin: 25px 0; box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1); }
        .meeting-details p { margin: 12px 0; font-size: 15px; color: #333333; }
        .meeting-details .date-highlight { color: #E11B22; font-size: 20px; font-weight: 700; margin: 15px 0; }
        .btn-primary { background-color: #ffffff; color: #003DA5 !important; display: inline-flex; align-items: center; gap: 10px; text-decoration: none; padding: 16px 40px; border-radius: 50px; font-weight: 700; font-size: 16px; box-shadow: 0 4px 15px rgba(255, 255, 255, 0.3); transition: all 0.3s ease; }
        .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(255, 255, 255, 0.5); }
        .info-note { background-color: #f8f9fa; padding: 20px; border-radius: 10px; margin: 25px 0; border-left: 4px solid #003DA5; }
        .info-note p { margin: 0; font-size: 14px; color: #555555; }
        .signature { margin: 40px 0 20px 0; text-align: center; }
        .signature img { max-width: 100%; height: auto; }
        .footer { background-color: #1a1a1a; color: #ffffff; padding: 30px 20px; text-align: center; }
        .footer p { margin: 8px 0; font-size: 13px; opacity: 0.8; }
        .footer a { color: #ffffff; text-decoration: none; }
        @media only screen and (max-width: 600px) {
            .hero-banner h1 { font-size: 28px; }
            .hero-banner p { font-size: 16px; }
            .logo-container img { max-width: 140px; }
            .content { padding: 25px 20px; }
            .btn { display: block; margin: 10px 0; }
            .cta-card { padding: 30px 20px; }
            .cta-card h2 { font-size: 24px; }
        }
    </style>
</head>
<body>
    <div class="email-wrapper">
        <div class="container">
            <!-- HERO BANNER -->
            <div class="hero-banner">
                <div class="logo-container">
                    <img src="https://remax-exclusive.cl/wp-content/uploads/2025/04/LOGO-2025-EXCLUSIVE-GLOBO-DE-LADO.-SF-CREMA-PNG-2048x901.png.webp" alt="RE/MAX Exclusive Chile">
                </div>
                <h1>¡FELICIDADES!</h1>
                <p>Has sido preseleccionado/a</p>
            </div>

            <!-- CONTENIDO PRINCIPAL -->
            <div class="content">
                <p class="greeting">Hola <strong>{{nombre}}</strong>.</p>

                <p class="brand-text">Le escribimos desde <strong>RE/MAX Exclusive Chile</strong>, en respuesta a su postulación.</p>

                <p>En la actualidad solo estamos realizando encuentros presenciales con nuestros candidatos preseleccionados.</p>

                <div class="section-title">🏠 La Oportunidad</div>

                <p>Le presentamos la oportunidad de desempeñarse como <span class="highlight">Agente Inmobiliario en <strong>RE/MAX</strong></span>, la red inmobiliaria más grande del mundo.</p>

                <div class="alert-box">
                    <strong>⚠️ Información importante</strong>
                    Esta no es una oferta de empleo tradicional con sueldo fijo. Los ingresos se obtienen en base a <strong>comisiones por ventas o arriendos</strong> que realice cada agente. No existe sueldo base.
                </div>

                <div class="section-title">📹 Conozca más sobre nosotros</div>

                <div class="video-section">
                    <p style="margin-bottom: 15px; color: #555555;">Le invitamos a ver estos videos sobre el emprendimiento que ofrecemos:</p>
                    <a href="https://www.instagram.com/reel/DDb9HUWRf4y/?igsh=YmdleDR2OWFhOHln" class="btn">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                            <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/>
                        </svg>
                        Video 1
                    </a>
                    <a href="https://www.instagram.com/reel/DSKiF6uEadN/?igsh=dDljZmJ6YWt6ZzEx" class="btn">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="white">
                            <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/>
                        </svg>
                        Video 2
                    </a>

                    <p style="margin-top: 20px; margin-bottom: 10px; color: #555555;">Revisa las preguntas frecuentes:</p>
                    <a href="https://remax-exclusive.cl/emprende-con-nosotros/" class="btn-outline">🚀 Emprende con Nosotros</a>
                </div>

                <p>Ser <span class="highlight">Agente Inmobiliario</span> en nuestra red significa construir su propio negocio como emprendedor. Nuestro horario es flexible, sin embargo, valoramos la <span class="highlight">disponibilidad de tiempo completo</span> para un compromiso profesional serio.</p>

                <!-- CTA PRINCIPAL -->
                <div class="cta-card">
                    <h2>📅 Reserve su Cita</h2>
                    <p>Lo invitamos a una reunión presencial donde nuestro Broker le presentará esta oportunidad en detalle</p>

                    <div class="meeting-details">
                        <p><strong>📍 Ubicación:</strong></p>
                        <p>Dr. Carlos Charlin 1539, Providencia</p>
                        <p style="font-size: 13px; color: #666666;"><em>(Metro Manuel Montt)</em></p>

                        <p class="date-highlight">📅 {{evento:Reunión Agente Inmobiliario}}</p>

                        <p style="font-size: 13px; color: #666666; margin-top: 15px;">⏱️ Duración: 60 minutos aproximadamente</p>
                    </div>
                </div>

                <p style="text-align: center; font-weight: 600; margin-top: 25px;">Por favor confírmenos su asistencia respondiendo este correo o solicite otra fecha.</p>

                <div class="info-note">
                    <p><strong>💡 Nota:</strong> Si piensa que esta oportunidad no se adapta a sus necesidades actuales, pero conoce a alguien que le pueda interesar, comparta este correo: <a href="mailto:emprendedores@remax-exclusive.cl" style="color: #E11B22; font-weight: 600;">emprendedores@remax-exclusive.cl</a></p>
                </div>

                <div class="signature">
                    <img src="https://res.cloudinary.com/dhzmkxbek/image/upload/v1765805558/FIRMA_EMAIL_600_x_400_px_KAREM_BRUSCA_sh0ng4.jpg" alt="Karem Brusca - Reclutamiento">
                </div>
            </div>
        </div>
    </div>
</body>
</html>$html$,
    'Invitación',
    false,
    NOW(),
    NOW()
);

COMMIT;
