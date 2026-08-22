import type { DB, TransactionClient } from './internal/client.js';
export type { DB, TransactionClient };
export type DBQueryExecutor = Pick<DB, 'query'>;
