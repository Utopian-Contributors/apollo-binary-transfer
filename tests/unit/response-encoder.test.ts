import { describe, it, expect } from 'vitest'
import { decode as msgpackDecode } from '@msgpack/msgpack'
import { flattenResponse, encodeResponse, NULL_OBJECT } from '../../src/shared/response-encoder'
import { TEST_MANIFEST } from '../fixtures/manifest'
import { USER_ALICE, USER_BOB, POST_HELLO, POST_GOODBYE } from '../fixtures/responses'

describe('flattenResponse — basics', () => {
  it('flat object', () => {
    const data = { user: { id: '1', name: 'Alice', email: 'alice@example.com' } }
    // user(3) → id(4), name(6), email(3) — but tree uses AST order from test spec
    // tree: [[3, [3, 4, 6]]] — email(3), id(4), name(6) in selection order
    const tree = [[3, [3, 4, 6]]] as any
    const result = flattenResponse(data, tree, 'Query', TEST_MANIFEST)
    expect(result).toEqual(['alice@example.com', '1', 'Alice'])
  })

  it('nested object', () => {
    const data = {
      post: {
        id: '100', title: 'Hello', body: '...', likes: 42,
        author: { id: '1', name: 'Alice' }
      }
    }
    // post(1) → author(0)→{id(4), name(6)}, body(1), id(3), likes(4), title(6)
    const tree = [[1, [[0, [4, 6]], 1, 3, 4, 6]]] as any
    const result = flattenResponse(data, tree, 'Query', TEST_MANIFEST)
    expect(result).toEqual(['1', 'Alice', '...', '100', 42, 'Hello'])
  })

  it('list of objects', () => {
    const data = {
      feed: [
        { id: '100', title: 'Hello', likes: 42, author: { name: 'Alice' } },
        { id: '101', title: 'Bye', likes: 17, author: { name: 'Bob' } }
      ]
    }
    // feed(0) → author(0)→{name(6)}, id(3), likes(4), title(6)
    // Columnar: author col (per-item), id col, likes col, title col
    const tree = [[0, [[0, [6]], 3, 4, 6]]] as any
    const result = flattenResponse(data, tree, 'Query', TEST_MANIFEST)
    expect(result).toEqual([2, 'Alice', 'Bob', '100', '101', 42, 17, 'Hello', 'Bye'])
  })

  it('empty list', () => {
    const data = { feed: [] }
    const tree = [[0, [3, 6]]] as any
    const result = flattenResponse(data, tree, 'Query', TEST_MANIFEST)
    expect(result).toEqual([0])
  })

  it('null leaf values preserved', () => {
    const data = { user: { id: '2', name: 'Bob', bio: null, avatar: null } }
    // user(3) → avatar(1), bio(2), id(4), name(6)
    const tree = [[3, [1, 2, 4, 6]]] as any
    const result = flattenResponse(data, tree, 'Query', TEST_MANIFEST)
    expect(result).toEqual([null, null, '2', 'Bob'])
  })

  it('null nested object → NULL_OBJECT sentinel (0xC1)', () => {
    const data = { post: null }
    const tree = [[1, [3, 6]]] as any
    const result = flattenResponse(data, tree, 'Query', TEST_MANIFEST)
    expect(result).toEqual([NULL_OBJECT])
  })

  it('multiple root fields', () => {
    const data = {
      viewer: { id: '1', name: 'Alice', isAdmin: true },
      feed: [{ id: '100', title: 'Hello', likes: 42 }]
    }
    // feed(0) → {id(3), likes(4), title(6)}; viewer(5) → {id(4), isAdmin(5), name(6)}
    // Columnar: single-item list so same values, just columnar order
    const tree = [[0, [3, 4, 6]], [5, [4, 5, 6]]] as any
    const result = flattenResponse(data, tree, 'Query', TEST_MANIFEST)
    expect(result).toEqual([1, '100', 42, 'Hello', '1', true, 'Alice'])
  })

  it('scalar list field (tags) pushed as-is', () => {
    const data = { post: { id: '100', title: 'Hello', tags: ['intro', 'hello'] } }
    // post(1) → id(3), tags(5), title(6)
    const tree = [[1, [3, 5, 6]]] as any
    const result = flattenResponse(data, tree, 'Query', TEST_MANIFEST)
    expect(result).toEqual(['100', ['intro', 'hello'], 'Hello'])
  })

  it('boolean false preserved', () => {
    const data = { user: { isAdmin: false } }
    const tree = [[3, [5]]] as any
    const result = flattenResponse(data, tree, 'Query', TEST_MANIFEST)
    expect(result).toEqual([false])
  })

  it('integer zero preserved', () => {
    const data = { post: { likes: 0 } }
    const tree = [[1, [4]]] as any
    const result = flattenResponse(data, tree, 'Query', TEST_MANIFEST)
    expect(result).toEqual([0])
  })

  it('union field', () => {
    const data = {
      search: [
        { __typename: 'Post', id: '100', title: 'Hello' },
        { __typename: 'User', id: '1', name: 'Alice' }
      ]
    }
    // search(2) → Post(0): {id(3), title(6)}, User(1): {id(4), name(6)}
    const tree = [[2, { 0: [3, 6], 1: [4, 6] }]] as any
    const result = flattenResponse(data, tree, 'Query', TEST_MANIFEST)
    expect(result).toEqual([2, 0, '100', 'Hello', 1, '1', 'Alice'])
  })
})

