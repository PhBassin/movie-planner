import { describe, it, expect, vi } from 'vitest';

// Sentinel: if the SSRF guard runs first we see the SSRF error;
// if not, we see this and the assertion fails. Proves the guard
// runs BEFORE puppeteer.launch.
vi.mock('puppeteer-core', () => ({
  default: {
    launch: vi.fn().mockRejectedValue(new Error('SENTINEL_PUPPETEER_LAUNCH')),
  },
}));

import { PuppeteerTransport } from '../../../../src/scraper/transports/puppeteer-transport.js';

describe('PuppeteerTransport - SSRF guard', () => {
  it('rejects a non-allocine host before launching a browser', async () => {
    const transport = new PuppeteerTransport();
    await expect(transport.fetchPage('https://evil.com/theater/foo')).rejects.toThrow(/SSRF/i);
  });

  it('rejects http:// on the allocine host (TLS downgrade)', async () => {
    const transport = new PuppeteerTransport();
    await expect(transport.fetchPage('http://www.allocine.fr/theater/foo')).rejects.toThrow(/SSRF/i);
  });

  it('rejects an internal/loopback address (SSRF to internal service)', async () => {
    const transport = new PuppeteerTransport();
    await expect(transport.fetchPage('http://localhost:8080/admin')).rejects.toThrow(/SSRF/i);
  });

  it('rejects a malformed URL', async () => {
    const transport = new PuppeteerTransport();
    await expect(transport.fetchPage('not-a-url')).rejects.toThrow(/SSRF/i);
  });
});
