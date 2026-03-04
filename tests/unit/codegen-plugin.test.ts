import { describe, it, expect } from 'vitest'
import { buildSchema } from 'graphql'
import { plugin, validate } from '../../src/codegen/plugin'
import { SCHEMA_SDL } from '../fixtures/schema'

describe('codegen plugin', () => {
  const schema = buildSchema(SCHEMA_SDL)

  it('plugin() returns valid JSON string', () => {
    const result = plugin(schema, [], {})
    const parsed = JSON.parse(result as string)
    expect(parsed.version).toBe(1)
    expect(parsed.schemaHash).toBeDefined()
    expect(parsed.types).toBeDefined()
    expect(parsed.unions).toBeDefined()
    expect(parsed.roots).toBeDefined()
  })

  it('plugin() ignores documents parameter', () => {
    const result = plugin(schema, [], {})
    const parsed = JSON.parse(result as string)
    expect(parsed.types.Query).toBeDefined()
  })

  it('validate() rejects non-.json output', () => {
    expect(() => validate(schema, [], {}, 'output.ts', '')).toThrow('.json')
  })

  it('validate() accepts .json output', () => {
    expect(() => validate(schema, [], {}, 'output.json', '')).not.toThrow()
  })
})
