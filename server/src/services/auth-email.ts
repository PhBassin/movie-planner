import crypto from 'crypto';
import type { DB } from '../db/index.js';
import { getUserByEmail, type MemberCredentialRow } from '../db/member-queries.js';
import {
  issueAuthEmailToken,
  type AuthEmailTokenPurpose,
} from '../repositories/auth-email-token-repository.js';
import { logger } from '../utils/logger.js';
import { getAllowedOrigins } from '../utils/cors-config.js';
import type { Mailer } from './mailer.js';

/**
 * The shared auth-email pipeline (CONTEXT.md → Auth email token): both
 * emailed credentials — verification and password reset — run the same
 * lookup → eligibility → token → link → best-effort send shape. This module
 * owns that shape so the two services cannot drift; each supplies its
 * purpose, link path, copy, and eligibility predicate.
 *
 * Logs and limiter keys never carry the raw address: the canonical
 * `sha256NormalizedEmail` hash (full digest for limiter keys, short prefix
 * for log fingerprints) is the only email-derived value that leaves the
 * pipeline.
 */

/**
 * The public origin used to build absolute links in auth emails. Defaults to
 * the first ALLOWED_ORIGINS entry (the canonical web origin), parsed by the
 * same helper the CORS middleware uses.
 */
function getPublicWebOrigin(): string {
  if (process.env.PUBLIC_WEB_ORIGIN) {
    return process.env.PUBLIC_WEB_ORIGIN.replace(/\/$/, '');
  }
  return getAllowedOrigins()[0].replace(/\/$/, '');
}

/** SHA-256 of the trimmed, lowercased email — the canonical email hash. */
export function sha256NormalizedEmail(email: string): string {
  return crypto.createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex');
}

/** Short log-safe fingerprint of an email (never the address itself). */
export function hashEmailForLog(email: string): string {
  return sha256NormalizedEmail(email).slice(0, 16);
}

export interface AuthEmailContent {
  subject: string;
  text: string;
  html: string;
}

/** Everything the pipeline needs from one emailed credential. */
export interface AuthLinkEmailSpec {
  purpose: AuthEmailTokenPurpose;
  /** Client path the emailed link targets (must end with `?token=`). */
  path: string;
  /** Log label, e.g. 'Password reset' — prefixes the pipeline's log lines. */
  label: string;
  /** Eligibility beyond existence; an ineligible lookup is a silent no-op. */
  eligible: (user: MemberCredentialRow) => boolean;
  /** Reason logged when a found user fails `eligible` (never surfaced). */
  ineligibleReason: string;
  buildEmail: (url: string) => AuthEmailContent;
}

/**
 * Issue a fresh token for `email` and send the link, or silently no-op for
 * an unknown/ineligible address. Every send-path failure is logged and
 * swallowed — the caller's response must never depend on the mailer
 * (enumeration safety, ADR 0006 sub-decision 6).
 */
export async function sendAuthLinkEmail(
  db: DB,
  mailer: Mailer,
  email: string,
  spec: AuthLinkEmailSpec,
): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase();
  const emailHash = hashEmailForLog(normalizedEmail);
  const user = await getUserByEmail(db, normalizedEmail);
  if (!user || !spec.eligible(user)) {
    logger.info(`${spec.label} email request ignored`, {
      emailHash,
      reason: user ? spec.ineligibleReason : 'unknown_email',
    });
    return;
  }

  const rawToken = await issueAuthEmailToken(db, user.id, spec.purpose);
  const url = `${getPublicWebOrigin()}${spec.path}${rawToken}`;
  const { subject, text, html } = spec.buildEmail(url);

  try {
    await mailer.send({ to: user.email, subject, text, html });
    logger.info(`${spec.label} email sent`, { userId: user.id, emailHash });
  } catch (error) {
    logger.error(`${spec.label} email send failed`, {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Fire-and-forget dispatch of an auth email: the public request routes call
 * this so the response never waits on — or fails on — the send path (ADR
 * 0006 sub-decision 6's timing-oracle closure). Rejections here are
 * infrastructure failures (token store, mailer); they are logged with a
 * hashed email fingerprint, never surfaced to the caller.
 */
export function dispatchAuthEmail(label: string, email: string, work: () => Promise<void>): void {
  void work().catch((error: unknown) => {
    logger.error(`${label} dispatch failed`, {
      emailHash: hashEmailForLog(email),
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
