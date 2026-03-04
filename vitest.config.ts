import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    // Force all imports of 'graphql' to resolve to the single ESM instance,
    // preventing cross-realm instanceof failures between ESM and CJS.
    dedupe: ['graphql'],
    alias: {
      graphql: path.resolve(__dirname, 'node_modules/graphql/index.mjs')
    }
  },
  test: {
    globals: true,
    testTimeout: 10000,
    server: {
      deps: {
        // Inline these deps so Vite processes their imports through its pipeline
        // (applying the graphql alias above). Without this, Node.js loads them
        // natively and resolves 'graphql' to the CJS entry point — a separate
        // module instance from the ESM one our code uses.
        inline: ['graphql', /@graphql-tools\//, /@apollo\/server/]
      }
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts'],
      thresholds: {
        lines: 90,
        branches: 90
      }
    }
  }
})
