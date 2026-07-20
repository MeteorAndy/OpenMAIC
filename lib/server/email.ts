/**
 * App-level email (SaaS, feat/saas).
 *
 * NOTE: auth emails (signup confirm / password reset / magic link) are NOT
 * sent through here — GoTrue sends those; configure SMTP_* in
 * .saas-stack/.env (see .saas-stack/README.md). This module is for app-level
 * transactional mail: plan-activated notices, receipts, operator alerts.
 *
 * Providers (EMAIL_PROVIDER):
 *   smtp — real delivery via nodemailer. Env: SMTP_HOST, SMTP_PORT,
 *          SMTP_SECURE ("true" for 465/SSL), SMTP_USER, SMTP_PASS, SMTP_FROM
 *          (defaults to SMTP_USER). Same account GoTrue uses is fine.
 *   log  — writes to the server log only (default when unconfigured, so a
 *          missing mail setup never breaks provisioning).
 * More providers (Resend / 邮件推送 HTTP APIs): implement EmailProvider and
 * register in `providers`.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { createLogger } from '@/lib/logger';

const log = createLogger('Email');

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

export interface EmailProvider {
  readonly id: string;
  send(msg: EmailMessage): Promise<void>;
}

const logProvider: EmailProvider = {
  id: 'log',
  send: (msg) => {
    log.info(`[email:log] to=${msg.to} subject=${msg.subject}`);
    return Promise.resolve();
  },
};

function createSmtpProvider(): EmailProvider {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error('EMAIL_PROVIDER=smtp requires SMTP_HOST, SMTP_USER and SMTP_PASS');
  }
  let transporter: Transporter | null = null;
  const getTransporter = (): Transporter => {
    if (!transporter) {
      transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: Number(SMTP_PORT ?? (SMTP_SECURE === 'true' ? 465 : 587)),
        secure: SMTP_SECURE === 'true',
        auth: { user: SMTP_USER, pass: SMTP_PASS },
      });
    }
    return transporter;
  };
  return {
    id: 'smtp',
    async send(msg) {
      await getTransporter().sendMail({
        from: SMTP_FROM || SMTP_USER,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
      });
      log.info(`[email:smtp] sent to=${msg.to} subject=${msg.subject}`);
    },
  };
}

const providers: Record<string, () => EmailProvider> = {
  log: () => logProvider,
  smtp: createSmtpProvider,
  // resend: () => resendProvider,  // <- HTTP-API providers register here
};

/**
 * Active provider. EMAIL_PROVIDER unset/unknown or SMTP env incomplete ->
 * log fallback (email is never a hard dependency of a business flow).
 */
export function getEmailProvider(): EmailProvider {
  const id = (process.env.EMAIL_PROVIDER ?? 'log').trim() || 'log';
  const factory = providers[id];
  if (!factory) {
    log.warn(`unknown EMAIL_PROVIDER '${id}', falling back to log`);
    return logProvider;
  }
  try {
    return factory();
  } catch (err) {
    log.warn(`email provider '${id}' misconfigured (${err instanceof Error ? err.message : err}); falling back to log`);
    return logProvider;
  }
}
