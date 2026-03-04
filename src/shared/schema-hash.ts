import { createHash } from 'node:crypto'
import { type GraphQLSchema, lexicographicSortSchema, printSchema } from 'graphql'
import { HASH_LENGTH } from './constants.js'

export function computeSchemaHash(schema: GraphQLSchema): string {
  const sorted = lexicographicSortSchema(schema)
  const sdl = printSchema(sorted)
  return createHash('sha256').update(sdl).digest('hex').slice(0, HASH_LENGTH)
}
