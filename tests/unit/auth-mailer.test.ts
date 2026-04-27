import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMail, createTransport } = vi.hoisted(() => {
  const sendMailMock = vi.fn();
  const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }));
  return { sendMail: sendMailMock, createTransport: createTransportMock };
});

vi.mock('nodemailer', () => ({
  default: {
    createTransport,
  },
}));

import {
  getTransporter,
  sendAdminRegisterCodeEmail,
  sendPasswordResetCodeEmail,
  sendPatientPortalAccessCodeEmail,
  sendWelcomeEmail,
} from '../../src/modules/auth/lib/mailer';

const ORIGINAL_ENV = process.env;

describe('auth mailer lib', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.SMTP_FROM;
    delete process.env.SMTP_SECURE;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('returns null transporter when smtp credentials are missing', () => {
    expect(getTransporter()).toBeNull();
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('creates transporter with secure true for port 465 and SMTP_SECURE=true', () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = '465';
    process.env.SMTP_USER = 'user@example.com';
    process.env.SMTP_PASS = 'pass';
    process.env.SMTP_SECURE = 'true';

    const transporter = getTransporter();

    expect(transporter).toBeTruthy();
    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      auth: { user: 'user@example.com', pass: 'pass' },
    });
  });

  it('sends password reset email and normalizes SMTP_FROM with display name', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'mailer@example.com';
    process.env.SMTP_PASS = 'pass';
    process.env.SMTP_FROM = 'Equipe Saudy mailer@example.com';

    sendMail.mockResolvedValue({});

    const ok = await sendPasswordResetCodeEmail({ to: 'to@mail.com', code: '123456', userName: 'Joao Silva' });

    expect(ok).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0]).toMatchObject({
      from: 'Equipe Saudy <mailer@example.com>',
      to: 'to@mail.com',
      subject: 'Saudy | Código de recuperação de senha',
    });
    expect(sendMail.mock.calls[0][0].html).toContain('Joao');
    expect(sendMail.mock.calls[0][0].html).toContain('123456');
  });

  it('returns false for password reset when smtp is not configured', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const ok = await sendPasswordResetCodeEmail({ to: 'to@mail.com', code: '123456' });

    expect(ok).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('sends patient portal and admin register emails', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_USER = 'mailer@example.com';
    process.env.SMTP_PASS = 'pass';
    process.env.SMTP_FROM = 'Saudy <noreply@saudy.com>';

    sendMail.mockResolvedValue({});

    const patient = await sendPatientPortalAccessCodeEmail({
      to: 'patient@mail.com',
      code: '111222',
      userName: 'Maria Souza',
    });
    const admin = await sendAdminRegisterCodeEmail({
      to: 'admin@etechdev',
      code: '333444',
      userName: 'Admin Master',
    });

    expect(patient).toBe(true);
    expect(admin).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(sendMail.mock.calls[0][0].subject).toContain('Portal do Paciente');
    expect(sendMail.mock.calls[1][0].subject).toContain('confirmação ADM');
  });

  it('sends welcome email with fallback user name and plain from email', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_USER = 'mailer@example.com';
    process.env.SMTP_PASS = 'pass';
    process.env.SMTP_FROM = 'noreply@saudy.com';

    sendMail.mockResolvedValue({});

    const ok = await sendWelcomeEmail({
      to: 'user@mail.com',
      login: 'user@mail.com',
      password: 'Strong@123',
    });

    expect(ok).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0]).toMatchObject({
      from: 'noreply@saudy.com',
      to: 'user@mail.com',
      subject: 'Saudy | Bem-vindo(a) ao sistema',
    });
    expect(sendMail.mock.calls[0][0].html).toContain('usuário');
    expect(sendMail.mock.calls[0][0].text).toContain('Login: user@mail.com');
  });

  it('returns false for welcome/admin/patient when smtp is not configured', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(sendWelcomeEmail({ to: 'x', login: 'x', password: 'x' })).resolves.toBe(false);
    await expect(sendAdminRegisterCodeEmail({ to: 'x', code: '111111' })).resolves.toBe(false);
    await expect(sendPatientPortalAccessCodeEmail({ to: 'x', code: '222222' })).resolves.toBe(false);

    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(sendMail).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
