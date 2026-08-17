import type { DB } from './index.js';
import {
  DEFAULT_CONFIG,
  type RateLimitAuditInfo,
  type RateLimitConfig,
  type RateLimitConfigRow,
} from '../services/rate-limit-source.js';

export type { RateLimitConfigRow };

export interface RateLimitAuditLogRow {
  id: number;
  changed_at: string;
  changed_by: number;
  changed_by_username: string;
  changed_by_role: string;
  field_name: string;
  old_value: string;
  new_value: string;
  user_ip: string | null;
  user_agent: string | null;
}

function rowToConfig(row: RateLimitConfigRow, source: 'database' | 'env' | 'default' = 'database'): RateLimitAuditInfo {
  return {
    config: {
      windowMs: row.window_ms,
      generalMax: row.general_max,
      authMax: row.auth_max,
      registerMax: row.register_max,
      registerWindowMs: row.register_window_ms,
      verificationMax: row.verification_max,
      verificationWindowMs: row.verification_window_ms,
      passwordResetMax: row.password_reset_max,
      passwordResetWindowMs: row.password_reset_window_ms,
      passwordResetEmailMax: row.password_reset_email_max,
      passwordResetEmailWindowMs: row.password_reset_email_window_ms,
      protectedMax: row.protected_max,
      scraperMax: row.scraper_max,
      publicMax: row.public_max,
      healthMax: row.health_max,
      healthWindowMs: row.health_window_ms,
    },
    source,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by ? { id: row.updated_by, username: '' } : null,
    environment: row.environment,
  };
}

export async function updateRateLimits(
  db: DB,
  updates: Partial<RateLimitConfig>,
  userId: number,
  username: string,
  roleName: string,
  userIp: string,
  userAgent: string
): Promise<RateLimitAuditInfo> {
  // Start transaction for atomic update + audit log
  await db.query('BEGIN');
  
  try {
    // Get current values for audit log
    const currentResult = await db.query<RateLimitConfigRow>(
      'SELECT * FROM rate_limit_configs WHERE id = 1 FOR UPDATE'
    );
    const current = currentResult.rows[0];
    
    // Build dynamic UPDATE query
    const fields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;
    
    const fieldMap: Record<string, string> = {
      windowMs: 'window_ms',
      generalMax: 'general_max',
      authMax: 'auth_max',
      registerMax: 'register_max',
      registerWindowMs: 'register_window_ms',
      verificationMax: 'verification_max',
      verificationWindowMs: 'verification_window_ms',
      passwordResetMax: 'password_reset_max',
      passwordResetWindowMs: 'password_reset_window_ms',
      passwordResetEmailMax: 'password_reset_email_max',
      passwordResetEmailWindowMs: 'password_reset_email_window_ms',
      protectedMax: 'protected_max',
      scraperMax: 'scraper_max',
      publicMax: 'public_max',
      healthMax: 'health_max',
      healthWindowMs: 'health_window_ms',
    };
    
    // Track changes for audit log
    const auditEntries: Array<{ field: string; oldValue: string; newValue: string }> = [];
    
    for (const [camelKey, snakeKey] of Object.entries(fieldMap)) {
      if (camelKey in updates) {
        const newValue = updates[camelKey as keyof RateLimitConfig];
        const oldValue = current[snakeKey as keyof RateLimitConfigRow];
        
        if (newValue !== oldValue && newValue !== undefined) {
          fields.push(`${snakeKey} = $${paramIndex}`);
          values.push(newValue);
          paramIndex++;
          
          auditEntries.push({
            field: snakeKey,
            oldValue: String(oldValue),
            newValue: String(newValue),
          });
        }
      }
    }
    
    if (fields.length === 0) {
      await db.query('ROLLBACK');
      return rowToConfig(current);
    }
    
    // Add metadata
    fields.push(`updated_at = NOW()`);
    fields.push(`updated_by = $${paramIndex}`);
    values.push(userId);
    
    const updateQuery = `
      UPDATE rate_limit_configs
      SET ${fields.join(', ')}
      WHERE id = 1
      RETURNING *
    `;
    
    const updateResult = await db.query<RateLimitConfigRow>(updateQuery, values);
    
    // Insert audit log entries
    for (const entry of auditEntries) {
      await db.query(
        `INSERT INTO rate_limit_audit_log 
         (changed_by, changed_by_username, changed_by_role, field_name, old_value, new_value, user_ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [userId, username, roleName, entry.field, entry.oldValue, entry.newValue, userIp, userAgent]
      );
    }
    
    await db.query('COMMIT');
    
    return rowToConfig(updateResult.rows[0]);
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

export async function resetRateLimits(
  db: DB,
  userId: number,
  username: string,
  roleName: string,
  userIp: string,
  userAgent: string
): Promise<RateLimitAuditInfo> {
  return updateRateLimits(db, DEFAULT_CONFIG, userId, username, roleName, userIp, userAgent);
}

export async function getRateLimitAuditLog(
  db: DB,
  options: { limit: number; offset: number; userId?: number }
): Promise<{ logs: RateLimitAuditLogRow[]; total: number; limit: number; offset: number }> {
  let query = 'SELECT * FROM rate_limit_audit_log';
  let countQuery = 'SELECT COUNT(*) as total FROM rate_limit_audit_log';
  const values: any[] = [];
  
  if (options.userId) {
    query += ' WHERE changed_by = $1';
    countQuery += ' WHERE changed_by = $1';
    values.push(options.userId);
  }
  
  query += ' ORDER BY changed_at DESC LIMIT $' + (values.length + 1) + ' OFFSET $' + (values.length + 2);
  values.push(options.limit, options.offset);
  
  const [logsResult, countResult] = await Promise.all([
    db.query<RateLimitAuditLogRow>(query, values),
    db.query<{ total: string }>(countQuery, options.userId ? [options.userId] : []),
  ]);
  
  return {
    logs: logsResult.rows,
    total: parseInt(countResult.rows[0].total),
    limit: options.limit,
    offset: options.offset,
  };
}

export interface ValidationConstraint {
  min: number;
  max: number;
  unit: string;
}

export function getValidationConstraints(): Record<string, ValidationConstraint> {
  return {
    windowMs: { min: 60000, max: 3600000, unit: 'milliseconds' },
    generalMax: { min: 10, max: 1000, unit: 'requests' },
    authMax: { min: 3, max: 50, unit: 'requests' },
    registerMax: { min: 1, max: 20, unit: 'requests' },
    registerWindowMs: { min: 300000, max: 86400000, unit: 'milliseconds' },
    verificationMax: { min: 1, max: 20, unit: 'requests' },
    verificationWindowMs: { min: 300000, max: 86400000, unit: 'milliseconds' },
    passwordResetMax: { min: 1, max: 20, unit: 'requests' },
    passwordResetWindowMs: { min: 300000, max: 86400000, unit: 'milliseconds' },
    passwordResetEmailMax: { min: 1, max: 20, unit: 'requests' },
    passwordResetEmailWindowMs: { min: 300000, max: 86400000, unit: 'milliseconds' },
    protectedMax: { min: 10, max: 500, unit: 'requests' },
    scraperMax: { min: 5, max: 100, unit: 'requests' },
    publicMax: { min: 20, max: 1000, unit: 'requests' },
    healthMax: { min: 5, max: 100, unit: 'requests' },
    healthWindowMs: { min: 60000, max: 60000, unit: 'milliseconds' }, // Fixed at 1 min
  };
}
