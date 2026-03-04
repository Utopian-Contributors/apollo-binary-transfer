import { describe, it, expect } from 'vitest'
import { flattenResponse, encodeResponse, NULL_OBJECT } from '../../src/shared/response-encoder'
import { rebuildResponse, decodeResponse, type AliasMap } from '../../src/shared/response-decoder'
import { TEST_MANIFEST } from '../fixtures/manifest'

function roundTrip(data: any, tree: any, rootType = 'Query') {
  const flat = flattenResponse(data, tree, rootType, TEST_MANIFEST)
  const rebuilt = rebuildResponse(flat, tree, rootType, TEST_MANIFEST)
  return rebuilt
}

describe('rebuildResponse — round-trip', () => {
  it('flat object round-trip', () => {
    const data = { user: { id: '1', name: 'Alice', email: 'alice@example.com' } }
    const tree = [[3, [3, 4, 6]]] as any
    const rebuilt = roundTrip(data, tree)
    expect(rebuilt.user.email).toBe('alice@example.com')
    expect(rebuilt.user.id).toBe('1')
    expect(rebuilt.user.name).toBe('Alice')
  })

  it('nested object round-trip', () => {
    const data = {
      post: {
        id: '100', title: 'Hello', body: '...', likes: 42,
        author: { id: '1', name: 'Alice' }
      }
    }
    const tree = [[1, [[0, [4, 6]], 1, 3, 4, 6]]] as any
    const rebuilt = roundTrip(data, tree)
    expect(rebuilt.post.author.id).toBe('1')
    expect(rebuilt.post.author.name).toBe('Alice')
    expect(rebuilt.post.body).toBe('...')
    expect(rebuilt.post.id).toBe('100')
    expect(rebuilt.post.likes).toBe(42)
    expect(rebuilt.post.title).toBe('Hello')
  })

  it('list round-trip', () => {
    const data = {
      feed: [
        { id: '100', title: 'Hello', likes: 42, author: { name: 'Alice' } },
        { id: '101', title: 'Bye', likes: 17, author: { name: 'Bob' } }
      ]
    }
    const tree = [[0, [[0, [6]], 3, 4, 6]]] as any
    const rebuilt = roundTrip(data, tree)
    expect(rebuilt.feed).toHaveLength(2)
    expect(rebuilt.feed[0].author.name).toBe('Alice')
    expect(rebuilt.feed[0].id).toBe('100')
    expect(rebuilt.feed[1].author.name).toBe('Bob')
  })

  it('empty list round-trip', () => {
    const data = { feed: [] }
    const tree = [[0, [3, 6]]] as any
    const rebuilt = roundTrip(data, tree)
    expect(rebuilt.feed).toEqual([])
  })

  it('null leaf round-trip', () => {
    const data = { user: { id: '2', name: 'Bob', bio: null, avatar: null } }
    const tree = [[3, [1, 2, 4, 6]]] as any
    const rebuilt = roundTrip(data, tree)
    expect(rebuilt.user.avatar).toBeNull()
    expect(rebuilt.user.bio).toBeNull()
    expect(rebuilt.user.id).toBe('2')
    expect(rebuilt.user.name).toBe('Bob')
  })

  it('null object (sentinel) round-trip', () => {
    const data = { post: null }
    const tree = [[1, [3, 6]]] as any
    const rebuilt = roundTrip(data, tree)
    expect(rebuilt.post).toBeNull()
  })

  it('multiple root fields round-trip', () => {
    const data = {
      viewer: { id: '1', name: 'Alice', isAdmin: true },
      feed: [{ id: '100', title: 'Hello', likes: 42 }]
    }
    const tree = [[0, [3, 4, 6]], [5, [4, 5, 6]]] as any
    const rebuilt = roundTrip(data, tree)
    expect(rebuilt.feed[0].id).toBe('100')
    expect(rebuilt.viewer.id).toBe('1')
    expect(rebuilt.viewer.isAdmin).toBe(true)
  })

  it('scalar list field round-trip', () => {
    const data = { post: { id: '100', title: 'Hello', tags: ['intro', 'hello'] } }
    const tree = [[1, [3, 5, 6]]] as any
    const rebuilt = roundTrip(data, tree)
    expect(rebuilt.post.tags).toEqual(['intro', 'hello'])
  })

  it('union round-trip', () => {
    const data = {
      search: [
        { __typename: 'Post', id: '100', title: 'Hello' },
        { __typename: 'User', id: '1', name: 'Alice' }
      ]
    }
    const tree = [[2, { 0: [3, 6], 1: [4, 6] }]] as any
    const rebuilt = roundTrip(data, tree)
    expect(rebuilt.search).toHaveLength(2)
    expect(rebuilt.search[0].__typename).toBe('Post')
    expect(rebuilt.search[0].id).toBe('100')
    expect(rebuilt.search[0].title).toBe('Hello')
    expect(rebuilt.search[1].__typename).toBe('User')
    expect(rebuilt.search[1].id).toBe('1')
    expect(rebuilt.search[1].name).toBe('Alice')
  })
})

describe('rebuildResponse — aliases', () => {
  it('aliases applied when AliasMap provided', () => {
    const values = ['alice@example.com', '1', 'Alice']
    const tree = [[3, [3, 4, 6]]] as any
    const aliases: AliasMap = new Map([
      ['User', new Map([[3, 'contactEmail'], [4, 'userId'], [6, 'displayName']])]
    ])
    const rebuilt = rebuildResponse(values, tree, 'Query', TEST_MANIFEST, aliases)
    expect(rebuilt.user.contactEmail).toBe('alice@example.com')
    expect(rebuilt.user.userId).toBe('1')
    expect(rebuilt.user.displayName).toBe('Alice')
  })

  it('no AliasMap → field names from manifest', () => {
    const values = ['alice@example.com', '1', 'Alice']
    const tree = [[3, [3, 4, 6]]] as any
    const rebuilt = rebuildResponse(values, tree, 'Query', TEST_MANIFEST)
    expect(rebuilt.user.email).toBe('alice@example.com')
    expect(rebuilt.user.id).toBe('1')
    expect(rebuilt.user.name).toBe('Alice')
  })
})

