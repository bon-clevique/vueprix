import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Exclude the Cloudflare Worker subpackage from the root vitest run.
    // worker/ is an independent npm package with its own node_modules,
    // tsconfig, and vitest invocation; running its tests requires
    // @cloudflare/workers-types which root does not install.
    exclude: ['**/node_modules/**', 'dist/**', 'worker/**'],
  },
});