describe('flattenResponse — single union (non-list)', () => {
  // Tests the branch at line 51-58: non-list union field
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

  it('single union encodes type index then values', () => {
    const data = { result: { __typename: 'Post', id: '100', title: 'Hello' } }
    const tree = [[0, { 0: [3, 6], 1: [4, 6] }]] as any
    const result = flattenResponse(data, tree, 'QuerySU', singleUnionManifest)
    expect(result).toEqual([0, '100', 'Hello'])
  })

  it('single union with User type', () => {
    const data = { result: { __typename: 'User', id: '1', name: 'Alice' } }
    const tree = [[0, { 0: [3, 6], 1: [4, 6] }]] as any
    const result = flattenResponse(data, tree, 'QuerySU', singleUnionManifest)
    expect(result).toEqual([1, '1', 'Alice'])
  })
})

describe('flattenResponse — undefined field values', () => {
  it('missing leaf field defaults to null', () => {
    const data = { user: { id: '1' } }
    const tree = [[3, [3, 4, 6]]] as any
    const result = flattenResponse(data, tree, 'Query', TEST_MANIFEST)
    expect(result).toEqual([null, '1', null])
  })

  it('missing nested obj → NULL_OBJECT sentinel via undefined path', () => {
    const data = { post: undefined }
    const tree = [[1, [3, 6]]] as any
    const result = flattenResponse(data, tree, 'Query', TEST_MANIFEST)
    expect(result).toEqual([NULL_OBJECT])
  })
})

describe('encodeResponse', () => {
  it('returns Uint8Array', () => {
    const data = { user: { id: '1', name: 'Alice', email: 'alice@example.com' } }
    const tree = [[3, [3, 4, 6]]] as any
    const result = encodeResponse(data, tree, 'Query', TEST_MANIFEST)
    expect(result).toBeInstanceOf(Uint8Array)
  })

  it('output is valid msgpack that decodes to same array as flattenResponse()', () => {
    const data = { user: { id: '1', name: 'Alice', email: 'alice@example.com' } }
    const tree = [[3, [3, 4, 6]]] as any
    const flat = flattenResponse(data, tree, 'Query', TEST_MANIFEST)
    const encoded = encodeResponse(data, tree, 'Query', TEST_MANIFEST)
    const decoded = msgpackDecode(encoded)
    expect(decoded).toEqual(flat)
  })
})
