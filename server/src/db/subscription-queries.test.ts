import { describe, expect, it } from 'vitest';
import { paidThroughSubscriptionExistsSql } from './subscription-queries.js';

describe('Subscription queries', () => {
  it('matches a non-terminal Subscription paid through the database clock', () => {
    const sql = paidThroughSubscriptionExistsSql('$1');

    expect(sql).toContain('EXISTS');
    expect(sql).toContain('member_id = $1');
    expect(sql).toContain("status <> 'ended'");
    expect(sql).toContain('paid_through > statement_timestamp()');
  });
});
