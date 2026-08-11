import { createApp } from './app.js';
import { db } from './db/internal/client.js';
import { initializeDatabase } from './db/schema.js';
import { logger } from './utils/logger.js';
import { validateJWTSecret } from './utils/jwt-secret-validator.js';

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    logger.info('🚀 Starting Movie Planner Server...\n');

    // Validate JWT secret before proceeding
    logger.info('🔐 Validating JWT configuration...');
    validateJWTSecret();
    
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

    // Subscribe to PostgreSQL progress notifications and forward to SSE clients
    const { getBusProducer } = await import('./services/bus-producer.js');
    const { progressTracker } = await import('./services/progress-tracker.js');

    const busProducer = getBusProducer();
    await busProducer.subscribeToProgress((event) => {
      progressTracker.emit(event);
    });

    logger.info('📡 PostgreSQL progress subscription active (scrape:progress)');

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
