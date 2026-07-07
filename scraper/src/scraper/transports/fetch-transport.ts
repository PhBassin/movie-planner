import { logger } from '../../utils/logger.js';
import { validateExternalUrl } from '../utils.js';
import { HttpError, RateLimitError } from '../../utils/errors.js';
import type { Transport, TransportPage } from './transport.js';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export class FetchTransport implements Transport {
  async fetchPage(url: string): Promise<TransportPage> {
    validateExternalUrl(url);
    logger.info('Fetching page', { url });

    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
      },
    });

    if (!response.ok) {
      if (response.status === 429) {
        throw new RateLimitError(
          `Rate limit exceeded for ${url}`,
          response.status,
          url
        );
      }
      throw new HttpError(
        `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
        response.status,
        url
      );
    }

    return { html: await response.text() };
  }
}
