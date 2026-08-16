import { CorsOptions } from 'cors';

export interface CorsConfigOptions {
  strict?: boolean;
}

/**
 * The parsed CORS allow-list. Single source of truth for everything that
 * reads `ALLOWED_ORIGINS` (CORS checks, email link origins).
 */
export function getAllowedOrigins(): string[] {
  const allowedOriginsEnv = process.env.ALLOWED_ORIGINS;
  return allowedOriginsEnv
    ? allowedOriginsEnv.split(',').map((origin) => origin.trim())
    : ['http://localhost:3000', 'http://localhost:5173']; // Web and Vite dev server
}

export const getCorsOptions = (opts: CorsConfigOptions = {}): CorsOptions => {
  const { strict = false } = opts;
  const allowedOrigins = getAllowedOrigins();

  return {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // Strict mode: block requests with no origin (prevents sandboxed iframe attacks)
      if (strict && (!origin || origin === 'null')) {
        return callback(
          new Error(
            `CORS blocked request with no or null origin in strict mode. ` +
            `Requests to this endpoint must include a valid Origin header.`
          )
        );
      }

      // Lenient mode: allow requests with no origin (mobile apps or curl requests)
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.indexOf(origin) !== -1) {
        return callback(null, true);
      } else {
        return callback(
          new Error(
            `CORS blocked request from origin '${origin}'. ` +
            `Add this origin to ALLOWED_ORIGINS in your .env file. ` +
            `Current ALLOWED_ORIGINS: ${allowedOrigins.join(',')}. ` +
            `See docs/guides/deployment/networking.md for details.`
          )
        );
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  };
};
