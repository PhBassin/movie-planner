import { type IScraperStrategy } from './strategies/IScraperStrategy.js';
import { AllocineScraperStrategy } from './strategies/AllocineScraperStrategy.js';
import { FetchTransport, PuppeteerTransport } from './transports/index.js';
import { delay } from './http-client.js';

const strategies: IScraperStrategy[] = [
  new AllocineScraperStrategy(
    new PuppeteerTransport(),
    new FetchTransport(),
    delay,
  ),
];

export function getStrategyByUrl(url: string): IScraperStrategy {
  const strategy = strategies.find(s => s.canHandleUrl(url));
  if (!strategy) {
    throw new Error(`No scraper strategy found for URL: ${url}`);
  }
  return strategy;
}

export function getStrategyBySource(source: string): IScraperStrategy {
  const strategy = strategies.find(s => s.sourceName === source);
  if (!strategy) {
    throw new Error(`No scraper strategy found for source: ${source}`);
  }
  return strategy;
}
