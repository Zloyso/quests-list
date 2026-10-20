import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: { obsidian: fileURLToPath(new URL('./tests/obsidian-stub.ts', import.meta.url)) },
	},
	test: {
		environment: 'jsdom',
		// A zone with daylight saving time catches date bugs that UTC hides.
		env: { TZ: 'Europe/Berlin' },
		testTimeout: 60_000,
	},
});
