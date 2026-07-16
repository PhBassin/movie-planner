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

interface LimiterSpec {
  windowKey: keyof RateLimitConfig;
  maxKey: keyof RateLimitConfig;
  options: LimiterOptions;
}

// One declarative table drives every limiter. The factory below walks it once,
// collecting each refresh hook and wiring a single config-refresh subscription.
// Adding a limiter = add one entry here + one name in the destructure export.
const limiterSpecs = {
  generalLimiter: { windowKey: 'windowMs', maxKey: 'generalMax', options: { skip: skipTest, standardHeaders: true } },
  authLimiter: { windowKey: 'windowMs', maxKey: 'authMax', options: { skip: skipTest, skipSuccessfulRequests: true } },
  registerLimiter: { windowKey: 'registerWindowMs', maxKey: 'registerMax', options: { skip: skipTest } },
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

function buildRefreshable(spec: LimiterSpec) {
  return createRefreshableLimiter(
    () => getCurrentConfig()[spec.windowKey],
    () => getCurrentConfig()[spec.maxKey],
    spec.options,
  );
}

const handlers = {} as Record<LimiterName, RequestHandler>;
const refreshers: Array<() => void> = [];
for (const name of Object.keys(limiterSpecs) as LimiterName[]) {
  const { handler, refresh } = buildRefreshable(limiterSpecs[name]);
  handlers[name] = handler;
  refreshers.push(refresh);
}

export const {
  generalLimiter,
  authLimiter,
  registerLimiter,
  protectedLimiter,
  scraperLimiter,
  publicLimiter,
  healthCheckLimiter,
} = handlers;

subscribe(() => {
  for (const refresh of refreshers) {
    refresh();
  }
});
