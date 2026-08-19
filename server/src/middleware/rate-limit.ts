import type { Request } from 'express';
import type { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { getSecrets, verifyWithMultipleSecrets } from '../utils/jwt-secrets.js';
import { logger } from '../utils/logger.js';
import { getCurrentConfig, subscribe, type RateLimitConfig } from '../services/rate-limit-source.js';
import { sha256NormalizedEmail } from '../services/auth-email.js';

function ipKeyGenerator(ip: string): string {
  return ip;
}

// Fail-fast: validate secrets at module load
getSecrets();

const skipTest = (req: any) => !req.ip;

const internalIPs = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const skipInternal = (req: any) => internalIPs.includes(req.ip ?? '');

interface LimiterOptions {
  skip?: (req: Request) => boolean;
  keyGenerator?: (req: Request) => string;
  skipSuccessfulRequests?: boolean;
  standardHeaders?: boolean;
  message?: string | object;
}

const createLimiterDelegate = (
  windowMs: number,
  limit: number,
  options: LimiterOptions = {}
): RequestHandler => rateLimit({
  windowMs,
  limit,
  skip: options.skip,
  keyGenerator: options.keyGenerator,
  skipSuccessfulRequests: options.skipSuccessfulRequests,
  standardHeaders: options.standardHeaders,
  legacyHeaders: false,
  message: options.message,
  validate: false,
});

const createRefreshableLimiter = (
  windowMs: () => number,
  limit: () => number,
  options: LimiterOptions = {}
): { handler: RequestHandler; refresh: () => void } => {
  let delegate = createLimiterDelegate(windowMs(), limit(), options);

  return {
    handler(req, res, next) {
      return delegate(req, res, next);
    },
    refresh() {
      delegate = createLimiterDelegate(windowMs(), limit(), options);
    },
  };
};

export const authenticatedKeyGenerator = (req: Request): string => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const verified = verifyWithMultipleSecrets(token, getSecrets()) as { id?: number } | null;
      if (verified?.id) return `user:${verified.id}`;
    }
  } catch (err) {
    logger.warn('Authenticated key generator fallback to IP', { error: err instanceof Error ? err.message : String(err) });
    // fall through to IP fallback
  }
  return ipKeyGenerator(req.ip ?? 'unknown');
};

/** Hash the normalized email so limiter keys do not retain mailbox addresses. */
export const passwordResetEmailKeyGenerator = (req: Request): string => {
  const email = typeof req.body?.email === 'string'
    ? req.body.email
    : '';
  return `password-reset-email:${sha256NormalizedEmail(email)}`;
};

interface LimiterSpec {
  windowKey: keyof RateLimitConfig;
  maxKey: keyof RateLimitConfig;
  options: LimiterOptions;
}

// One declarative table drives every limiter's window, max, and options.
// Each spec row is consumed by a dedicated `createRefreshableLimiter(...)` call
// below; the `allMiddleware` record wires the single config-refresh subscription
// and gives a compile-time completeness check (a missing or stale row is a TS error).
const limiterSpecs = {
  generalLimiter: { windowKey: 'windowMs', maxKey: 'generalMax', options: { skip: skipTest, standardHeaders: true } },
  authLimiter: { windowKey: 'windowMs', maxKey: 'authMax', options: { skip: skipTest, skipSuccessfulRequests: true } },
  registerLimiter: { windowKey: 'registerWindowMs', maxKey: 'registerMax', options: { skip: skipTest } },
  // Verification mail (verify-email + resend): a dedicated arm (peer of
  // register, ADR 0006 sub-decision 6) so resends cannot strand an
  // unverified Member behind a signup that exhausted the register budget
  // (and a signup flood cannot starve resends).
  verificationLimiter: { windowKey: 'verificationWindowMs', maxKey: 'verificationMax', options: { skip: skipTest } },
  passwordResetLimiter: { windowKey: 'passwordResetWindowMs', maxKey: 'passwordResetMax', options: { skip: skipTest, standardHeaders: true } },
  passwordResetEmailLimiter: { windowKey: 'passwordResetEmailWindowMs', maxKey: 'passwordResetEmailMax', options: { skip: skipTest, keyGenerator: passwordResetEmailKeyGenerator, standardHeaders: true } },
  protectedLimiter: { windowKey: 'windowMs', maxKey: 'protectedMax', options: { skip: skipTest, keyGenerator: authenticatedKeyGenerator, standardHeaders: true } },
  scraperLimiter: { windowKey: 'windowMs', maxKey: 'scraperMax', options: { skip: skipTest, keyGenerator: authenticatedKeyGenerator } },
  publicLimiter: { windowKey: 'windowMs', maxKey: 'publicMax', options: { skip: skipTest } },
  healthCheckLimiter: {
    windowKey: 'healthWindowMs',
    maxKey: 'healthMax',
    options: {
      skip: skipInternal,
      standardHeaders: true,
      message: {
        success: false,
        error: 'Too many health check requests',
      },
    },
  },
} satisfies Record<string, LimiterSpec>;

type LimiterName = keyof typeof limiterSpecs;

