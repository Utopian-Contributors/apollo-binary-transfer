import { describe, it, expect } from 'vitest'
import { buildSchema } from 'graphql'
import { computeSchemaHash } from '../../src/shared/schema-hash'
import { SCHEMA_SDL } from '../fixtures/schema'

describe('computeSchemaHash', () => {
  const schema = buildSchema(SCHEMA_SDL)

  it('produces 16-char hex string', () => {
    const hash = computeSchemaHash(schema)
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('deterministic — same schema always same hash', () => {
    const hash1 = computeSchemaHash(schema)
    const hash2 = computeSchemaHash(schema)
    expect(hash1).toBe(hash2)
  })

  it('type definition order in SDL does not affect hash', () => {
    const sdlA = `
      type Query { name: String }
      type User { id: ID }
    `
    const sdlB = `
      type User { id: ID }
      type Query { name: String }
    `
    const hashA = computeSchemaHash(buildSchema(sdlA))
    const hashB = computeSchemaHash(buildSchema(sdlB))
    expect(hashA).toBe(hashB)
  })

  it('adding a field changes hash', () => {
    const base = buildSchema(`type Query { name: String }`)
    const extended = buildSchema(`type Query { name: String, age: Int }`)
    expect(computeSchemaHash(base)).not.toBe(computeSchemaHash(extended))
  })

  it('removing a field changes hash', () => {
    const full = buildSchema(`type Query { name: String, age: Int }`)
    const reduced = buildSchema(`type Query { name: String }`)
    expect(computeSchemaHash(full)).not.toBe(computeSchemaHash(reduced))
  })

  it('adding a type changes hash', () => {
    const base = buildSchema(`type Query { name: String }`)
    const extended = buildSchema(`type Query { name: String } type User { id: ID }`)
    expect(computeSchemaHash(base)).not.toBe(computeSchemaHash(extended))
  })
})
