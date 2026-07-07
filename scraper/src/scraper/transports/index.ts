// Barrel for the Transport adapters. Importers should reach for
// `Transport` (the interface) or one of the concrete classes;
// the strategy depends on the interface and never on a class
// directly.
export { PuppeteerTransport, closeBrowser } from './puppeteer-transport.js';
export { FetchTransport } from './fetch-transport.js';
export type { Transport, TransportPage } from './transport.js';
