import puppeteer, { type Browser } from 'puppeteer-core';
import { logger } from '../../utils/logger.js';
import { validateExternalUrl } from '../utils.js';
import type { Transport, TransportPage } from './transport.js';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Shared browser instance — launching Puppeteer is expensive; one
// browser per scraper process. The lifecycle is owned by this module.
let _browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!_browser || !_browser.connected) {
    _browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.CHROME_PATH ?? '/usr/bin/chromium-headless-shell',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return _browser;
}

export async function closeBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}

export class PuppeteerTransport implements Transport {
  async fetchPage(url: string): Promise<TransportPage> {
    validateExternalUrl(url);

    const browser = await getBrowser();
    const context = await browser.createBrowserContext();
    const page = await context.newPage();

    try {
      await page.setUserAgent(USER_AGENT);
      logger.info('Loading theater page', { url });
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });

      const html = await page.content();

      // Extract available dates from the data-showtimes-dates attribute.
      // This is Puppeteer-specific — only a browser can evaluate the
      // rendered DOM, so the availableDates field belongs here, not on
      // the Transport interface.
      const availableDates = await page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const el = (globalThis as any).document?.querySelector('#theaterpage-showtimes-index-ui');
        const raw = el?.getAttribute('data-showtimes-dates');
        if (!raw) return [] as string[];
        try {
          return JSON.parse(raw) as string[];
        } catch {
          return [] as string[];
        }
      });

      logger.info('Available dates on page', { dates: availableDates });
      return { html, availableDates };
    } finally {
      await context.close();
    }
  }
}
