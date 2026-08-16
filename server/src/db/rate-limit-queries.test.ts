import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { QueryResult } from 'pg';
import {
  updateRateLimits,
  resetRateLimits,
  getRateLimitAuditLog,
  getValidationConstraints,
  type RateLimitConfigRow,
} from './rate-limit-queries.js';
import type { DB } from './index.js';

// Helper to create mock QueryResult
function mockQueryResult<T = any>(rows: T[]): QueryResult<T> {
  return {
    rows,
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    fields: [],
  };
}

describe('rate-limit-queries', () => {
  const mockConfigRow: RateLimitConfigRow = {
    window_ms: 900000,
    general_max: 100,
    auth_max: 5,
    register_max: 3,
    register_window_ms: 3600000,
    verification_max: 3,
    verification_window_ms: 3600000,
    protected_max: 60,
    scraper_max: 10,
    public_max: 100,
    health_max: 10,
    health_window_ms: 60000,
    updated_at: '2026-03-25T10:00:00.000Z',
    updated_by: 1,
    environment: 'production',
  };

  describe('updateRateLimits', () => {
    it('should update rate limits and create audit log', async () => {
      const queries: any[] = [];
      const mockDb = {
        query: vi.fn((sql: string, params?: any[]) => {
          queries.push({ sql, params });
          
          if (sql === 'BEGIN') return Promise.resolve({ rows: [] });
          if (sql === 'COMMIT') return Promise.resolve({ rows: [] });
          if (sql.includes('FOR UPDATE')) {
            return Promise.resolve({ rows: [mockConfigRow] });
          }
          if (sql.includes('UPDATE rate_limit_configs')) {
            return Promise.resolve({
              rows: [{ ...mockConfigRow, general_max: 150, updated_by: 1 }]
            });
          }
          if (sql.includes('INSERT INTO rate_limit_audit_log')) {
            return Promise.resolve({ rows: [] });
          }
          return Promise.resolve({ rows: [] });
        }),
        end: vi.fn(),
      } as any as DB;

      const config = await updateRateLimits(
        mockDb,
        { generalMax: 150 },
        1,
        'admin',
        'admin',
        '127.0.0.1',
        'Test Agent'
      );

      expect(config.config.generalMax).toBe(150);
      
      // Verify transaction was used
      expect(queries[0].sql).toBe('BEGIN');
      expect(queries[queries.length - 1].sql).toBe('COMMIT');
      
      // Verify audit log was created
      const auditInsert = queries.find((q: any) => q.sql.includes('rate_limit_audit_log'));
      expect(auditInsert).toBeDefined();
      expect(auditInsert.params).toContain('admin');
      expect(auditInsert.params).toContain('general_max');
      expect(auditInsert.params).toContain('100'); // old value
      expect(auditInsert.params).toContain('150'); // new value
    });

    it('should not update if no changes', async () => {
      const queries: any[] = [];
      const mockDb = {
        query: vi.fn((sql: string) => {
          queries.push(sql);
          
          if (sql === 'BEGIN') return Promise.resolve({ rows: [] });
          if (sql === 'ROLLBACK') return Promise.resolve({ rows: [] });
          if (sql.includes('FOR UPDATE')) {
            return Promise.resolve({ rows: [mockConfigRow] });
          }
          return Promise.resolve({ rows: [] });
        }),
        end: vi.fn(),
      } as any as DB;

      const config = await updateRateLimits(
        mockDb,
        { generalMax: 100 }, // Same as current
        1,
        'admin',
        'admin',
        '127.0.0.1',
        'Test Agent'
      );

      expect(config.config.generalMax).toBe(100);
      
      // Should rollback, not commit
      expect(queries).toContain('ROLLBACK');
      expect(queries).not.toContain('COMMIT');
    });

    it('should rollback on error', async () => {
      const queries: any[] = [];
      const mockDb = {
        query: vi.fn((sql: string) => {
          queries.push(sql);
          
          if (sql === 'BEGIN') return Promise.resolve({ rows: [] });
          if (sql === 'ROLLBACK') return Promise.resolve({ rows: [] });
          if (sql.includes('FOR UPDATE')) {
            return Promise.resolve({ rows: [mockConfigRow] });
          }
          if (sql.includes('UPDATE rate_limit_configs')) {
            throw new Error('Update failed');
          }
          return Promise.resolve({ rows: [] });
        }),
        end: vi.fn(),
      } as any as DB;

      await expect(
        updateRateLimits(mockDb, { generalMax: 150 }, 1, 'admin', 'admin', '127.0.0.1', 'Test')
      ).rejects.toThrow('Update failed');
      
      expect(queries).toContain('ROLLBACK');
    });

    it('should handle multiple field updates', async () => {
      const queries: any[] = [];
      const mockDb = {
        query: vi.fn((sql: string, params?: any[]) => {
          queries.push({ sql, params });
          
          if (sql === 'BEGIN') return Promise.resolve({ rows: [] });
          if (sql === 'COMMIT') return Promise.resolve({ rows: [] });
          if (sql.includes('FOR UPDATE')) {
            return Promise.resolve({ rows: [mockConfigRow] });
          }
          if (sql.includes('UPDATE rate_limit_configs')) {
            return Promise.resolve({
              rows: [{
                ...mockConfigRow,
                general_max: 150,
                auth_max: 10,
                scraper_max: 20,
              }]
            });
          }
          if (sql.includes('INSERT INTO rate_limit_audit_log')) {
            return Promise.resolve({ rows: [] });
          }
          return Promise.resolve({ rows: [] });
        }),
        end: vi.fn(),
      } as any as DB;

      await updateRateLimits(
        mockDb,
        { generalMax: 150, authMax: 10, scraperMax: 20 },
        1,
        'admin',
        'admin',
        '127.0.0.1',
        'Test'
      );

      // Should create 3 audit log entries
      const auditInserts = queries.filter((q: any) => q.sql.includes('rate_limit_audit_log'));
      expect(auditInserts).toHaveLength(3);
    });
  });

  describe('resetRateLimits', () => {
    it('should reset all values to defaults', async () => {
      const mockDb = {
        query: vi.fn((sql: string) => {
          if (sql === 'BEGIN') return Promise.resolve({ rows: [] });
          if (sql === 'COMMIT') return Promise.resolve({ rows: [] });
          if (sql.includes('FOR UPDATE')) {
            return Promise.resolve({
              rows: [{
                ...mockConfigRow,
                general_max: 500, // Non-default
                auth_max: 20,
              }]
            });
          }
          if (sql.includes('UPDATE rate_limit_configs')) {
            return Promise.resolve({
              rows: [{
                ...mockConfigRow,
                general_max: 100, // Reset to default
                auth_max: 5,
              }]
            });
          }
          if (sql.includes('INSERT INTO rate_limit_audit_log')) {
            return Promise.resolve({ rows: [] });
          }
          return Promise.resolve({ rows: [] });
        }),
        end: vi.fn(),
      } as any as DB;

      const config = await resetRateLimits(mockDb, 1, 'admin', 'admin', '127.0.0.1', 'Test');

      expect(config.config.generalMax).toBe(100);
      expect(config.config.authMax).toBe(5);
    });

    it('should source defaults from the canonical RateLimitSource — single source of truth', async () => {
      const { DEFAULT_CONFIG } = await import('../services/rate-limit-source.js');

      const dirtyRow = {
        ...mockConfigRow,
        general_max: 500,
        auth_max: 20,
        scraper_max: 99,
      };

      const updateCalls: { params: any[] }[] = [];
      const mockDb = {
        query: vi.fn((sql: string, params?: any[]) => {
          if (sql === 'BEGIN' || sql === 'COMMIT') {
            return Promise.resolve({ rows: [] });
          }
          if (sql.includes('FOR UPDATE')) {
            return Promise.resolve({ rows: [dirtyRow] });
          }
          if (sql.includes('UPDATE rate_limit_configs')) {
            updateCalls.push({ params: params ?? [] });
            return Promise.resolve({ rows: [mockConfigRow] });
          }
          if (sql.includes('INSERT INTO rate_limit_audit_log')) {
            return Promise.resolve({ rows: [] });
          }
          return Promise.resolve({ rows: [] });
        }),
        end: vi.fn(),
      } as any as DB;

      await resetRateLimits(mockDb, 1, 'admin', 'admin', '127.0.0.1', 'Test');

      expect(updateCalls).toHaveLength(1);
      const params = updateCalls[0].params;
      const expected = [
        DEFAULT_CONFIG.generalMax,
        DEFAULT_CONFIG.authMax,
        DEFAULT_CONFIG.scraperMax,
      ];
      for (const value of expected) {
        expect(params).toContain(value);
      }
    });
  });

  describe('getRateLimitAuditLog', () => {
    it('should fetch audit log with pagination', async () => {
      const mockLogs = [
        {
          id: 1,
          changed_at: '2026-03-25T10:00:00Z',
          changed_by: 1,
          changed_by_username: 'admin',
          changed_by_role: 'admin',
          field_name: 'general_max',
          old_value: '100',
          new_value: '150',
          user_ip: '127.0.0.1',
          user_agent: 'Test Agent',
        },
      ];

      const mockDb = {
        query: vi.fn()
          .mockResolvedValueOnce({ rows: mockLogs })
          .mockResolvedValueOnce({ rows: [{ total: '1' }] }),
        end: vi.fn(),
      } as any as DB;

      const result = await getRateLimitAuditLog(mockDb, {
        limit: 50,
        offset: 0,
      });

      expect(result.logs).toEqual(mockLogs);
      expect(result.total).toBe(1);
      expect(result.limit).toBe(50);
      expect(result.offset).toBe(0);
    });

    it('should filter by userId', async () => {
      const mockDb = {
        query: vi.fn((sql: string, params?: any[]) => {
          if (sql.includes('WHERE changed_by')) {
            expect(params).toContain(1);
          }
          return Promise.resolve({ rows: [] });
        }).mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [{ total: '0' }] }),
        end: vi.fn(),
      } as any as DB;

      await getRateLimitAuditLog(mockDb, {
        limit: 50,
        offset: 0,
        userId: 1,
      });

      expect(mockDb.query).toHaveBeenCalled();
    });
  });

  describe('getValidationConstraints', () => {
    it('should return validation constraints for all fields', () => {
      const constraints = getValidationConstraints();

      expect(constraints.windowMs).toEqual({ min: 60000, max: 3600000, unit: 'milliseconds' });
      expect(constraints.generalMax).toEqual({ min: 10, max: 1000, unit: 'requests' });
      expect(constraints.authMax).toEqual({ min: 3, max: 50, unit: 'requests' });
      expect(constraints.registerMax).toEqual({ min: 1, max: 20, unit: 'requests' });
      expect(constraints.verificationMax).toEqual({ min: 1, max: 20, unit: 'requests' });
      expect(constraints.verificationWindowMs).toEqual({ min: 300000, max: 86400000, unit: 'milliseconds' });
      expect(constraints.healthWindowMs).toEqual({ min: 60000, max: 60000, unit: 'milliseconds' });
    });

    it('should have constraints for all config fields', () => {
      const constraints = getValidationConstraints();
      const expectedFields = [
        'windowMs',
        'generalMax',
        'authMax',
        'registerMax',
        'registerWindowMs',
        'verificationMax',
        'verificationWindowMs',
        'protectedMax',
        'scraperMax',
        'publicMax',
        'healthMax',
        'healthWindowMs',
      ];

      for (const field of expectedFields) {
        expect(constraints[field]).toBeDefined();
        expect(constraints[field].min).toBeGreaterThan(0);
        expect(constraints[field].max).toBeGreaterThanOrEqual(constraints[field].min);
        expect(constraints[field].unit).toBeTruthy();
      }
    });
  });
});
