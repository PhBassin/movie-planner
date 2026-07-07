import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FetchTransport } from '../../../../src/scraper/transports/fetch-transport.js';
import { HttpError, RateLimitError } from '../../../../src/utils/errors.js';

const mockFetch = vi.fn();
global.fetch = mockFetch as any;

describe('FetchTransport - SSRF guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a non-allocine host before issuing a fetch', async () => {
    const transport = new FetchTransport();
    await expect(transport.fetchPage('https://evil.com/foo')).rejects.toThrow(/SSRF/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects http:// on the allocine host (TLS downgrade)', async () => {
    const transport = new FetchTransport();
    await expect(transport.fetchPage('http://www.allocine.fr/foo')).rejects.toThrow(/SSRF/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects an internal/loopback address (SSRF to internal service)', async () => {
    const transport = new FetchTransport();
    await expect(transport.fetchPage('http://localhost:8080/admin')).rejects.toThrow(/SSRF/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a malformed URL', async () => {
    const transport = new FetchTransport();
    await expect(transport.fetchPage('not-a-url')).rejects.toThrow(/SSRF/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('FetchTransport - happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the response body as html', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '<html>hi</html>',
    });
    const transport = new FetchTransport();
    const page = await transport.fetchPage('https://www.allocine.fr/x');
    expect(page.html).toBe('<html>hi</html>');
    expect(page.availableDates).toBeUndefined();
  });

  it('translates 429 to RateLimitError', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    });
    const transport = new FetchTransport();
    await expect(transport.fetchPage('https://www.allocine.fr/x')).rejects.toBeInstanceOf(RateLimitError);
  });

  it('translates 5xx to HttpError', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    });
    const transport = new FetchTransport();
    await expect(transport.fetchPage('https://www.allocine.fr/x')).rejects.toBeInstanceOf(HttpError);
  });
});
