import nodemailer from 'nodemailer';

type PasswordResetMailParams = {
  to: string;
  code: string;
  userName?: string;
};

type AdminRegisterMailParams = {
  to: string;
  code: string;
  userName?: string;
};

function getTransporter() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    auth: { user, pass },
  });
}

function buildPasswordResetHtml(code: string, userName?: string) {
  const firstName = userName?.trim()?.split(' ')[0] || 'usuário';

  return `
  <div style="margin:0;padding:24px;background:#f4f6fb;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb;">
      <tr>
        <td style="padding:24px;background:linear-gradient(135deg,#003b7a 0%,#001f54 100%);color:#ffffff;">
          <h1 style="margin:0;font-size:22px;">Saudy</h1>
          <p style="margin:8px 0 0;font-size:14px;opacity:0.9;">Recuperação de senha</p>
        </td>
      </tr>
      <tr>
        <td style="padding:28px;">
          <p style="margin:0 0 16px;font-size:16px;">Olá, ${firstName}.</p>
          <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#334155;">
            Recebemos uma solicitação para redefinir sua senha. Use o código abaixo para continuar o processo:
          </p>

          <div style="margin:0 auto 20px;max-width:240px;background:#eef2ff;border:1px dashed #4f46e5;border-radius:12px;padding:14px 16px;text-align:center;">
            <span style="display:block;font-size:30px;font-weight:700;letter-spacing:8px;color:#1e293b;">${code}</span>
          </div>

          <p style="margin:0 0 8px;font-size:13px;color:#475569;">Esse código expira em 10 minutos.</p>
          <p style="margin:0;font-size:13px;color:#475569;">Se você não solicitou essa alteração, pode ignorar este e-mail com segurança.</p>
        </td>
      </tr>
      <tr>
        <td style="padding:18px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;">
          <p style="margin:0;font-size:12px;color:#64748b;">© ${new Date().getFullYear()} Saudy — Segurança da sua conta em primeiro lugar.</p>
        </td>
      </tr>
    </table>
  </div>
  `;
}

function buildAdminRegisterHtml(code: string, userName?: string) {
  const firstName = userName?.trim()?.split(' ')[0] || 'administrador';

  return `
  <div style="margin:0;padding:24px;background:#f4f6fb;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb;">
      <tr>
        <td style="padding:24px;background:linear-gradient(135deg,#003b7a 0%,#001f54 100%);color:#ffffff;">
          <h1 style="margin:0;font-size:22px;">Saudy</h1>
          <p style="margin:8px 0 0;font-size:14px;opacity:0.9;">Confirmação de acesso ADM</p>
        </td>
      </tr>
      <tr>
        <td style="padding:28px;">
          <p style="margin:0 0 16px;font-size:16px;">Olá, ${firstName}.</p>
          <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#334155;">
            Use o código abaixo para confirmar seu cadastro de administrador e liberar acesso ao ADM Hub:
          </p>

          <div style="margin:0 auto 20px;max-width:240px;background:#eef2ff;border:1px dashed #4f46e5;border-radius:12px;padding:14px 16px;text-align:center;">
            <span style="display:block;font-size:30px;font-weight:700;letter-spacing:8px;color:#1e293b;">${code}</span>
          </div>

          <p style="margin:0 0 8px;font-size:13px;color:#475569;">Esse código expira em 10 minutos.</p>
          <p style="margin:0;font-size:13px;color:#475569;">Se você não solicitou esse acesso, ignore este e-mail.</p>
        </td>
      </tr>
      <tr>
        <td style="padding:18px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;">
          <p style="margin:0;font-size:12px;color:#64748b;">© ${new Date().getFullYear()} Saudy — Confirmação de identidade administrativa.</p>
        </td>
      </tr>
    </table>
  </div>
  `;
}

export async function sendPasswordResetCodeEmail({ to, code, userName }: PasswordResetMailParams) {
  const transporter = getTransporter();

  if (!transporter) {
    console.warn('SMTP is not configured. Skipping password reset email send.');
    return false;
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@saudy.local';

  await transporter.sendMail({
    from,
    to,
    subject: 'Saudy | Código de recuperação de senha',
    text: `Seu código de recuperação de senha é: ${code}. Esse código expira em 10 minutos.`,
    html: buildPasswordResetHtml(code, userName),
  });

  return true;
}

export async function sendAdminRegisterCodeEmail({ to, code, userName }: AdminRegisterMailParams) {
  const transporter = getTransporter();

  if (!transporter) {
    console.warn('SMTP is not configured. Skipping admin register email send.');
    return false;
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@saudy.local';

  await transporter.sendMail({
    from,
    to,
    subject: 'Saudy | Código de confirmação ADM',
    text: `Seu código para confirmar o cadastro ADM é: ${code}. Esse código expira em 10 minutos.`,
    html: buildAdminRegisterHtml(code, userName),
  });

  return true;
}
