import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/server/index.ts',
    'src/client/index.ts',
    'src/codegen/index.ts',
    'src/shared/index.ts'
  ],
  format: ['esm', 'cjs'],
  dts: true,
  splitting: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  external: [
    '@apollo/server',
    '@apollo/client',
    '@graphql-codegen/plugin-helpers',
    'graphql'
  ]
})
