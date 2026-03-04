import { describe, it, expect } from 'vitest'
import { print, parse, Kind, validate, buildSchema } from 'graphql'
import { encodeSelection } from '../../src/shared/selection-encoder'
import { decodeSelection } from '../../src/shared/selection-decoder'
import { TEST_MANIFEST } from '../fixtures/manifest'
import { SCHEMA_SDL } from '../fixtures/schema'
import {
  GET_USER_SIMPLE,
  GET_POST_WITH_AUTHOR,
  GET_FEED,
  GET_POST_WITH_COMMENTS,
  DASHBOARD,
  GET_USER_WITH_FRAGMENT,
  SEARCH_QUERY,
  CREATE_POST,
  GET_FEED_EMPTY
} from '../fixtures/queries'

function roundTrip(doc: any) {
  const { tree, operationType } = encodeSelection(doc, TEST_MANIFEST)
  const decoded = decodeSelection(tree, operationType, TEST_MANIFEST)
  const queryString = print(decoded)
  // parse to verify it's syntactically valid GraphQL
  const parsed = parse(queryString)
  return { decoded, queryString, parsed, tree, operationType }
}

function extractFieldNames(queryString: string): string[] {
  // Extract all word tokens that appear as field names (rough but effective)
  return [...queryString.matchAll(/\b(\w+)\b/g)].map(m => m[1])
}

describe('decodeSelection — round-trip', () => {
  it('simple flat query round-trip', () => {
    const { queryString } = roundTrip(GET_USER_SIMPLE)
    expect(queryString).toContain('user')
    expect(queryString).toContain('id')
    expect(queryString).toContain('name')
    expect(queryString).toContain('email')
  })

  it('nested object round-trip', () => {
    const { queryString } = roundTrip(GET_POST_WITH_AUTHOR)
    expect(queryString).toContain('post')
    expect(queryString).toContain('author')
    expect(queryString).toContain('id')
    expect(queryString).toContain('name')
    expect(queryString).toContain('body')
    expect(queryString).toContain('likes')
    expect(queryString).toContain('title')
  })

  it('deeply nested round-trip', () => {
    const { queryString } = roundTrip(GET_POST_WITH_COMMENTS)
    expect(queryString).toContain('post')
    expect(queryString).toContain('comments')
    expect(queryString).toContain('author')
    expect(queryString).toContain('createdAt')
    expect(queryString).toContain('text')
  })

  it('multiple root fields round-trip', () => {
    const { queryString } = roundTrip(DASHBOARD)
    expect(queryString).toContain('viewer')
    expect(queryString).toContain('feed')
    expect(queryString).toContain('isAdmin')
  })

  it('fragment (inlined) round-trip', () => {
    const { queryString } = roundTrip(GET_USER_WITH_FRAGMENT)
    expect(queryString).toContain('user')
    expect(queryString).toContain('bio')
    expect(queryString).toContain('email')
    expect(queryString).toContain('id')
    expect(queryString).toContain('name')
  })

  it('union round-trip', () => {
    const { queryString } = roundTrip(SEARCH_QUERY)
    expect(queryString).toContain('search')
    expect(queryString).toContain('Post')
    expect(queryString).toContain('User')
  })

  it('mutation round-trip', () => {
    const { queryString, operationType } = roundTrip(CREATE_POST)
    expect(operationType).toBe(1)
    expect(queryString).toContain('mutation')
    expect(queryString).toContain('createPost')
  })

  it('list field round-trip', () => {
    const { queryString } = roundTrip(GET_FEED)
    expect(queryString).toContain('feed')
    expect(queryString).toContain('author')
    expect(queryString).toContain('name')
  })
})

