/**
 * App-level email seam (SaaS, feat/saas).
 *
 * NOTE: auth emails (signup confirm / password reset / magic link) are NOT
 * sent through here — GoTrue sends those; configure SMTP_HOST/SMTP_USER/... in
 * .saas-stack/.env (see .saas-stack/README.md). This seam is for app-level
 * transactional mail a commercial deployment will want: payment receipts,
 * quota warnings, operator notifications.
 *
 * Ships with the `log` provider (writes to the server log, no delivery).
 * To send real mail: implement EmailProvider (Resend / SMTP / 邮件推送),
 * register it in `providers`, set EMAIL_PROVIDER + keys in env.
 */
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

const providers: Record<string, () => EmailProvider> = {
  log: () => logProvider,
  // resend: () => resendProvider,  // <- real integrations register here
};

/** Active provider, selected by EMAIL_PROVIDER (default: log). */
export function getEmailProvider(): EmailProvider {
  const id = (process.env.EMAIL_PROVIDER ?? 'log').trim() || 'log';
  const factory = providers[id];
  if (!factory) {
    log.warn(`unknown EMAIL_PROVIDER '${id}', falling back to log`);
    return logProvider;
  }
  return factory();
}
