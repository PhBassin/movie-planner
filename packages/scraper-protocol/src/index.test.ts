import { describe, it, expect } from 'vitest';
import { serializeJob, parseJob } from './index.js';
import type { ScrapeJobScrape, ScrapeJobAddTheater } from './index.js';

describe('scraper-protocol', () => {
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

    it('round-trips a ScrapeJobScrape with traceContext', () => {
      const job: ScrapeJobScrape = {
        type: 'scrape',
        reportId: 9,
        triggerType: 'cron',
        traceContext: { traceparent: '00-aaaa-bbbb-01' },
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

    it('rejects a scrape job with a non-string-record traceContext', () => {
      expect(() =>
        parseJob(
          JSON.stringify({ type: 'scrape', reportId: 1, triggerType: 'manual', traceContext: { traceparent: 7 } })
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
