import type { Request } from 'express';
import type { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { getSecrets, verifyWithMultipleSecrets } from '../utils/jwt-secrets.js';
import { logger } from '../utils/logger.js';
import { getCurrentConfig, subscribe, type RateLimitConfig } from '../services/rate-limit-source.js';

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

function limiterWindowMs(config: RateLimitConfig, key: keyof RateLimitConfig): number {
  return config[key] as number;
}

function limiterMax(config: RateLimitConfig, key: keyof RateLimitConfig): number {
  return config[key] as number;
}

const generalLimiterMiddleware = createRefreshableLimiter(
  () => getCurrentConfig().windowMs,
  () => limiterMax(getCurrentConfig(), 'generalMax'),
  { skip: skipTest, standardHeaders: true }
);
export const generalLimiter = generalLimiterMiddleware.handler;

const authLimiterMiddleware = createRefreshableLimiter(
  () => getCurrentConfig().windowMs,
  () => limiterMax(getCurrentConfig(), 'authMax'),
  { skip: skipTest, skipSuccessfulRequests: true }
);
export const authLimiter = authLimiterMiddleware.handler;

const registerLimiterMiddleware = createRefreshableLimiter(
  () => limiterWindowMs(getCurrentConfig(), 'registerWindowMs'),
  () => limiterMax(getCurrentConfig(), 'registerMax'),
  { skip: skipTest }
);
export const registerLimiter = registerLimiterMiddleware.handler;

const protectedLimiterMiddleware = createRefreshableLimiter(
  () => getCurrentConfig().windowMs,
  () => limiterMax(getCurrentConfig(), 'protectedMax'),
  { skip: skipTest, keyGenerator: authenticatedKeyGenerator, standardHeaders: true }
);
export const protectedLimiter = protectedLimiterMiddleware.handler;

const scraperLimiterMiddleware = createRefreshableLimiter(
  () => getCurrentConfig().windowMs,
  () => limiterMax(getCurrentConfig(), 'scraperMax'),
  { skip: skipTest, keyGenerator: authenticatedKeyGenerator }
);
export const scraperLimiter = scraperLimiterMiddleware.handler;

const publicLimiterMiddleware = createRefreshableLimiter(
  () => getCurrentConfig().windowMs,
  () => limiterMax(getCurrentConfig(), 'publicMax'),
  { skip: skipTest }
);
export const publicLimiter = publicLimiterMiddleware.handler;

const healthCheckLimiterMiddleware = createRefreshableLimiter(
  () => limiterWindowMs(getCurrentConfig(), 'healthWindowMs'),
  () => limiterMax(getCurrentConfig(), 'healthMax'),
  {
    skip: skipInternal,
    standardHeaders: true,
    message: {
      success: false,
      error: 'Too many health check requests',
    },
  }
);
export const healthCheckLimiter = healthCheckLimiterMiddleware.handler;

const allMiddleware = [
  generalLimiterMiddleware,
  authLimiterMiddleware,
  registerLimiterMiddleware,
  protectedLimiterMiddleware,
  scraperLimiterMiddleware,
  publicLimiterMiddleware,
  healthCheckLimiterMiddleware,
];

subscribe(() => {
  for (const m of allMiddleware) {
    m.refresh();
  }
});

export function refreshRateLimits(): void {
  for (const m of allMiddleware) {
    m.refresh();
  }
}