import { buildSchema } from 'graphql'
import { generateManifest } from '../../src/shared/manifest'
import { SCHEMA_SDL } from './schema'

export function createTestManifest() {
  const schema = buildSchema(SCHEMA_SDL)
  return generateManifest(schema)
}

export const TEST_MANIFEST = createTestManifest()
