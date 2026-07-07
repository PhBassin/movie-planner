// Transport adapter interface for outbound HTTP fetches.
//
// The scraper uses two transports today: Puppeteer (full browser, for
// pages that need a JS-rendered DOM) and plain fetch (cheap, for
// JSON / static HTML). Both must validate the URL against the same
// SSRF rule before any I/O.
//
// Seams: tests for transports live at the public fetchPage() method.
// Strategy code depends on this interface, not on a concrete class —
// see AllocineScraperStrategy.

export interface TransportPage {
  html: string;
  availableDates?: string[];
}

export interface Transport {
  fetchPage(url: string): Promise<TransportPage>;
}
