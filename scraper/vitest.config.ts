import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // Exclude integration-heavy files that require a live DB connection.
      // scraper/index.ts is a thin orchestrator entry that needs live
      // infrastructure; core run logic is tested via the ScrapeRun class in
      // scrape-run.ts and the helpers test file.
      exclude: [
        'src/scraper/index.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 65,
      },
    },
  },
});
