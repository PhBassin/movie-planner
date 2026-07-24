/**
 * Host-side database initializer.
 *
 * Applies the consolidated `docker/init.sql` baseline to the configured
 * PostgreSQL database. Intended for the host-application development path
 * (Node 24 running on the host with PostgreSQL provided separately), where the
 * Docker postgres image is not performing the first-start init automatically.
 *
 * Targets an EMPTY database. The baseline uses `CREATE TABLE` (not
 * `IF NOT EXISTS`) so re-running against a partially initialized database fails
 * loudly instead of masking an inconsistent state. To reinitialize, drop and
 * recreate the database first.
 *
 * Usage: npm run server:db:init
 */
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { db } from './internal/client.js';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main(): Promise<void> {
  const initSqlPath = join(__dirname, '../../../docker/init.sql');
  logger.info(`Applying database baseline from ${initSqlPath}...`);

  const sql = await readFile(initSqlPath, 'utf8');
  await db.query(sql);

  logger.info('✅ Database baseline applied successfully');
}

main()
  .then(() => db.end())
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`❌ Database baseline initialization failed: ${message}`);
    db.end().finally(() => {
      process.exit(1);
    });
  });
