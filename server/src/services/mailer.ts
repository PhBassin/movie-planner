import nodemailer from 'nodemailer';
import { logger } from '../utils/logger.js';
import { parseStrictInt } from '../utils/number.js';

/**
 * Mailer — the auth-only email module (ADR 0005: verification and password
 * reset, never submission outcomes).
 *
 * The transport is the swappable seam: with `SMTP_HOST` set the mailer sends
 * through a real SMTP relay (nodemailer); without it, an in-memory transport
 * captures every message into a process-wide mailbox that tests and local
 * development inspect instead of standing up a relay. Email verification is
 * load-bearing (ADR 0003), so production refuses to start without `SMTP_HOST`
 * (`validateMailerConfiguration`, called at boot like `validateJWTSecret`) —
 * a misconfigured instance must be loud, not a silent no-op that strands
 * every Member as `unverified`.
 *
 * The default sender identity mirrors the Branding `email_from_*` defaults
 * (see the `app_settings` baseline in `docker/init.sql`; the mirror is pinned
 * by an integration test) and can be overridden via `SMTP_FROM_NAME` /
 * `SMTP_FROM_ADDRESS`.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SentMailMessage extends MailMessage {
  from: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export const DEFAULT_FROM_NAME = 'Movie Planner';
export const DEFAULT_FROM_ADDRESS = 'no-reply@movie-planner.local';

/** The sender identity, resolved once at mailer construction. */
interface SenderIdentity {
  readonly header: string;
}

function resolveSenderIdentity(): SenderIdentity {
  const name = process.env.SMTP_FROM_NAME ?? DEFAULT_FROM_NAME;
  const address = process.env.SMTP_FROM_ADDRESS ?? DEFAULT_FROM_ADDRESS;
  return { header: `${name} <${address}>` };
}

// ---------------------------------------------------------------------------
// Transport resolution — the single source of truth
// ---------------------------------------------------------------------------

export type MailerTransportMode = 'smtp' | 'memory';

/**
 * Resolve the transport mode from env. Every question about "which transport
 * is this process using?" (route mounting, mailbox visibility, mailer
 * creation) derives from this one function so the answers cannot drift.
 */
export function resolveMailerMode(): MailerTransportMode {
  return process.env.SMTP_HOST ? 'smtp' : 'memory';
}

/**
 * Startup validation (ADR 0003: verification is load-bearing). Production
 * without `SMTP_HOST` refuses to start — same shape as `validateJWTSecret`.
 * Outside production the in-memory transport takes over.
 */
export function validateMailerConfiguration(): void {
  if (process.env.NODE_ENV === 'production' && !process.env.SMTP_HOST) {
    logger.error('❌ SMTP_HOST is not set in production');
    throw new Error(
      'FATAL: SMTP_HOST is not set. Email verification is load-bearing ' +
      '(ADR 0003): without an SMTP relay, Members can never verify their ' +
      'address. Set SMTP_HOST (see .env.example) to start the server.',
    );
  }
}

// ---------------------------------------------------------------------------
// In-memory transport
// ---------------------------------------------------------------------------

let inMemoryMailbox: SentMailMessage[] | null = null;

/**
 * True when the mailer resolves to the in-memory transport. The
 * `/api/test/mailbox` seam keys off this so it can never be reachable
 * alongside a real SMTP transport.
 */
export function isInMemoryMailerActive(): boolean {
  return resolveMailerMode() === 'memory';
}

/**
 * The process-wide in-memory mailbox. Lazily created on first access so the
 * test seam (`/api/test/mailbox`) can read a mailbox even before the first
 * mail has been sent — without it, an empty mailbox is indistinguishable
 * from "no in-memory transport" and E2E polling would error instead of
 * seeing an empty list.
 */
export function getInMemoryMailbox(): SentMailMessage[] {
  if (inMemoryMailbox === null) {
    inMemoryMailbox = [];
  }
  return inMemoryMailbox;
}

/** Test seam: empty the in-memory mailbox without reaching into its state. */
export function clearInMemoryMailbox(): void {
  getInMemoryMailbox().length = 0;
}

/** Test hook: drop the cached mailer/mailbox so each test re-resolves env. */
export function resetMailerForTests(): void {
  cachedMailer = null;
  inMemoryMailbox = null;
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

function createInMemoryMailer(): Mailer {
  const mailbox = getInMemoryMailbox();
  const sender = resolveSenderIdentity();
  return {
    async send(message: MailMessage): Promise<void> {
      mailbox.push({ from: sender.header, ...message });
    },
  };
}

function createSmtpMailer(): Mailer {
  const host = process.env.SMTP_HOST!;
  const portEnv = process.env.SMTP_PORT ?? '587';
  const port = parseStrictInt(portEnv);
  if (Number.isNaN(port)) {
    logger.error('❌ SMTP_PORT is not a valid integer', { value: portEnv });
    throw new Error(
      `FATAL: SMTP_PORT must be an integer (got "${portEnv}"). ` +
      'Fix SMTP_PORT or unset it to use the default 587.',
    );
  }
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    ...(user && pass ? { auth: { user, pass } } : {}),
  });

  const sender = resolveSenderIdentity();

  return {
    async send(message: MailMessage): Promise<void> {
      await transport.sendMail({ from: sender.header, ...message });
    },
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

let cachedMailer: Mailer | null = null;

/**
 * Resolve the process-wide mailer from the single transport-mode source of
 * truth: SMTP when configured, in-memory otherwise (production is guaranteed
 * to have SMTP_HOST by `validateMailerConfiguration` at boot).
 */
export function createMailer(): Mailer {
  return resolveMailerMode() === 'smtp' ? createSmtpMailer() : createInMemoryMailer();
}

/**
 * The shared mailer instance. Resolved lazily on first use so importing a
 * module never triggers transport setup (keeps route tests free to mock).
 */
export function getMailer(): Mailer {
  if (cachedMailer === null) {
    cachedMailer = createMailer();
  }
  return cachedMailer;
}
