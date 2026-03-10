import { describe, it, expect } from 'vitest'
import { buildSchema } from 'graphql'
import { generateManifest } from '../../src/shared/manifest'
import { SCHEMA_SDL } from '../fixtures/schema'
import { TEST_MANIFEST } from '../fixtures/manifest'

describe('generateManifest — structure', () => {
  it('produces version 1', () => {
    expect(TEST_MANIFEST.version).toBe(1)
  })

  it('produces schemaHash', () => {
    expect(TEST_MANIFEST.schemaHash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('includes roots.query', () => {
    expect(TEST_MANIFEST.roots.query).toBe('Query')
  })

  it('includes roots.mutation', () => {
    expect(TEST_MANIFEST.roots.mutation).toBe('Mutation')
  })

  it('does not include roots.subscription', () => {
    expect((TEST_MANIFEST.roots as any).subscription).toBeUndefined()
  })
})

describe('generateManifest — type mapping', () => {
  it('includes all object types', () => {
    expect(Object.keys(TEST_MANIFEST.types)).toEqual(
      expect.arrayContaining(['Query', 'Mutation', 'User', 'Post', 'Comment'])
    )
  })

  it('does not include introspection types', () => {
    for (const key of Object.keys(TEST_MANIFEST.types)) {
      expect(key).not.toMatch(/^__/)
    }
  })

  it('does not include scalar types', () => {
    for (const key of Object.keys(TEST_MANIFEST.types)) {
      expect(['String', 'Int', 'Boolean', 'ID', 'Float']).not.toContain(key)
    }
  })

  it('does not include input types', () => {
    expect(TEST_MANIFEST.types).not.toHaveProperty('CreatePostInput')
    expect(TEST_MANIFEST.types).not.toHaveProperty('UpdateUserInput')
  })

  it('includes union types', () => {
    expect(TEST_MANIFEST.unions.SearchResult).toBeDefined()
  })
})

describe('generateManifest — alphabetical field ordering', () => {
  it('Query fields sorted alphabetically', () => {
    const names = TEST_MANIFEST.types.Query.fields.map(f => f.name)
    expect(names).toEqual(['feed', 'post', 'search', 'user', 'users', 'viewer'])
  })

  it('User fields sorted alphabetically', () => {
    const names = TEST_MANIFEST.types.User.fields.map(f => f.name)
    expect(names).toEqual(['age', 'avatar', 'bio', 'email', 'id', 'isAdmin', 'name', 'posts'])
  })

  it('Post fields sorted alphabetically', () => {
    const names = TEST_MANIFEST.types.Post.fields.map(f => f.name)
    expect(names).toEqual(['author', 'body', 'comments', 'id', 'likes', 'tags', 'title'])
  })

  it('Comment fields sorted alphabetically', () => {
    const names = TEST_MANIFEST.types.Comment.fields.map(f => f.name)
    expect(names).toEqual(['author', 'createdAt', 'id', 'text'])
  })
})

describe('generateManifest — field metadata', () => {
  it('scalar field has isComposite=false', () => {
    const nameField = TEST_MANIFEST.types.User.fields[6]
    expect(nameField.name).toBe('name')
    expect(nameField.isComposite).toBe(false)
  })

  it('object field has isComposite=true', () => {
    const authorField = TEST_MANIFEST.types.Post.fields[0]
    expect(authorField.name).toBe('author')
    expect(authorField.isComposite).toBe(true)
    expect(authorField.type).toBe('User')
  })

  it('list field has isList=true', () => {
    expect(TEST_MANIFEST.types.Query.fields[0].isList).toBe(true)  // feed
    expect(TEST_MANIFEST.types.User.fields[7].isList).toBe(true)   // posts
  })

  it('nullable field has isNullable=true', () => {
    expect(TEST_MANIFEST.types.User.fields[0].isNullable).toBe(true) // age
    expect(TEST_MANIFEST.types.User.fields[2].isNullable).toBe(true) // bio
  })

  it('non-null field has isNullable=false', () => {
    expect(TEST_MANIFEST.types.User.fields[3].isNullable).toBe(false) // email
    expect(TEST_MANIFEST.types.User.fields[4].isNullable).toBe(false) // id
  })

  it('union field has isUnion=true', () => {
    const searchField = TEST_MANIFEST.types.Query.fields[2]
    expect(searchField.name).toBe('search')
    expect(searchField.isUnion).toBe(true)
    expect(searchField.type).toBe('SearchResult')
  })

  it('non-union composite field has isUnion=false', () => {
    const authorField = TEST_MANIFEST.types.Post.fields[0]
    expect(authorField.isUnion).toBe(false)
  })
})

describe('generateManifest — union types', () => {
  it('union members sorted alphabetically', () => {
    expect(TEST_MANIFEST.unions.SearchResult).toEqual(['Post', 'User'])
  })
})

describe('generateManifest — arguments', () => {
  it('field with args includes args array', () => {
    const userField = TEST_MANIFEST.types.Query.fields[3]
    expect(userField.name).toBe('user')
    expect(userField.args).toEqual([{ name: 'id', type: 'ID!' }])
  })

  it('args sorted alphabetically', () => {
    const usersField = TEST_MANIFEST.types.Query.fields[4]
    expect(usersField.name).toBe('users')
    expect(usersField.args![0].name).toBe('limit')
    expect(usersField.args![1].name).toBe('offset')
  })

  it('field without args has no args property', () => {
    const nameField = TEST_MANIFEST.types.User.fields[6]
    expect(nameField.args).toBeUndefined()
  })
})

describe('generateManifest — determinism', () => {
  it('same schema produces same manifest', () => {
    const schema = buildSchema(SCHEMA_SDL)
    const m1 = generateManifest(schema)
    const m2 = generateManifest(schema)
    expect(m1.schemaHash).toBe(m2.schemaHash)
    expect(m1.types).toEqual(m2.types)
    expect(m1.unions).toEqual(m2.unions)
  })

  it('type definition order in SDL does not affect output', () => {
    const sdlA = `
      type Query { name: String }
      type User { id: ID }
    `
    const sdlB = `
      type User { id: ID }
      type Query { name: String }
    `
    const mA = generateManifest(buildSchema(sdlA))
    const mB = generateManifest(buildSchema(sdlB))
    expect(mA.schemaHash).toBe(mB.schemaHash)
    expect(mA.types).toEqual(mB.types)
  })

  it('manifest is JSON-serializable', () => {
    const roundtripped = JSON.parse(JSON.stringify(TEST_MANIFEST))
    expect(roundtripped.types).toEqual(TEST_MANIFEST.types)
    expect(roundtripped.unions).toEqual(TEST_MANIFEST.unions)
    expect(roundtripped.roots).toEqual(TEST_MANIFEST.roots)
  })
})

describe('generateManifest — schema changes', () => {
  it('adding a field changes schemaHash', () => {
    const base = buildSchema(`type Query { name: String }`)
    const extended = buildSchema(`type Query { name: String, age: Int }`)
    expect(generateManifest(base).schemaHash).not.toBe(generateManifest(extended).schemaHash)
  })

  it('removing a field changes schemaHash', () => {
    const full = buildSchema(`type Query { name: String, age: Int }`)
    const reduced = buildSchema(`type Query { name: String }`)
    expect(generateManifest(full).schemaHash).not.toBe(generateManifest(reduced).schemaHash)
  })

  it('adding a field shifts subsequent indices', () => {
    const sdl = `
      type Query { user: User }
      type User { age: Int, bio: String, email: String!, id: ID!, isAdmin: Boolean!, name: String! }
    `
    const sdlWithBadge = `
      type Query { user: User }
      type User { age: Int, badge: String, bio: String, email: String!, id: ID!, isAdmin: Boolean!, name: String! }
    `
    const m = generateManifest(buildSchema(sdlWithBadge))
    expect(m.types.User.fields[1].name).toBe('badge')
    expect(m.types.User.fields[2].name).toBe('bio')
    expect(m.types.User.fields[3].name).toBe('email')
  })

  it('adding a type adds entry to types map', () => {
    const base = buildSchema(`type Query { name: String }`)
    const extended = buildSchema(`type Query { name: String } type User { id: ID }`)
    expect(generateManifest(base).types.User).toBeUndefined()
    expect(generateManifest(extended).types.User).toBeDefined()
  })

  it('removing a type removes entry', () => {
    const full = buildSchema(`type Query { name: String } type User { id: ID }`)
    const reduced = buildSchema(`type Query { name: String }`)
    expect(generateManifest(full).types.User).toBeDefined()
    expect(generateManifest(reduced).types.User).toBeUndefined()
  })
})
