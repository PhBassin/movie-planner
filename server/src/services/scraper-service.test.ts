import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScraperService } from './scraper-service.js';
import * as reportQueries from '../db/report-queries.js';
import * as theaterQueries from '../db/theater-queries.js';
import * as busProducer from './bus-producer.js';
import { progressTracker } from './progress-tracker.js';
import { type DB } from '../db/index.js';

vi.mock('../db/report-queries.js');
vi.mock('../db/theater-queries.js');
vi.mock('./bus-producer.js');
vi.mock('./progress-tracker.js', () => ({
  progressTracker: {
    reset: vi.fn(),
  },
}));

describe('ScraperService', () => {
  let scraperService: ScraperService;
  const mockDb = {
    transaction: vi.fn(async (callback: (transaction: DB) => Promise<unknown>) => callback(mockDb as DB)),
  } as unknown as DB;

  beforeEach(() => {
    vi.clearAllMocks();
    scraperService = new ScraperService(mockDb);
  });

  describe('triggerScrape', () => {
    it('should throw error if theaterId provided but not found', async () => {
      vi.mocked(theaterQueries.getTheaterConfigs).mockResolvedValue([{ id: 'C1' }] as any);
      await expect(scraperService.triggerScrape({ theaterId: 'UNKNOWN' })).rejects.toThrow('Theater not found');
    });

    it('should trigger scrape successfully', async () => {
      const mockEnqueue = vi.fn().mockResolvedValue(1);
      vi.mocked(busProducer.getBusProducer).mockReturnValue({ enqueueJob: mockEnqueue } as any);
      vi.mocked(reportQueries.createScrapeReport).mockResolvedValue(42 as any);
      vi.mocked(theaterQueries.getTheaterConfigs).mockResolvedValue([{ id: 'C1' }] as any);

      const result = await scraperService.triggerScrape({ theaterId: 'C1', movieId: 123 });

      expect(result.reportId).toBe(42);
      expect(progressTracker.reset).toHaveBeenCalled();
      expect(mockEnqueue.mock.calls[0][0]).toEqual(expect.objectContaining({
        type: 'scrape',
        reportId: 42,
        options: { theaterId: 'C1', movieId: 123 }
      }));
    });
  });

  describe('getStatus', () => {
    it('should return status from latest report', async () => {
      vi.mocked(reportQueries.getLatestScrapeReport).mockResolvedValue({ id: 1, status: 'running' } as any);
      const result = await scraperService.getStatus();
      expect(result.isRunning).toBe(true);
      expect(result.latestReport?.id).toBe(1);
    });

    it('should return isRunning=false if no report', async () => {
      vi.mocked(reportQueries.getLatestScrapeReport).mockResolvedValue(undefined);
      const result = await scraperService.getStatus();
      expect(result.isRunning).toBe(false);
      expect(result.latestReport).toBeUndefined();
    });
  });

  describe('triggerResume', () => {
    it('should trigger resume scrape successfully with pending attempts', async () => {
      const mockEnqueue = vi.fn().mockResolvedValue(1);
      vi.mocked(busProducer.getBusProducer).mockReturnValue({ enqueueJob: mockEnqueue } as any);
      vi.mocked(reportQueries.createScrapeReport).mockResolvedValue(43 as any);

      const pendingAttempts = [
        { theater_id: 'C0042', date: '2026-03-26' },
        { theater_id: 'C0089', date: '2026-03-25' },
      ] as any;

      const result = await scraperService.triggerResume(123, pendingAttempts);

      expect(result.reportId).toBe(43);
      expect(progressTracker.reset).toHaveBeenCalled();
      expect(reportQueries.createScrapeReport).toHaveBeenCalledWith(mockDb, 'manual', 123);
      expect(mockEnqueue.mock.calls[0][0]).toEqual(expect.objectContaining({
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
      }));
    });

    it('should handle empty pending attempts list', async () => {
      const mockEnqueue = vi.fn().mockResolvedValue(1);
      vi.mocked(busProducer.getBusProducer).mockReturnValue({ enqueueJob: mockEnqueue } as any);
      vi.mocked(reportQueries.createScrapeReport).mockResolvedValue(44 as any);

      const result = await scraperService.triggerResume(123, []);

      expect(result.reportId).toBe(44);
      expect(mockEnqueue.mock.calls[0][0]).toEqual(expect.objectContaining({
        options: {
          resumeMode: true,
          pendingAttempts: [],
        },
      }));
    });
  });
});
