import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TheaterService } from './theater-service.js';
import * as theaterQueries from '../db/theater-queries.js';
import * as showtimeQueries from '../db/showtime-queries.js';
import * as reportQueries from '../db/report-queries.js';
import * as busProducer from './bus-producer.js';
import { type DB } from '../db/index.js';
import { isValidAllocineUrl, extractTheaterIdFromUrl } from '../utils/url.js';

vi.mock('../db/theater-queries.js');
vi.mock('../db/showtime-queries.js');
vi.mock('../db/report-queries.js');
vi.mock('./bus-producer.js');
vi.mock('../utils/url.js', () => ({
  isValidAllocineUrl: vi.fn(() => true),
  extractTheaterIdFromUrl: vi.fn(() => 'C0013'),
  cleanTheaterUrl: vi.fn(() => 'https://cleaned-url'),
}));

describe('TheaterService', () => {
  let theaterService: TheaterService;
  const mockDb = {
    transaction: vi.fn(async (callback: (transaction: DB) => Promise<unknown>) => callback(mockDb as DB)),
  } as unknown as DB;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isValidAllocineUrl).mockReturnValue(true);
    vi.mocked(extractTheaterIdFromUrl).mockReturnValue('C0013');
    theaterService = new TheaterService(mockDb);
  });

  describe('getAllTheaters', () => {
    it('should call getTheaters query', async () => {
      vi.mocked(theaterQueries.getTheaters).mockResolvedValue([{ id: '1', name: 'Theater' }] as any);
      const result = await theaterService.getAllTheaters();
      expect(result).toHaveLength(1);
      expect(theaterQueries.getTheaters).toHaveBeenCalledWith(mockDb);
    });
  });

  describe('getTheaterShowtimes', () => {
    it('should call getShowtimesByTheaterAndWeek query', async () => {
      vi.mocked(showtimeQueries.getShowtimesByTheaterAndWeek).mockResolvedValue([] as any);
      await theaterService.getTheaterShowtimes('C1', '2026-03-11');
      expect(showtimeQueries.getShowtimesByTheaterAndWeek).toHaveBeenCalledWith(mockDb, 'C1', '2026-03-11');
    });
  });

  describe('addTheaterViaUrl', () => {
    it('should throw if URL too long', async () => {
      await expect(theaterService.addTheaterViaUrl('a'.repeat(2049))).rejects.toThrow('URL is too long');
    });

    it('should throw if URL invalid', async () => {
      const { isValidAllocineUrl } = await import('../utils/url.js');
      vi.mocked(isValidAllocineUrl).mockReturnValue(false);
      await expect(theaterService.addTheaterViaUrl('http://bad')).rejects.toThrow('Invalid Allocine URL');
    });

    it('should throw if theater ID cannot be extracted', async () => {
      const { extractTheaterIdFromUrl } = await import('../utils/url.js');
      vi.mocked(extractTheaterIdFromUrl).mockReturnValue(null);
      await expect(theaterService.addTheaterViaUrl('http://valid')).rejects.toThrow('Could not extract theater ID');
    });

    it('should add theater and enqueue job on success', async () => {
      const mockEnqueue = vi.fn().mockResolvedValue(1);
      vi.mocked(busProducer.getBusProducer).mockReturnValue({ enqueueAddTheaterJob: mockEnqueue } as any);
      vi.mocked(reportQueries.createScrapeReport).mockResolvedValue(42 as any);
      vi.mocked(theaterQueries.addTheater).mockResolvedValue({ id: 'C0013' } as any);

      const result = await theaterService.addTheaterViaUrl('http://valid');

      expect(result.id).toBe('C0013');
      expect(mockEnqueue.mock.calls[0][0]).toBe(42);
      expect(mockEnqueue.mock.calls[0][1]).toBe('https://cleaned-url');
    });
  });

  describe('addTheaterManual — field validation through the add() interface', () => {
    it('accepts a valid id + name + url', async () => {
      vi.mocked(theaterQueries.addTheater).mockResolvedValue({ id: 'C1' } as any);
      const result = await theaterService.addTheaterManual('C1', 'Grand Rex', 'https://www.allocine.fr/x');
      expect(result.id).toBe('C1');
    });

    it('rejects a non-alphanumeric id', async () => {
      await expect(
        theaterService.addTheaterManual('id!', 'Name', 'https://www.allocine.fr/x'),
      ).rejects.toThrow('Invalid ID format');
    });

    it('rejects an id with spaces', async () => {
      await expect(
        theaterService.addTheaterManual('id space', 'Name', 'https://www.allocine.fr/x'),
      ).rejects.toThrow('Invalid ID format');
    });

    it('rejects an id longer than 20 chars', async () => {
      await expect(
        theaterService.addTheaterManual('a'.repeat(21), 'Name', 'https://www.allocine.fr/x'),
      ).rejects.toThrow('too long');
    });

    it('rejects a non-string id', async () => {
      await expect(
        theaterService.addTheaterManual(42 as any, 'Name', 'https://www.allocine.fr/x'),
      ).rejects.toThrow('Invalid ID format');
    });

    it('rejects an empty name', async () => {
      await expect(
        theaterService.addTheaterManual('C1', '', 'https://www.allocine.fr/x'),
      ).rejects.toThrow('between 1 and 100');
    });

    it('rejects a name longer than 100 chars', async () => {
      await expect(
        theaterService.addTheaterManual('C1', 'a'.repeat(101), 'https://www.allocine.fr/x'),
      ).rejects.toThrow('between 1 and 100');
    });

    it('rejects a non-string name', async () => {
      await expect(
        theaterService.addTheaterManual('C1', 123 as any, 'https://www.allocine.fr/x'),
      ).rejects.toThrow('between 1 and 100');
    });

    it('rejects a url longer than 2048 chars', async () => {
      await expect(
        theaterService.addTheaterManual('C1', 'Name', 'a'.repeat(2049)),
      ).rejects.toThrow('too long');
    });

    it('rejects a non-allocine url', async () => {
      vi.mocked(isValidAllocineUrl).mockReturnValue(false);
      await expect(
        theaterService.addTheaterManual('C1', 'Name', 'https://bad.com'),
      ).rejects.toThrow('Invalid Allocine URL');
    });

    it('short-circuits on the first invalid field — id before name', async () => {
      // Combination: id, name, and url are all invalid. The first validator (id)
      // fires; the caller never sees name/url errors. This documents the order.
      vi.mocked(isValidAllocineUrl).mockReturnValue(false);
      await expect(
        theaterService.addTheaterManual('bad id!', '', 'not-a-url'),
      ).rejects.toThrow('Invalid ID format');
    });

    it('translates a duplicate-key DB error into a ValidationError', async () => {
      vi.mocked(theaterQueries.addTheater).mockRejectedValue(new Error('duplicate key'));
      await expect(
        theaterService.addTheaterManual('C1', 'Name', 'https://www.allocine.fr/x'),
      ).rejects.toThrow('already exists');
    });

    it('re-throws non-duplicate-key DB errors unchanged', async () => {
      const boom = new Error('boom');
      vi.mocked(theaterQueries.addTheater).mockRejectedValue(boom);
      await expect(
        theaterService.addTheaterManual('C1', 'Name', 'https://www.allocine.fr/x'),
      ).rejects.toBe(boom);
    });
  });

  describe('updateTheater — combination validation through the update() interface', () => {
    it('rejects an empty payload', async () => {
      await expect(theaterService.updateTheater('C1', {})).rejects.toThrow(
        'At least one field must be provided',
      );
    });

    it('rejects a payload of only empty strings (treated as missing)', async () => {
      await expect(
        theaterService.updateTheater('C1', { name: '', url: '', address: '' }),
      ).rejects.toThrow('At least one field must be provided');
    });

    it('rejects a payload of only nulls', async () => {
      await expect(
        theaterService.updateTheater('C1', { name: null as any, url: null as any }),
      ).rejects.toThrow('At least one field must be provided');
    });

    it('rejects a name that is too long', async () => {
      await expect(
        theaterService.updateTheater('C1', { name: 'a'.repeat(101) }),
      ).rejects.toThrow('between 1 and 100');
    });

    it('rejects a non-allocine url', async () => {
      vi.mocked(isValidAllocineUrl).mockReturnValue(false);
      await expect(
        theaterService.updateTheater('C1', { url: 'https://bad.com' }),
      ).rejects.toThrow('Invalid Allocine URL');
    });

    it('rejects an address that is too long', async () => {
      await expect(
        theaterService.updateTheater('C1', { address: 'a'.repeat(201) }),
      ).rejects.toThrow('at most 200');
    });

    it('rejects a postal_code that is too long', async () => {
      await expect(
        theaterService.updateTheater('C1', { postal_code: 'a'.repeat(11) }),
      ).rejects.toThrow('at most 10');
    });

    it('rejects a postal_code with special characters', async () => {
      await expect(
        theaterService.updateTheater('C1', { postal_code: '75001!' }),
      ).rejects.toThrow('alphanumeric');
    });

    it('rejects a city that is too long', async () => {
      await expect(
        theaterService.updateTheater('C1', { city: 'a'.repeat(101) }),
      ).rejects.toThrow('at most 100');
    });

    it('throws NotFoundError when the theater does not exist', async () => {
      vi.mocked(theaterQueries.updateTheaterConfig).mockResolvedValue(undefined);
      await expect(theaterService.updateTheater('C1', { name: 'New' })).rejects.toThrow('not found');
    });

    it('accepts and forwards a single valid field', async () => {
      vi.mocked(theaterQueries.updateTheaterConfig).mockResolvedValue({ id: 'C1', name: 'New' } as any);
      const result = await theaterService.updateTheater('C1', { name: 'New' });
      expect(result.name).toBe('New');
      expect(theaterQueries.updateTheaterConfig).toHaveBeenCalledWith(mockDb, 'C1', { name: 'New' });
    });

    it('accepts and forwards a combination of all valid fields together', async () => {
      vi.mocked(theaterQueries.updateTheaterConfig).mockResolvedValue({ id: 'C1' } as any);
      await theaterService.updateTheater('C1', {
        name: 'New Name',
        url: 'https://www.allocine.fr/x',
        address: '1 rue de Paris',
        postal_code: '75001',
        city: 'Paris',
      });
      expect(theaterQueries.updateTheaterConfig).toHaveBeenCalledWith(mockDb, 'C1', {
        name: 'New Name',
        url: 'https://www.allocine.fr/x',
        address: '1 rue de Paris',
        postal_code: '75001',
        city: 'Paris',
      });
    });

    it('forwards an empty string as undefined (reset) alongside a real update', async () => {
      // name passes the at-least-one-field check; the empty strings for the
      // location fields are forwarded as `undefined`, signaling "clear this field".
      vi.mocked(theaterQueries.updateTheaterConfig).mockResolvedValue({ id: 'C1' } as any);
      await theaterService.updateTheater('C1', {
        name: 'New',
        address: '',
        postal_code: '',
        city: '',
      });
      expect(theaterQueries.updateTheaterConfig).toHaveBeenCalledWith(mockDb, 'C1', {
        name: 'New',
        address: undefined,
        postal_code: undefined,
        city: undefined,
      });
    });

    it('short-circuits on the first invalid field in a combination — name before postal_code', async () => {
      // Combination: name + postal_code are both invalid. Name validates first
      // and the postal_code error is never raised. This documents field order.
      await expect(
        theaterService.updateTheater('C1', { name: 'a'.repeat(101), postal_code: 'bad!' }),
      ).rejects.toThrow('between 1 and 100');
      expect(theaterQueries.updateTheaterConfig).not.toHaveBeenCalled();
    });

    it('does not call the DB when validation fails', async () => {
      await expect(theaterService.updateTheater('C1', { postal_code: 'bad!' })).rejects.toThrow();
      expect(theaterQueries.updateTheaterConfig).not.toHaveBeenCalled();
    });
  });

  describe('deleteTheater', () => {
    it('should throw if not found', async () => {
      vi.mocked(theaterQueries.deleteTheater).mockResolvedValue(false);
      await expect(theaterService.deleteTheater('C1')).rejects.toThrow('not found');
    });

    it('should return true on success', async () => {
      vi.mocked(theaterQueries.deleteTheater).mockResolvedValue(true);
      const result = await theaterService.deleteTheater('C1');
      expect(result).toBe(true);
    });
  });
});