describe('rebuildResponse — __typename injection', () => {
  it('__typename injected for composite objects', () => {
    const data = { user: { id: '1', name: 'Alice', email: 'alice@example.com' } }
    const tree = [[3, [3, 4, 6]]] as any
    const rebuilt = roundTrip(data, tree)
    expect(rebuilt.__typename).toBe('Query')
    expect(rebuilt.user.__typename).toBe('User')
  })

  it('__typename for union members derived from type index', () => {
    const data = {
      search: [
        { __typename: 'Post', id: '100', title: 'Hello' },
        { __typename: 'User', id: '1', name: 'Alice' }
      ]
    }
    const tree = [[2, { 0: [3, 6], 1: [4, 6] }]] as any
    const rebuilt = roundTrip(data, tree)
    expect(rebuilt.search[0].__typename).toBe('Post')
    expect(rebuilt.search[1].__typename).toBe('User')
  })
})

describe('rebuildResponse — single union (non-list)', () => {
  const singleUnionManifest = {
    ...TEST_MANIFEST,
    types: {
      ...TEST_MANIFEST.types,
      QuerySU: {
        fields: [
          { name: 'result', type: 'SearchResult', isComposite: true, isUnion: true, isList: false }
        ]
      }
    }
  } as any

  it('single union decodes Post type', () => {
    const values = [0, '100', 'Hello']
    const tree = [[0, { 0: [3, 6], 1: [4, 6] }]] as any
    const rebuilt = rebuildResponse(values, tree, 'QuerySU', singleUnionManifest)
    expect(rebuilt.result.__typename).toBe('Post')
    expect(rebuilt.result.id).toBe('100')
    expect(rebuilt.result.title).toBe('Hello')
  })

  it('single union decodes User type', () => {
    const values = [1, '1', 'Alice']
    const tree = [[0, { 0: [3, 6], 1: [4, 6] }]] as any
    const rebuilt = rebuildResponse(values, tree, 'QuerySU', singleUnionManifest)
    expect(rebuilt.result.__typename).toBe('User')
    expect(rebuilt.result.id).toBe('1')
    expect(rebuilt.result.name).toBe('Alice')
  })

  it('single union round-trips', () => {
    const data = { result: { __typename: 'Post', id: '100', title: 'Hello' } }
    const tree = [[0, { 0: [3, 6], 1: [4, 6] }]] as any
    const flat = flattenResponse(data, tree, 'QuerySU', singleUnionManifest)
    const rebuilt = rebuildResponse(flat, tree, 'QuerySU', singleUnionManifest)
    expect(rebuilt.result.__typename).toBe('Post')
    expect(rebuilt.result.id).toBe('100')
    expect(rebuilt.result.title).toBe('Hello')
  })
})

describe('rebuildResponse — NULL_OBJECT in nested contexts', () => {
  it('null nested object inside list item', () => {
    // Columnar: author column (per-item), then id column
    const values = [
      2,              // list length
      'Alice',        // author col, item 0: author.name
      NULL_OBJECT,    // author col, item 1: author is null
      '100', '101'    // id col: item 0, item 1
    ]
    const tree = [[0, [[0, [6]], 3]]] as any
    const rebuilt = rebuildResponse(values, tree, 'Query', TEST_MANIFEST)
    expect(rebuilt.feed[0].author.name).toBe('Alice')
    expect(rebuilt.feed[0].id).toBe('100')
    expect(rebuilt.feed[1].author).toBeNull()
    expect(rebuilt.feed[1].id).toBe('101')
  })
})

describe('rebuildResponse — union with missing sub-selection', () => {
  it('union member with no sub-selection returns empty object with __typename', () => {
    // Simulate: union type where one member has no fields selected
    // tree has type 0 with sub-selection but type 1 with no sub-selection
    const values = [
      2,           // list length
      0, '100', 'Hello',  // item 1: type index 0 (Post), id, title
      1            // item 2: type index 1 (User) — no fields selected
    ]
    // search(2) → Post(0): {id(3), title(6)}, User(1): {} (no selection)
    const tree = [[2, { 0: [3, 6] }]] as any
    const rebuilt = rebuildResponse(values, tree, 'Query', TEST_MANIFEST)
    expect(rebuilt.search[0].__typename).toBe('Post')
    expect(rebuilt.search[0].id).toBe('100')
    expect(rebuilt.search[1].__typename).toBe('User')
    expect(Object.keys(rebuilt.search[1])).toEqual(['__typename'])
  })
})

describe('decodeResponse', () => {
  it('accepts output of encodeResponse and produces correct structure', () => {
    const data = { user: { id: '1', name: 'Alice', email: 'alice@example.com' } }
    const tree = [[3, [3, 4, 6]]] as any
    const encoded = encodeResponse(data, tree, 'Query', TEST_MANIFEST)
    const decoded = decodeResponse(encoded, tree, 'Query', TEST_MANIFEST)
    expect(decoded.user.email).toBe('alice@example.com')
    expect(decoded.user.id).toBe('1')
    expect(decoded.user.name).toBe('Alice')
  })
})