// Each limiter is constructed directly from its spec row and exported via a
// static `.handler` access. This shape is required for CodeQL's
// `js/missing-rate-limiting` query to trace an exported handler back to the
// `rateLimit(...)` call inside `createRefreshableLimiter` — a loop-based
// factory plus record indirection plus re-export destructuring breaks that
// data flow and surfaces false-positive alerts on routes that *are* limited.
// `allMiddleware` restores the compile-time completeness check: every spec
// row must have a matching middleware entry here, or TS errors.
const generalLimiterMiddleware = createRefreshableLimiter(
  () => getCurrentConfig()[limiterSpecs.generalLimiter.windowKey],
  () => getCurrentConfig()[limiterSpecs.generalLimiter.maxKey],
  limiterSpecs.generalLimiter.options,
);
const authLimiterMiddleware = createRefreshableLimiter(
  () => getCurrentConfig()[limiterSpecs.authLimiter.windowKey],
  () => getCurrentConfig()[limiterSpecs.authLimiter.maxKey],
  limiterSpecs.authLimiter.options,
);
const registerLimiterMiddleware = createRefreshableLimiter(
  () => getCurrentConfig()[limiterSpecs.registerLimiter.windowKey],
  () => getCurrentConfig()[limiterSpecs.registerLimiter.maxKey],
  limiterSpecs.registerLimiter.options,
);
const verificationLimiterMiddleware = createRefreshableLimiter(
  () => getCurrentConfig()[limiterSpecs.verificationLimiter.windowKey],
  () => getCurrentConfig()[limiterSpecs.verificationLimiter.maxKey],
  limiterSpecs.verificationLimiter.options,
);
const passwordResetLimiterMiddleware = createRefreshableLimiter(
  () => getCurrentConfig()[limiterSpecs.passwordResetLimiter.windowKey],
  () => getCurrentConfig()[limiterSpecs.passwordResetLimiter.maxKey],
  limiterSpecs.passwordResetLimiter.options,
);
const passwordResetEmailLimiterMiddleware = createRefreshableLimiter(
  () => getCurrentConfig()[limiterSpecs.passwordResetEmailLimiter.windowKey],
  () => getCurrentConfig()[limiterSpecs.passwordResetEmailLimiter.maxKey],
  limiterSpecs.passwordResetEmailLimiter.options,
);
const protectedLimiterMiddleware = createRefreshableLimiter(
  () => getCurrentConfig()[limiterSpecs.protectedLimiter.windowKey],
  () => getCurrentConfig()[limiterSpecs.protectedLimiter.maxKey],
  limiterSpecs.protectedLimiter.options,
);
const scraperLimiterMiddleware = createRefreshableLimiter(
  () => getCurrentConfig()[limiterSpecs.scraperLimiter.windowKey],
  () => getCurrentConfig()[limiterSpecs.scraperLimiter.maxKey],
  limiterSpecs.scraperLimiter.options,
);
const publicLimiterMiddleware = createRefreshableLimiter(
  () => getCurrentConfig()[limiterSpecs.publicLimiter.windowKey],
  () => getCurrentConfig()[limiterSpecs.publicLimiter.maxKey],
  limiterSpecs.publicLimiter.options,
);
const healthCheckLimiterMiddleware = createRefreshableLimiter(
  () => getCurrentConfig()[limiterSpecs.healthCheckLimiter.windowKey],
  () => getCurrentConfig()[limiterSpecs.healthCheckLimiter.maxKey],
  limiterSpecs.healthCheckLimiter.options,
);

const allMiddleware: Record<LimiterName, { handler: RequestHandler; refresh: () => void }> = {
  generalLimiter: generalLimiterMiddleware,
  authLimiter: authLimiterMiddleware,
  registerLimiter: registerLimiterMiddleware,
  verificationLimiter: verificationLimiterMiddleware,
  passwordResetLimiter: passwordResetLimiterMiddleware,
  passwordResetEmailLimiter: passwordResetEmailLimiterMiddleware,
  protectedLimiter: protectedLimiterMiddleware,
  scraperLimiter: scraperLimiterMiddleware,
  publicLimiter: publicLimiterMiddleware,
  healthCheckLimiter: healthCheckLimiterMiddleware,
};

export const generalLimiter = generalLimiterMiddleware.handler;
export const authLimiter = authLimiterMiddleware.handler;
export const registerLimiter = registerLimiterMiddleware.handler;
export const verificationLimiter = verificationLimiterMiddleware.handler;
export const passwordResetLimiter = passwordResetLimiterMiddleware.handler;
export const passwordResetEmailLimiter = passwordResetEmailLimiterMiddleware.handler;
export const protectedLimiter = protectedLimiterMiddleware.handler;
export const scraperLimiter = scraperLimiterMiddleware.handler;
export const publicLimiter = publicLimiterMiddleware.handler;
export const healthCheckLimiter = healthCheckLimiterMiddleware.handler;

subscribe(() => {
  for (const middleware of Object.values(allMiddleware)) {
    middleware.refresh();
  }
});
