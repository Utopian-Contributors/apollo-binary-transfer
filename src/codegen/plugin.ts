import type { PluginFunction, PluginValidateFn } from '@graphql-codegen/plugin-helpers'
import { generateManifest } from '../shared/manifest.js'

export const plugin: PluginFunction = (schema) => {
  const manifest = generateManifest(schema)
  return JSON.stringify(manifest, null, 2)
}

export const validate: PluginValidateFn = (_schema, _documents, _config, outputFile) => {
  if (!outputFile.endsWith('.json')) {
    throw new Error(
      `[apollo-binary-transfer/codegen] Output file must be .json, got: ${outputFile}`
    )
  }
}
