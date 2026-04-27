import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

export async function sendAgentEmail({ to, subject, body }) {
    await transporter.sendMail({
        from: process.env.SMTP_FROM || `Agente Virtual RE/MAX <${process.env.SMTP_USER}>`,
        to: to || process.env.REMAX_TEAM_EMAIL || 'info@remax-exclusive.cl',
        subject,
        html: body,
    });
}
