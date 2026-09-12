import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/dist/**'],
    /**
     * Several suites poll asynchronous deliberation to a terminal state. Under
     * full-suite parallelism the 5s default is tight enough to fail
     * intermittently, which is worse than a slower honest bound.
     */
    testTimeout: 20_000
  }
});
