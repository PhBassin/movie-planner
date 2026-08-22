import { getShowtimesByTheaterAndWeek } from '../db/showtime-queries.js';
import { createScrapeReport } from '../db/report-queries.js';
import { getTheaters, addTheater, updateTheaterConfig, deleteTheater } from '../db/theater-queries.js';
import { extractTheaterIdFromUrl, cleanTheaterUrl, isValidAllocineUrl } from '../utils/url.js';
import { getBusProducer } from './bus-producer.js';
import { logger } from '../utils/logger.js';
import { ValidationError, NotFoundError, isUniqueViolation } from '../utils/errors.js';
import type { BusTransaction } from '@movie-planner/scraper-protocol';
import type { DB } from '../db/index.js';

// --- Theater field rules ---------------------------------------------------
//
// The Theater module owns its own validation. These rules are implementation
// detail of the module; the public surface (addTheaterViaUrl /
// addTheaterManual / updateTheater) is the only test seam. Combination
// behavior — "is this *whole* payload valid?" — is exercised through it.

const THEATER_ID_MAX_LENGTH = 20;
const THEATER_NAME_MAX_LENGTH = 100;
const THEATER_URL_MAX_LENGTH = 2048;
const THEATER_ADDRESS_MAX_LENGTH = 200;
const THEATER_POSTAL_CODE_MAX_LENGTH = 10;
const THEATER_CITY_MAX_LENGTH = 100;

const UPDATE_FIELDS = ['name', 'url', 'address', 'postal_code', 'city'] as const;

function validateTheaterId(id: string): void {
  if (typeof id !== 'string' || !/^[A-Za-z0-9]+$/.test(id)) {
    throw new ValidationError('Invalid ID format. Must be alphanumeric string.');
  }
  if (id.length > THEATER_ID_MAX_LENGTH) {
    throw new ValidationError('ID is too long (max 20 characters)');
  }
}

function validateTheaterName(name: string): void {
  if (typeof name !== 'string' || !name || name.length > THEATER_NAME_MAX_LENGTH) {
    throw new ValidationError('Name must be a string between 1 and 100 characters');
  }
}

function validateTheaterUrl(url: string): void {
  if (typeof url !== 'string' || url.length > THEATER_URL_MAX_LENGTH) {
    throw new ValidationError('URL is too long (max 2048 characters)');
  }
  if (!isValidAllocineUrl(url)) {
    throw new ValidationError('Invalid Allocine URL. Must be https://www.allocine.fr/...');
  }
}

function validateOptionalUrl(url: string | undefined): void {
  if (url !== undefined) {
    validateTheaterUrl(url);
  }
}

function validateAddress(address: string | undefined): void {
  if (address !== undefined && (typeof address !== 'string' || address.length > THEATER_ADDRESS_MAX_LENGTH)) {
    throw new ValidationError('Address must be at most 200 characters');
  }
}

function validatePostalCode(postalCode: string | undefined): void {
  if (postalCode !== undefined) {
    if (typeof postalCode !== 'string' || postalCode.length > THEATER_POSTAL_CODE_MAX_LENGTH) {
      throw new ValidationError('Postal code must be at most 10 characters');
    }
    if (postalCode && !/^[a-zA-Z0-9]+$/.test(postalCode)) {
      throw new ValidationError('Postal code must be alphanumeric');
    }
  }
}

function validateCity(city: string | undefined): void {
  if (city !== undefined && (typeof city !== 'string' || city.length > THEATER_CITY_MAX_LENGTH)) {
    throw new ValidationError('City must be at most 100 characters');
  }
}

function assertAtLeastOneUpdateField(data: TheaterUpdateInput): void {
  const hasField = UPDATE_FIELDS.some(
    (f) => data[f] !== undefined && data[f] !== null && data[f] !== '',
  );
  if (!hasField) {
    throw new ValidationError(`At least one field must be provided: ${UPDATE_FIELDS.join(', ')}`);
  }
}

// --- Theater service -------------------------------------------------------

/**
 * Insert a provisioning Theater, its manual scrape report, and the
 * `add_theater` queue job on one caller-owned transaction, so the catalog
 * write, report, and job enqueue can never be observed half-done. Shared by
 * the Staff paths and the Member submission path (issue #62).
 */
export async function addTheaterWithScrapeJob(
  db: DB,
  input: { id: string; name: string; url: string },
): Promise<{ theater: { id: string; name: string; url: string }; reportId: number }> {
  const theater = await addTheater(db, input);
  const reportId = await createScrapeReport(db, 'manual');
  // DB.query's constrained generic signature is narrower than BusTransaction's;
  // the transaction object satisfies both at runtime.
  await getBusProducer().enqueueAddTheaterJob(reportId, input.url, db as unknown as BusTransaction);
  return { theater, reportId };
}

export interface TheaterUpdateInput {
  name?: string;
  url?: string;
  address?: string;
  postal_code?: string;
  city?: string;
}

export class TheaterService {
  constructor(private db: DB) {}

  async getAllTheaters() {
    return getTheaters(this.db);
  }

  async getTheaterShowtimes(theaterId: string, weekStart: string) {
    return getShowtimesByTheaterAndWeek(this.db, theaterId, weekStart);
  }

  async addTheaterViaUrl(url: string) {
    validateTheaterUrl(url);

    const theaterId = extractTheaterIdFromUrl(url);
    if (!theaterId) {
      throw new ValidationError('Could not extract theater ID from URL. URL format should be like https://www.allocine.fr/seance/salle_gen_csalle=C0013.html');
    }

    const cleanedUrl = cleanTheaterUrl(url);

    const { theater, reportId } = await this.db.transaction(async (transaction) =>
      addTheaterWithScrapeJob(transaction as DB, {
        id: theaterId,
        name: theaterId,
        url: cleanedUrl,
      }),
    );
    logger.info(`🎬 add_theater job queued for ${cleanedUrl} (reportId=${reportId})`);

    return theater;
  }

  async addTheaterManual(id: string, name: string, url: string) {
    validateTheaterId(id);
    validateTheaterName(name);
    validateTheaterUrl(url);

    try {
      const { theater, reportId } = await this.db.transaction(async (transaction) =>
        addTheaterWithScrapeJob(transaction as DB, { id, name, url }),
      );
      logger.info(`🎬 add_theater job queued for ${url} (reportId=${reportId})`);
      return theater;
    } catch (error: any) {
      if (isUniqueViolation(error)) {
        throw new ValidationError('Theater with this ID already exists');
      }
      throw error;
    }
  }

  async updateTheater(theaterId: string, data: TheaterUpdateInput) {
    const { name, url, address, postal_code, city } = data;

    assertAtLeastOneUpdateField(data);

    if (name) validateTheaterName(name);
    validateOptionalUrl(url);
    validateAddress(address);
    validatePostalCode(postal_code);
    validateCity(city);

    const updates: Record<string, unknown> = {};
    if (name) updates.name = name;
    if (url) updates.url = url;
    if (address !== undefined) updates.address = address || undefined;
    if (postal_code !== undefined) updates.postal_code = postal_code || undefined;
    if (city !== undefined) updates.city = city || undefined;

    const theater = await updateTheaterConfig(this.db, theaterId, updates);
    if (!theater) {
      throw new NotFoundError(`Theater ${theaterId} not found`);
    }

    return theater;
  }

  async deleteTheater(theaterId: string) {
    const deleted = await deleteTheater(this.db, theaterId);
    if (!deleted) {
      throw new NotFoundError(`Theater ${theaterId} not found`);
    }
    return deleted;
  }
}