describe('decodeSelection — direct tests', () => {
  it('leaf field index → FieldNode with correct name', () => {
    const tree = [4] // id on User
    const doc = decodeSelection(tree, 0, {
      ...TEST_MANIFEST,
      roots: { query: 'User' }
    })
    const queryString = print(doc)
    expect(queryString).toContain('id')
  })

  it('composite field → FieldNode with selectionSet', () => {
    const tree = [[3, [4, 6]]] as any // user → id, name
    const doc = decodeSelection(tree, 0, TEST_MANIFEST)
    const queryString = print(doc)
    expect(queryString).toContain('user')
    expect(queryString).toContain('id')
    expect(queryString).toContain('name')
  })

  it('union field → FieldNode with InlineFragments', () => {
    const tree = [[2, { 0: [6], 1: [6] }]] as any // search → Post: title, User: name
    const doc = decodeSelection(tree, 0, TEST_MANIFEST)
    const queryString = print(doc)
    expect(queryString).toContain('search')
    expect(queryString).toContain('... on Post')
    expect(queryString).toContain('... on User')
  })
})

describe('decodeSelection — argument reconstruction', () => {
  const schema = buildSchema(SCHEMA_SDL)

  it('single required arg: user(id: ID!)', () => {
    const { tree, operationType } = encodeSelection(GET_USER_SIMPLE, TEST_MANIFEST)
    const doc = decodeSelection(tree, operationType, TEST_MANIFEST)
    const queryString = print(doc)
    expect(queryString).toContain('user(id: $v0)')
    expect(queryString).toContain('$v0: ID!')
  })

  it('single optional arg: feed(limit: Int)', () => {
    const { tree, operationType } = encodeSelection(GET_FEED, TEST_MANIFEST)
    const doc = decodeSelection(tree, operationType, TEST_MANIFEST)
    const queryString = print(doc)
    expect(queryString).toContain('feed(limit: $v0)')
    expect(queryString).toContain('$v0: Int')
  })

  it('mutation with input arg: createPost(input: CreatePostInput!)', () => {
    const { tree, operationType } = encodeSelection(CREATE_POST, TEST_MANIFEST)
    const doc = decodeSelection(tree, operationType, TEST_MANIFEST)
    const queryString = print(doc)
    expect(queryString).toContain('createPost(input: $v0)')
    expect(queryString).toContain('$v0: CreatePostInput!')
  })

  it('field with no args: viewer', () => {
    const tree = [[5, [4, 6]]] as any // viewer → id, name
    const doc = decodeSelection(tree, 0, TEST_MANIFEST)
    const queryString = print(doc)
    // viewer has no args, should appear without parens
    expect(queryString).toMatch(/viewer\s*\{/)
    expect(queryString).not.toContain('viewer(')
  })

  it('multiple root fields with different args', () => {
    const { tree, operationType } = encodeSelection(DASHBOARD, TEST_MANIFEST)
    const doc = decodeSelection(tree, operationType, TEST_MANIFEST)
    const queryString = print(doc)
    // feed has limit arg, viewer has no args
    expect(queryString).toContain('feed(limit: $v')
    expect(queryString).not.toContain('viewer(')
  })

  it('decoded query with args validates against schema', () => {
    const { tree, operationType } = encodeSelection(GET_USER_SIMPLE, TEST_MANIFEST)
    const doc = decodeSelection(tree, operationType, TEST_MANIFEST)
    const errors = validate(schema, doc)
    expect(errors).toHaveLength(0)
  })

  it('decoded query with optional arg validates against schema', () => {
    const { tree, operationType } = encodeSelection(GET_FEED, TEST_MANIFEST)
    const doc = decodeSelection(tree, operationType, TEST_MANIFEST)
    const errors = validate(schema, doc)
    expect(errors).toHaveLength(0)
  })

  it('decoded mutation validates against schema', () => {
    const { tree, operationType } = encodeSelection(CREATE_POST, TEST_MANIFEST)
    const doc = decodeSelection(tree, operationType, TEST_MANIFEST)
    const errors = validate(schema, doc)
    expect(errors).toHaveLength(0)
  })

  it('decoded nested query validates against schema', () => {
    const { tree, operationType } = encodeSelection(GET_POST_WITH_AUTHOR, TEST_MANIFEST)
    const doc = decodeSelection(tree, operationType, TEST_MANIFEST)
    const errors = validate(schema, doc)
    expect(errors).toHaveLength(0)
  })

  it('decoded search (union + args) validates against schema', () => {
    const { tree, operationType } = encodeSelection(SEARCH_QUERY, TEST_MANIFEST)
    const doc = decodeSelection(tree, operationType, TEST_MANIFEST)
    const errors = validate(schema, doc)
    expect(errors).toHaveLength(0)
  })

  it('each arg gets a unique counter-based variable name', () => {
    // With counter-based naming, each arg occurrence gets its own variable
    const tree = [[3, [3, 4, 6]]] as any // user(id) → email, id, name
    const doc = decodeSelection(tree, 0, TEST_MANIFEST)
    const queryString = print(doc)
    expect(queryString).toContain('$v0: ID!')
    expect(queryString).toContain('user(id: $v0)')
  })

  it('type string parsing: list types', () => {
    // search(query: String!) — simple non-null
    const { tree, operationType } = encodeSelection(SEARCH_QUERY, TEST_MANIFEST)
    const doc = decodeSelection(tree, operationType, TEST_MANIFEST)
    const queryString = print(doc)
    expect(queryString).toContain('$v0: String!')
  })
})

describe('decodeSelection — parseTypeNode edge cases', () => {
  it('parses simple named type', () => {
    // Create a manifest with a field that has arg type "String"
    const manifest = {
      ...TEST_MANIFEST,
      types: {
        ...TEST_MANIFEST.types,
        TestQuery: {
          fields: [
            { name: 'test', type: 'String', isComposite: false, args: [{ name: 'x', type: 'String' }] }
          ]
        }
      },
      roots: { query: 'TestQuery' }
    } as any
    const tree = [0] as any
    const doc = decodeSelection(tree, 0, manifest)
    const qs = print(doc)
    expect(qs).toContain('$v0: String')
    expect(qs).not.toContain('$v0: String!')
  })

  it('parses non-null type', () => {
    const manifest = {
      ...TEST_MANIFEST,
      types: {
        ...TEST_MANIFEST.types,
        TestQuery: {
          fields: [
            { name: 'test', type: 'String', isComposite: false, args: [{ name: 'x', type: 'ID!' }] }
          ]
        }
      },
      roots: { query: 'TestQuery' }
    } as any
    const tree = [0] as any
    const doc = decodeSelection(tree, 0, manifest)
    const qs = print(doc)
    expect(qs).toContain('$v0: ID!')
  })

  it('parses list type [String]', () => {
    const manifest = {
      ...TEST_MANIFEST,
      types: {
        ...TEST_MANIFEST.types,
        TestQuery: {
          fields: [
            { name: 'test', type: 'String', isComposite: false, args: [{ name: 'x', type: '[String]' }] }
          ]
        }
      },
      roots: { query: 'TestQuery' }
    } as any
    const tree = [0] as any
    const doc = decodeSelection(tree, 0, manifest)
    const qs = print(doc)
    expect(qs).toContain('$v0: [String]')
  })

  it('parses non-null list of non-nulls [String!]!', () => {
    const manifest = {
      ...TEST_MANIFEST,
      types: {
        ...TEST_MANIFEST.types,
        TestQuery: {
          fields: [
            { name: 'test', type: 'String', isComposite: false, args: [{ name: 'tags', type: '[String!]!' }] }
          ]
        }
      },
      roots: { query: 'TestQuery' }
    } as any
    const tree = [0] as any
    const doc = decodeSelection(tree, 0, manifest)
    const qs = print(doc)
    expect(qs).toContain('$v0: [String!]!')
  })

  it('parses nested list [[Int]]', () => {
    const manifest = {
      ...TEST_MANIFEST,
      types: {
        ...TEST_MANIFEST.types,
        TestQuery: {
          fields: [
            { name: 'test', type: 'String', isComposite: false, args: [{ name: 'matrix', type: '[[Int]]' }] }
          ]
        }
      },
      roots: { query: 'TestQuery' }
    } as any
    const tree = [0] as any
    const doc = decodeSelection(tree, 0, manifest)
    const qs = print(doc)
    expect(qs).toContain('$v0: [[Int]]')
  })

  it('parses complex nested [[String!]!]!', () => {
    const manifest = {
      ...TEST_MANIFEST,
      types: {
        ...TEST_MANIFEST.types,
        TestQuery: {
          fields: [
            { name: 'test', type: 'String', isComposite: false, args: [{ name: 'data', type: '[[String!]!]!' }] }
          ]
        }
      },
      roots: { query: 'TestQuery' }
    } as any
    const tree = [0] as any
    const doc = decodeSelection(tree, 0, manifest)
    const qs = print(doc)
    expect(qs).toContain('$v0: [[String!]!]!')
  })
})

describe('decodeSelection — counter-based variable collision resolution', () => {
  it('two fields with same arg name get different variable names', () => {
    // user(id:) and post(id:) in the same query — both have "id" arg
    const doc = parse(`
      query($userId: ID!, $postId: ID!) {
        user(id: $userId) { id name }
        post(id: $postId) { id title }
      }
    `)
    const { tree, operationType } = encodeSelection(doc, TEST_MANIFEST)
    const decoded = decodeSelection(tree, operationType, TEST_MANIFEST)
    const qs = print(decoded)
    // user gets v0, post gets v1
    expect(qs).toContain('user(id: $v0)')
    expect(qs).toContain('post(id: $v1)')
    expect(qs).toContain('$v0: ID!')
    expect(qs).toContain('$v1: ID!')
  })

  it('field with multiple args gets sequential counters', () => {
    // users(limit, offset) → alphabetical: limit(v0), offset(v1)
    const doc = parse(`
      query($n: Int, $skip: Int) {
        users(limit: $n, offset: $skip) { id name }
      }
    `)
    const { tree, operationType } = encodeSelection(doc, TEST_MANIFEST)
    const decoded = decodeSelection(tree, operationType, TEST_MANIFEST)
    const qs = print(decoded)
    expect(qs).toContain('users(limit: $v0, offset: $v1)')
    expect(qs).toContain('$v0: Int')
    expect(qs).toContain('$v1: Int')
  })

  it('nested args get counters that continue from parent', () => {
    // user(id:) → v0, user.posts(limit:) → v1
    const doc = parse(`
      query($userId: ID!, $postCount: Int) {
        user(id: $userId) { id posts(limit: $postCount) { id title } }
      }
    `)
    const { tree, operationType } = encodeSelection(doc, TEST_MANIFEST)
    const decoded = decodeSelection(tree, operationType, TEST_MANIFEST)
    const qs = print(decoded)
    expect(qs).toContain('user(id: $v0)')
    expect(qs).toContain('posts(limit: $v1)')
  })

  it('decoded collision query validates against schema', () => {
    const s = buildSchema(SCHEMA_SDL)
    const doc = parse(`
      query($userId: ID!, $postId: ID!) {
        user(id: $userId) { id name }
        post(id: $postId) { id title }
      }
    `)
    const { tree, operationType } = encodeSelection(doc, TEST_MANIFEST)
    const decoded = decodeSelection(tree, operationType, TEST_MANIFEST)
    const errors = validate(s, decoded)
    expect(errors).toHaveLength(0)
  })
})

describe('decodeSelection — union __typename injection', () => {
  it('decoded union includes __typename in inline fragments', () => {
    const { tree, operationType } = encodeSelection(SEARCH_QUERY, TEST_MANIFEST)
    const doc = decodeSelection(tree, operationType, TEST_MANIFEST)
    const qs = print(doc)
    // Each inline fragment should have __typename field
    expect(qs).toContain('__typename')
    // Count: should appear in both Post and User fragments
    const matches = qs.match(/__typename/g)
    expect(matches!.length).toBeGreaterThanOrEqual(2)
  })
})
