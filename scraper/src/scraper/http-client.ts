// Public HTTP facade for the scraper.
//
// The actual fetches are owned by the two Transport adapters in
// ./transports/. This module is a thin facade: it validates the
// caller's input (theater id, date, movie id) and constructs the
// final URL, then delegates the I/O to the right transport. The
// transport owns the SSRF guard and the wire format.

import { ALLOCINE_BASE_URL } from './utils.js';
import { FetchTransport, PuppeteerTransport } from './transports/index.js';
import { closeBrowser } from './transports/puppeteer-transport.js';

// Process-wide transport instances. The Puppeteer one owns the
// shared browser lifecycle (see ./transports/puppeteer-transport.ts).
const _puppeteerTransport = new PuppeteerTransport();
const _fetchTransport = new FetchTransport();

/**
 * Validates theater ID format (e.g., "C0072", "W7517")
 * @throws {Error} if format is invalid
 */
function validateTheaterId(theaterId: string): void {
  if (!/^[A-Z]\d{4,5}$/.test(theaterId)) {
    throw new Error(`Invalid theater ID format: ${theaterId}`);
  }
}

/**
 * Validates date format (YYYY-MM-DD)
 * @throws {Error} if format is invalid or not a real date
 */
function validateDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid date format: ${date}`);
  }
  const parsed = new Date(date);
  if (isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: ${date}`);
  }
}

/**
 * Validates movie ID format (must be a positive integer)
 * @throws {Error} if format is invalid
 */
function validateMovieId(movieId: number): void {
  if (!Number.isInteger(movieId) || movieId <= 0) {
    throw new Error(`Invalid movie ID: ${movieId}`);
  }
}

export interface TheaterInitialData {
  html: string;           // Full initial HTML (for theater metadata parsing)
  availableDates: string[]; // Parsed data-showtimes-dates
}

/**
 * Load the theater page once using the Puppeteer transport to get:
 * - Theater metadata (data-theater attribute)
 * - Available showtime dates (data-showtimes-dates attribute)
 *
 * No date clicking is performed. Showtimes for each date are fetched
 * separately via the JSON API (fetchShowtimesJson).
 */
export async function fetchTheaterPage(theaterBaseUrl: string): Promise<TheaterInitialData> {
  const { html, availableDates } = await _puppeteerTransport.fetchPage(theaterBaseUrl);
  return { html, availableDates: availableDates ?? [] };
}

/**
 * Fetch the showtimes JSON for a specific date from the Allociné internal API.
 * This goes through the Fetch transport.
 *
 * @param theaterId - e.g. "C0072"
 * @param date     - e.g. "2026-02-22"
 */
export async function fetchShowtimesJson(theaterId: string, date: string): Promise<unknown> {
  validateTheaterId(theaterId);
  validateDate(date);

  const constructed = new URL(`/_/showtimes/theater-${theaterId}/d-${date}/`, ALLOCINE_BASE_URL);
  const { html } = await _fetchTransport.fetchPage(constructed.href);
  return JSON.parse(html) as unknown;
}

export async function fetchMoviePage(movieId: number): Promise<string> {
  validateMovieId(movieId);
  const constructed = new URL(`/film/fichefilm_gen_cfilm=${movieId}.html`, ALLOCINE_BASE_URL);
  const { html } = await _fetchTransport.fetchPage(constructed.href);
  return html;
}

// Ajouter un délai entre les requêtes pour éviter le rate limiting
export async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-export so existing callers (tests, server) keep working.
export { closeBrowser };
