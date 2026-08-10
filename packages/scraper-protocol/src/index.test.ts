import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  serializeJob,
  parseJob,
  NOTIFICATION_CHANNELS,
  parseNotificationPayload,
  pgConnectionConfig,
} from './index.js';
import type { ScrapeJobScrape, ScrapeJobAddTheater } from './index.js';

describe('scraper-protocol', () => {
  describe('NOTIFICATION_CHANNELS', () => {
    it('names the three ephemeral LISTEN/NOTIFY channels', () => {
      expect(NOTIFICATION_CHANNELS).toEqual({
        progress: 'scrape:progress',
        scheduleChanged: 'scraper:schedule:changed',
        memberNotices: 'member:notices',
      });
    });
  });

  describe('parseNotificationPayload', () => {
    it('parses a valid JSON payload', () => {
      expect(parseNotificationPayload<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
    });

    it('returns null for malformed JSON instead of throwing', () => {
      expect(parseNotificationPayload('not-json')).toBeNull();
      expect(parseNotificationPayload('')).toBeNull();
    });
  });

  describe('pgConnectionConfig', () => {
    beforeEach(() => {
      delete process.env.DATABASE_URL;
      delete process.env.POSTGRES_USER;
      delete process.env.POSTGRES_PASSWORD;
      delete process.env.POSTGRES_HOST;
      delete process.env.POSTGRES_PORT;
      delete process.env.POSTGRES_DB;
    });

    afterEach(() => {
      delete process.env.DATABASE_URL;
      delete process.env.POSTGRES_USER;
      delete process.env.POSTGRES_PASSWORD;
      delete process.env.POSTGRES_HOST;
      delete process.env.POSTGRES_PORT;
      delete process.env.POSTGRES_DB;
    });

    it('prefers DATABASE_URL when set', () => {
      process.env.DATABASE_URL = 'postgres://user:pass@host/db';
      expect(pgConnectionConfig()).toEqual({ connectionString: 'postgres://user:pass@host/db' });
    });

    it('falls back to the POSTGRES_* variables', () => {
      process.env.POSTGRES_USER = 'u';
      process.env.POSTGRES_PASSWORD = 'p';
      process.env.POSTGRES_HOST = 'h';
      process.env.POSTGRES_PORT = '5444';
      process.env.POSTGRES_DB = 'd';
      expect(pgConnectionConfig()).toEqual({
        user: 'u',
        password: 'p',
        host: 'h',
        port: 5444,
        database: 'd',
      });
    });

    it('applies the sensible defaults and rejects a non-numeric port', () => {
      process.env.POSTGRES_PORT = 'not-a-port';
      expect(pgConnectionConfig()).toMatchObject({ user: 'postgres', host: 'localhost', port: 5432, database: 'movie_planner' });
    });
  });

  describe('parseJob / serializeJob', () => {
    it('round-trips a ScrapeJobScrape with resumeMode and pendingAttempts', () => {
      const job: ScrapeJobScrape = {
        type: 'scrape',
        reportId: 43,
        triggerType: 'manual',
        options: {
          resumeMode: true,
          pendingAttempts: [
            { theater_id: 'C0042', date: '2026-03-26' },
            { theater_id: 'C0089', date: '2026-03-25' },
          ],
        },
      };

      const wire = serializeJob(job);
      const parsed = parseJob(wire);

      expect(parsed).toEqual(job);
      expect(parsed.type).toBe('scrape');
      if (parsed.type === 'scrape') {
        expect(parsed.options?.resumeMode).toBe(true);
        expect(parsed.options?.pendingAttempts).toEqual([
          { theater_id: 'C0042', date: '2026-03-26' },
          { theater_id: 'C0089', date: '2026-03-25' },
        ]);
      }
    });

    it('round-trips a ScrapeJobScrape without options (the common manual trigger)', () => {
      const job: ScrapeJobScrape = {
        type: 'scrape',
        reportId: 1,
        triggerType: 'manual',
      };

      const parsed = parseJob(serializeJob(job));

      expect(parsed).toEqual(job);
    });

    it('round-trips a ScrapeJobScrape with options (mode, days, theaterId, movieId)', () => {
      const job: ScrapeJobScrape = {
        type: 'scrape',
        reportId: 7,
        triggerType: 'manual',
        options: {
          mode: 'from_today_limited',
          days: 7,
          theaterId: 'C0042',
          movieId: 123,
        },
      };

      const parsed = parseJob(serializeJob(job));

      expect(parsed).toEqual(job);
    });

    it('round-trips a ScrapeJobAddTheater', () => {
      const job: ScrapeJobAddTheater = {
        type: 'add_theater',
        reportId: 42,
        triggerType: 'manual',
        url: 'https://www.allocine.fr/seance/salle_gen_csalle=C0072.html',
      };

      const parsed = parseJob(serializeJob(job));

      expect(parsed).toEqual(job);
      expect(parsed.type).toBe('add_theater');
    });

    it('rejects malformed JSON', () => {
      expect(() => parseJob('not json')).toThrow();
    });

    it('rejects a job with an unknown type discriminator', () => {
      expect(() =>
        parseJob(JSON.stringify({ type: 'unknown', reportId: 1, triggerType: 'manual' }))
      ).toThrow('Invalid ScrapeJob');
    });

    it('rejects a job missing the required reportId', () => {
      expect(() =>
        parseJob(JSON.stringify({ type: 'scrape', triggerType: 'manual' }))
      ).toThrow('Invalid ScrapeJob');
    });

    it('rejects a scrape job with an invalid triggerType', () => {
      expect(() =>
        parseJob(
          JSON.stringify({ type: 'scrape', reportId: 1, triggerType: 'invalid' })
        )
      ).toThrow('Invalid ScrapeJob');
    });

    it('rejects an add_theater job missing url', () => {
      expect(() =>
        parseJob(JSON.stringify({ type: 'add_theater', reportId: 1, triggerType: 'manual' }))
      ).toThrow('Invalid ScrapeJob');
    });

    it('rejects non-object input', () => {
      expect(() => parseJob(JSON.stringify('scrape'))).toThrow('Invalid ScrapeJob');
      expect(() => parseJob(JSON.stringify(42))).toThrow('Invalid ScrapeJob');
      expect(() => parseJob(JSON.stringify(null))).toThrow('Invalid ScrapeJob');
    });

    it('rejects a scrape job with a malformed options.mode', () => {
      expect(() =>
        parseJob(
          JSON.stringify({ type: 'scrape', reportId: 1, triggerType: 'manual', options: { mode: 'not_a_real_mode' } })
        )
      ).toThrow('Invalid ScrapeJob');
    });

    it('rejects a scrape job with options.days of the wrong type', () => {
      expect(() =>
        parseJob(
          JSON.stringify({ type: 'scrape', reportId: 1, triggerType: 'manual', options: { days: 'seven' } })
        )
      ).toThrow('Invalid ScrapeJob');
    });

    it('rejects a scrape job with options.theaterId of the wrong type', () => {
      expect(() =>
        parseJob(
          JSON.stringify({ type: 'scrape', reportId: 1, triggerType: 'manual', options: { theaterId: 42 } })
        )
      ).toThrow('Invalid ScrapeJob');
    });

    it('rejects a scrape job with options.movieId of the wrong type', () => {
      expect(() =>
        parseJob(
          JSON.stringify({ type: 'scrape', reportId: 1, triggerType: 'manual', options: { movieId: 'abc' } })
        )
      ).toThrow('Invalid ScrapeJob');
    });

    it('rejects a scrape job with options.resumeMode of the wrong type', () => {
      expect(() =>
        parseJob(
          JSON.stringify({ type: 'scrape', reportId: 1, triggerType: 'manual', options: { resumeMode: 'yes' } })
        )
      ).toThrow('Invalid ScrapeJob');
    });

    it('rejects a scrape job with options.pendingAttempts of the wrong shape', () => {
      expect(() =>
        parseJob(
          JSON.stringify({ type: 'scrape', reportId: 1, triggerType: 'manual', options: { pendingAttempts: 'lol' } })
        )
      ).toThrow('Invalid ScrapeJob');
      expect(() =>
        parseJob(
          JSON.stringify({
            type: 'scrape',
            reportId: 1,
            triggerType: 'manual',
            options: { pendingAttempts: [{ theater_id: 'C0042' }] },
          })
        )
      ).toThrow('Invalid ScrapeJob');
    });

    it('rejects an add_theater job with an empty url', () => {
      expect(() =>
        parseJob(JSON.stringify({ type: 'add_theater', reportId: 1, triggerType: 'manual', url: '' }))
      ).toThrow('Invalid ScrapeJob');
    });
  });
});
