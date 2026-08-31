import { createApp } from './app.js';
import { db } from './db/internal/client.js';
import { initializeDatabase } from './db/schema.js';
import { logger } from './utils/logger.js';
import { validateJWTSecret } from './utils/jwt-secret-validator.js';
import { validateMailerConfiguration } from './services/mailer.js';

const PORT = process.env.PORT || 3000;
const AUTH_EMAIL_TOKEN_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SUBMISSION_RECONCILIATION_INTERVAL_MS = 60 * 1000;
let authEmailTokenCleanupInterval: ReturnType<typeof setInterval> | null = null;
let submissionReconciliationInterval: ReturnType<typeof setInterval> | null = null;

async function startServer() {
  try {
    logger.info('🚀 Starting Movie Planner Server...\n');

    // Validate JWT secret before proceeding
    logger.info('🔐 Validating JWT configuration...');
    validateJWTSecret();

    // Email verification is load-bearing (ADR 0003): production refuses to
    // start without an SMTP relay instead of silently never sending mail.
    validateMailerConfiguration();

    // Log JWT configuration
    const jwtExpiration = process.env.JWT_EXPIRES_IN || '1h';
    logger.info(`🔐 JWT expiration set to: ${jwtExpiration}`);

    // Validate JWT expiry vs access token cookie maxAge
    const { validateJwtExpirationForCookie } = await import('./utils/jwt-config.js');
    const ACCESS_TOKEN_COOKIE_MAX_AGE_MS = 15 * 60 * 1000;
    validateJwtExpirationForCookie(jwtExpiration, ACCESS_TOKEN_COOKIE_MAX_AGE_MS);

    // Initialize database
    logger.info('📦 Initializing database...');
    await initializeDatabase();

    // Keep abandoned verification/reset rows bounded after the startup sweep.
    // Consumption and supersession delete rows immediately; this catches only
    // tokens whose owners never followed the link.
    const { cleanupExpiredAuthEmailTokens } = await import('./repositories/auth-email-token-repository.js');
    const cleanupAuthEmailTokens = async () => {
      try {
        await cleanupExpiredAuthEmailTokens(db);
      } catch (error) {
        logger.warn('Failed to clean up expired auth email tokens', { error });
      }
    };
    authEmailTokenCleanupInterval = setInterval(() => {
      void cleanupAuthEmailTokens();
    }, AUTH_EMAIL_TOKEN_CLEANUP_INTERVAL_MS);
    authEmailTokenCleanupInterval.unref();

    // Subscribe to PostgreSQL progress notifications and forward to SSE clients
    const { getBusProducer } = await import('./services/bus-producer.js');
    const { progressTracker } = await import('./services/progress-tracker.js');
    const { memberNotificationTracker } = await import('./services/member-notification-tracker.js');
    const { SubmissionResolutionService } = await import('./services/submission-resolver.js');

    const busProducer = getBusProducer();
    const submissionResolver = new SubmissionResolutionService(db);

    await busProducer.subscribeToProgress((event) => {
      progressTracker.emit(event);
      // Live resolution path (ADR 0005 sub-decision 7): a terminal event whose
      // reportId joins a pending theater_submissions row resolves it.
      submissionResolver.onProgressEvent(event);
    });

    logger.info('📡 PostgreSQL progress subscription active (scrape:progress)');

    // Route Member-domain notices to their Member's live SSE connections —
    // a dumb per-memberId router (ADR 0005 sub-decision 4).
    await busProducer.subscribeToMemberNotices((notice) => {
      memberNotificationTracker.emit(notice);
    });

    logger.info('📡 PostgreSQL member notices subscription active (member:notices)');

    // Reconciliation sweep (ADR 0005 sub-decision 8): pending submissions
    // whose ScrapeReport already went terminal resolve through the same
    // routine — once at startup, then every ~60s. Idempotent via the
    // `pending` status guard, so a missed live event heals here.
    try {
      await submissionResolver.reconcilePendingSubmissions();
    } catch (error) {
      logger.warn('Startup submission reconciliation failed', { error });
    }
    submissionReconciliationInterval = setInterval(() => {
      void submissionResolver.reconcilePendingSubmissions().catch((error) => {
        logger.warn('Submission reconciliation sweep failed', { error });
      });
    }, SUBMISSION_RECONCILIATION_INTERVAL_MS);
    submissionReconciliationInterval.unref();

    // Create Express app
    const app = createApp();

    // Register database connection for dependency injection
    app.set('db', db);

    // Initialize rate-limit source from DB (falls back to env if DB unreachable),
    // then start the background poller for hot-reload.
    const { loadFromDb } = await import('./services/rate-limit-source.js');
    const { startConfigRefresher } = await import('./services/rate-limit-refresher.js');
    await loadFromDb(db);
    startConfigRefresher(db);

    // Start server
    const server = app.listen(Number(PORT), () => {
      logger.info(`✅ Server running on port ${PORT}`);
      logger.info(`📍 API available at http://localhost:${PORT}/api`);
      logger.info(`📍 Health check: http://localhost:${PORT}/api/health`);
    });

    // Graceful shutdown
    const shutdown = async () => {
      logger.info('\n⏹️  Shutting down gracefully...');

      if (authEmailTokenCleanupInterval) {
        clearInterval(authEmailTokenCleanupInterval);
        authEmailTokenCleanupInterval = null;
      }

      if (submissionReconciliationInterval) {
        clearInterval(submissionReconciliationInterval);
        submissionReconciliationInterval = null;
      }

      // Disconnect the Postgres-backed bus
      const { getBusProducer: getProducer } = await import('./services/bus-producer.js');
      await getProducer().disconnect().catch(() => {});

      // Close server
      server.close(() => {
        logger.info('✅ Server closed');
        process.exit(0);
      });

      // Force exit after 10 seconds
      setTimeout(() => {
        logger.error('⚠️  Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

  } catch (error) {
    // Log only the error message to prevent sensitive data exposure
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`❌ Failed to start server: ${errorMessage}`);
    process.exit(1);
  }
}

// Start the server
startServer();
