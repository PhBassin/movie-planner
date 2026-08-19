import type { DB } from './internal/client.js';
export type { DB };
export type DBQueryExecutor = Pick<DB, 'query'>;
