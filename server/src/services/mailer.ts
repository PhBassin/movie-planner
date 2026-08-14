import nodemailer from 'nodemailer';
import { logger } from '../utils/logger.js';

/**
 * Mailer — the auth-only email module (ADR 0005: verification and password
 * reset, never submission outcomes).
 *
 * The transport is the swappable seam: with `SMTP_HOST` set the mailer sends
 * through a real SMTP relay (nodemailer); without it, an in-memory transport
 * captures every message into a process-wide mailbox that tests and local
 * development inspect instead of standing up a relay. The default sender
 * identity mirrors the Branding `email_from_*` defaults and can be overridden
 * via `SMTP_FROM_NAME` / `SMTP_FROM_ADDRESS`.
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

const DEFAULT_FROM_NAME = 'Movie Planner';
const DEFAULT_FROM_ADDRESS = 'no-reply@movie-planner.local';

function fromHeader(): string {
  const name = process.env.SMTP_FROM_NAME ?? DEFAULT_FROM_NAME;
  const address = process.env.SMTP_FROM_ADDRESS ?? DEFAULT_FROM_ADDRESS;
  return `${name} <${address}>`;
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
  return !process.env.SMTP_HOST && process.env.NODE_ENV !== 'production';
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

/** Test hook: drop the cached mailer/mailbox so each test re-resolves env. */
export function resetMailerForTests(): void {
  cachedMailer = null;
  inMemoryMailbox = null;
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

function createInMemoryMailer(): Mailer {
  if (inMemoryMailbox === null) {
    inMemoryMailbox = [];
  }
  return {
    async send(message: MailMessage): Promise<void> {
      inMemoryMailbox!.push({ from: fromHeader(), ...message });
    },
  };
}

function createSmtpMailer(): Mailer {
  const host = process.env.SMTP_HOST!;
  const port = Number(process.env.SMTP_PORT ?? 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    ...(user && pass ? { auth: { user, pass } } : {}),
  });

  return {
    async send(message: MailMessage): Promise<void> {
      await transport.sendMail({ from: fromHeader(), ...message });
    },
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

let cachedMailer: Mailer | null = null;

/**
 * Resolve the process-wide mailer. SMTP when configured; in-memory in test
 * and development so the verification flow works end-to-end with no relay;
 * a logged no-op in production without SMTP (email is load-bearing — the
 * warning exists so a misconfigured instance is visible in logs).
 */
export function createMailer(): Mailer {
  if (process.env.SMTP_HOST) {
    return createSmtpMailer();
  }
  if (process.env.NODE_ENV !== 'production') {
    return createInMemoryMailer();
  }
  logger.warn(
    'SMTP_HOST is not set: outgoing auth email (verification, password reset) is disabled. ' +
    'Members cannot verify their address until SMTP is configured.',
  );
  return { async send() { /* no-op: see warning above */ } };
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
