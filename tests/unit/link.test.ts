import { describe, it, expect, vi } from 'vitest'
import { parse } from 'graphql'
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack'
import { BinaryTransferLink } from '../../src/client/link'
import { flattenResponse } from '../../src/shared/response-encoder'
import { encodeSelection } from '../../src/shared/selection-encoder'
import { TEST_MANIFEST } from '../fixtures/manifest'
import { USER_ALICE, POST_HELLO } from '../fixtures/responses'
import {
  GET_USER_SIMPLE,
  GET_USER_ALIASED,
  SEARCH_QUERY
} from '../fixtures/queries'
import {
  MIME_BINARY,
  HEADER_SCHEMA_HASH,
  HEADER_ERRORS,
  HEADER_BT_VERSION
} from '../../src/shared/constants'

function createMockFetch(responseData: any, tree: any, rootType = 'Query', opts: {
  contentType?: string
  schemaHash?: string
  errors?: any[]
} = {}) {
  const contentType = opts.contentType ?? MIME_BINARY
  const schemaHash = opts.schemaHash ?? TEST_MANIFEST.schemaHash

  return vi.fn(async (_url: string, _init: any) => {
    let body: ArrayBuffer

    if (contentType.includes(MIME_BINARY)) {
      const flat = flattenResponse(responseData, tree, rootType, TEST_MANIFEST)
      const encoded = msgpackEncode(flat)
      body = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength)
    } else {
      body = new TextEncoder().encode(JSON.stringify({ data: responseData })).buffer
    }

    const headers = new Map<string, string | null>()
    headers.set('content-type', contentType)
    headers.set(HEADER_SCHEMA_HASH, schemaHash)
    headers.set(HEADER_BT_VERSION, '1')

    if (opts.errors) {
      headers.set(HEADER_ERRORS, JSON.stringify(opts.errors))
    }

    return {
      ok: true,
      headers: {
        get: (name: string) => headers.get(name.toLowerCase()) ?? null
      },
      arrayBuffer: async () => body,
      json: async () => JSON.parse(new TextDecoder().decode(body as any))
    } as any
  })
}

describe('BinaryTransferLink — request encoding', () => {
  it('sends binary request with correct headers', async () => {
    const { tree } = encodeSelection(GET_USER_SIMPLE, TEST_MANIFEST)
    const mockFetch = createMockFetch(
      { user: { id: '1', name: 'Alice', email: 'alice@example.com' } },
      tree
    )

    const link = new BinaryTransferLink({
      uri: '/graphql',
      manifest: TEST_MANIFEST,
      fetch: mockFetch
    })

    await new Promise<void>((resolve, reject) => {
      link.request({ query: GET_USER_SIMPLE, variables: { id: '1' } } as any)!
        .subscribe({
          next() {},
          complete: resolve,
          error: reject
        })
    })

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('/graphql')
    expect(init.headers['content-type']).toBe(MIME_BINARY)
    expect(init.headers['accept']).toContain(MIME_BINARY)
  })

  it('encodes query as msgpack with selection tree', async () => {
    const { tree } = encodeSelection(GET_USER_SIMPLE, TEST_MANIFEST)
    const mockFetch = createMockFetch(
      { user: { id: '1', name: 'Alice', email: 'alice@example.com' } },
      tree
    )

    const link = new BinaryTransferLink({
      uri: '/graphql',
      manifest: TEST_MANIFEST,
      fetch: mockFetch
    })

    await new Promise<void>((resolve, reject) => {
      link.request({ query: GET_USER_SIMPLE, variables: { id: '1' } } as any)!
        .subscribe({
          next() {},
          complete: resolve,
          error: reject
        })
    })

    const body = mockFetch.mock.calls[0][1].body
    const decoded = msgpackDecode(body) as any
    expect(decoded.s).toEqual(tree)
    expect(decoded.o).toBe(0)
    expect(decoded.v).toEqual({ v0: '1' })
  })
})

describe('BinaryTransferLink — response decoding', () => {
  it('decodes binary response correctly', async () => {
    const { tree } = encodeSelection(GET_USER_SIMPLE, TEST_MANIFEST)
    const mockFetch = createMockFetch(
      { user: { id: '1', name: 'Alice', email: 'alice@example.com' } },
      tree
    )

    const link = new BinaryTransferLink({
      uri: '/graphql',
      manifest: TEST_MANIFEST,
      fetch: mockFetch
    })

    const result = await new Promise<any>((resolve, reject) => {
      link.request({ query: GET_USER_SIMPLE, variables: { id: '1' } } as any)!
        .subscribe({
          next: resolve,
          error: reject
        })
    })

    expect(result.data.user.id).toBe('1')
    expect(result.data.user.name).toBe('Alice')
    expect(result.data.user.email).toBe('alice@example.com')
  })

  it('handles JSON fallback response', async () => {
    const { tree } = encodeSelection(GET_USER_SIMPLE, TEST_MANIFEST)
    const mockFetch = createMockFetch(
      { user: { id: '1', name: 'Alice', email: 'alice@example.com' } },
      tree,
      'Query',
      { contentType: 'application/json' }
    )

    const link = new BinaryTransferLink({
      uri: '/graphql',
      manifest: TEST_MANIFEST,
      fetch: mockFetch
    })

    const result = await new Promise<any>((resolve, reject) => {
      link.request({ query: GET_USER_SIMPLE, variables: { id: '1' } } as any)!
        .subscribe({
          next: resolve,
          error: reject
        })
    })

    expect(result.data.user.id).toBe('1')
  })

  it('includes errors from header', async () => {
    const { tree } = encodeSelection(GET_USER_SIMPLE, TEST_MANIFEST)
    const mockFetch = createMockFetch(
      { user: { id: '1', name: 'Alice', email: 'alice@example.com' } },
      tree,
      'Query',
      { errors: [{ message: 'partial error' }] }
    )

    const link = new BinaryTransferLink({
      uri: '/graphql',
      manifest: TEST_MANIFEST,
      fetch: mockFetch
    })

    const result = await new Promise<any>((resolve, reject) => {
      link.request({ query: GET_USER_SIMPLE, variables: { id: '1' } } as any)!
        .subscribe({
          next: resolve,
          error: reject
        })
    })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toBe('partial error')
  })
})

describe('BinaryTransferLink — aliases', () => {
  it('applies aliases during response decode', async () => {
    const { tree } = encodeSelection(GET_USER_ALIASED, TEST_MANIFEST)
    const mockFetch = createMockFetch(
      { user: { id: '1', name: 'Alice', email: 'alice@example.com' } },
      tree
    )

    const link = new BinaryTransferLink({
      uri: '/graphql',
      manifest: TEST_MANIFEST,
      fetch: mockFetch
    })

    const result = await new Promise<any>((resolve, reject) => {
      link.request({ query: GET_USER_ALIASED, variables: { id: '1' } } as any)!
        .subscribe({
          next: resolve,
          error: reject
        })
    })

    expect(result.data.user.contactEmail).toBe('alice@example.com')
    expect(result.data.user.userId).toBe('1')
    expect(result.data.user.displayName).toBe('Alice')
  })
})

describe('BinaryTransferLink — __typename injection', () => {
  it('injects __typename for composite objects', async () => {
    const { tree } = encodeSelection(GET_USER_SIMPLE, TEST_MANIFEST)
    const mockFetch = createMockFetch(
      { user: { id: '1', name: 'Alice', email: 'alice@example.com' } },
      tree
    )

    const link = new BinaryTransferLink({
      uri: '/graphql',
      manifest: TEST_MANIFEST,
      fetch: mockFetch
    })

    const result = await new Promise<any>((resolve, reject) => {
      link.request({ query: GET_USER_SIMPLE, variables: { id: '1' } } as any)!
        .subscribe({
          next: resolve,
          error: reject
        })
    })

    expect(result.data.__typename).toBe('Query')
    expect(result.data.user.__typename).toBe('User')
  })
})

describe('BinaryTransferLink — schema drift detection', () => {
  it('logs warning on schema hash mismatch', async () => {
    const { tree } = encodeSelection(GET_USER_SIMPLE, TEST_MANIFEST)
    const mockFetch = createMockFetch(
      { user: { id: '1', name: 'Alice', email: 'alice@example.com' } },
      tree,
      'Query',
      { schemaHash: 'different_hash_val' }
    )

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const link = new BinaryTransferLink({
      uri: '/graphql',
      manifest: TEST_MANIFEST,
      fetch: mockFetch
    })

    await new Promise<void>((resolve, reject) => {
      link.request({ query: GET_USER_SIMPLE, variables: { id: '1' } } as any)!
        .subscribe({
          next() {},
          complete: resolve,
          error: reject
        })
    })

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Schema drift detected')
    )

    warnSpy.mockRestore()
  })
})

describe('BinaryTransferLink — onDecodingFailure warn', () => {
  it('logs warning and still throws on decode failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const mockFetch = vi.fn(async () => ({
      ok: true,
      headers: {
        get: (name: string) => {
          if (name === 'content-type') return MIME_BINARY
          if (name === HEADER_SCHEMA_HASH) return TEST_MANIFEST.schemaHash
          return null
        }
      },
      arrayBuffer: async () => new Uint8Array([0xFF, 0xFF]).buffer
    })) as any

    const link = new BinaryTransferLink({
      uri: '/graphql',
      manifest: TEST_MANIFEST,
      fetch: mockFetch,
      onDecodingFailure: 'warn'
    })

    await expect(new Promise<any>((resolve, reject) => {
      link.request({ query: GET_USER_SIMPLE, variables: { id: '1' } } as any)!
        .subscribe({ next: resolve, error: reject })
    })).rejects.toThrow('Failed to decode response')

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Decode failed'),
      expect.anything()
    )
    warnSpy.mockRestore()
  })
})

describe('BinaryTransferLink — credentials and headers', () => {
  it('passes credentials option to fetch', async () => {
    const { tree } = encodeSelection(GET_USER_SIMPLE, TEST_MANIFEST)
    const mockFetch = createMockFetch(
      { user: { id: '1', name: 'Alice', email: 'alice@example.com' } },
      tree
    )

    const link = new BinaryTransferLink({
      uri: '/graphql',
      manifest: TEST_MANIFEST,
      fetch: mockFetch,
      credentials: 'include'
    })

    await new Promise<void>((resolve, reject) => {
      link.request({ query: GET_USER_SIMPLE, variables: { id: '1' } } as any)!
        .subscribe({ next() {}, complete: resolve, error: reject })
    })

    expect(mockFetch.mock.calls[0][1].credentials).toBe('include')
  })

  it('defaults credentials to same-origin', async () => {
    const { tree } = encodeSelection(GET_USER_SIMPLE, TEST_MANIFEST)
    const mockFetch = createMockFetch(
      { user: { id: '1', name: 'Alice', email: 'alice@example.com' } },
      tree
    )

    const link = new BinaryTransferLink({
      uri: '/graphql',
      manifest: TEST_MANIFEST,
      fetch: mockFetch
    })

    await new Promise<void>((resolve, reject) => {
      link.request({ query: GET_USER_SIMPLE, variables: { id: '1' } } as any)!
        .subscribe({ next() {}, complete: resolve, error: reject })
    })

    expect(mockFetch.mock.calls[0][1].credentials).toBe('same-origin')
  })

  it('headers function called per request', async () => {
    const { tree } = encodeSelection(GET_USER_SIMPLE, TEST_MANIFEST)
    const mockFetch = createMockFetch(
      { user: { id: '1', name: 'Alice', email: 'alice@example.com' } },
      tree
    )

    let callCount = 0
    const link = new BinaryTransferLink({
      uri: '/graphql',
      manifest: TEST_MANIFEST,
      fetch: mockFetch,
      headers: () => {
        callCount++
        return { 'x-custom': 'value' }
      }
    })

    await new Promise<void>((resolve, reject) => {
      link.request({ query: GET_USER_SIMPLE, variables: { id: '1' } } as any)!
        .subscribe({ next() {}, complete: resolve, error: reject })
    })

    expect(callCount).toBe(1)
    expect(mockFetch.mock.calls[0][1].headers['x-custom']).toBe('value')
  })

  it('omits variables when empty', async () => {
    const { tree } = encodeSelection(GET_USER_SIMPLE, TEST_MANIFEST)
    const mockFetch = createMockFetch(
      { user: { id: '1', name: 'Alice', email: 'alice@example.com' } },
      tree
    )

    const link = new BinaryTransferLink({
      uri: '/graphql',
      manifest: TEST_MANIFEST,
      fetch: mockFetch
    })

    await new Promise<void>((resolve, reject) => {
      link.request({ query: GET_USER_SIMPLE, variables: {} } as any)!
        .subscribe({ next() {}, complete: resolve, error: reject })
    })

    const body = mockFetch.mock.calls[0][1].body
    const decoded = msgpackDecode(body) as any
    expect(decoded.v).toBeUndefined()
  })
})

describe('BinaryTransferLink — union alias extraction', () => {
  it('extracts aliases inside union inline fragments', async () => {
    const doc = parse(`
      query($q: String!) {
        search(query: $q) {
          ... on Post { postId: id postTitle: title }
          ... on User { userId: id userName: name }
        }
      }
    `)
    const { tree } = encodeSelection(doc, TEST_MANIFEST)
    const mockFetch = createMockFetch(
      { search: [
        { __typename: 'Post', id: '100', title: 'Hello' },
        { __typename: 'User', id: '1', name: 'Alice' }
      ] },
      tree
    )

    const link = new BinaryTransferLink({
      uri: '/graphql',
      manifest: TEST_MANIFEST,
      fetch: mockFetch
    })

    const result = await new Promise<any>((resolve, reject) => {
      link.request({ query: doc, variables: { q: 'test' } } as any)!
        .subscribe({ next: resolve, error: reject })
    })

    expect(result.data.search[0].postId).toBe('100')
    expect(result.data.search[0].postTitle).toBe('Hello')
    expect(result.data.search[1].userId).toBe('1')
    expect(result.data.search[1].userName).toBe('Alice')
  })
})

describe('BinaryTransferLink — variable remapping', () => {
  it('remaps variable names from query declarations to schema arg names', async () => {
    // Query uses $userId but schema arg is "id"
    const doc = parse(`
      query GetUser($userId: ID!) {
        user(id: $userId) { id name email }
      }
    `)
    const { tree } = encodeSelection(doc, TEST_MANIFEST)
    const mockFetch = createMockFetch(
      { user: { id: '1', name: 'Alice', email: 'alice@example.com' } },
      tree
    )

    const link = new BinaryTransferLink({
      uri: '/graphql',
      manifest: TEST_MANIFEST,
      fetch: mockFetch
    })

    await new Promise<void>((resolve, reject) => {
      link.request({ query: doc, variables: { userId: '1' } } as any)!
        .subscribe({ next() {}, complete: resolve, error: reject })
    })

    const body = mockFetch.mock.calls[0][1].body
    const decoded = msgpackDecode(body) as any
    // Variable should be remapped: userId → v0 (counter-based)
    expect(decoded.v).toEqual({ v0: '1' })
  })

  it('extracts literal argument values into variables', async () => {
    const doc = parse(`
      query { feed(limit: 5) { id title } }
    `)
    const { tree } = encodeSelection(doc, TEST_MANIFEST)
    const mockFetch = createMockFetch(
      { feed: [{ id: '1', title: 'Test' }] },
      tree
    )

    const link = new BinaryTransferLink({
      uri: '/graphql',
      manifest: TEST_MANIFEST,
      fetch: mockFetch
    })

    await new Promise<void>((resolve, reject) => {
      link.request({ query: doc, variables: {} } as any)!
        .subscribe({ next() {}, complete: resolve, error: reject })
    })

    const body = mockFetch.mock.calls[0][1].body
    const decoded = msgpackDecode(body) as any
    // Literal 5 should be extracted into variables as v0
    expect(decoded.v).toEqual({ v0: 5 })
  })

  it('remaps union query variable names', async () => {
    const doc = parse(`
      query($q: String!) {
        search(query: $q) {
          ... on Post { id title }
          ... on User { id name }
        }
      }
    `)
    const { tree } = encodeSelection(doc, TEST_MANIFEST)
    const mockFetch = createMockFetch(
      { search: [
        { __typename: 'Post', id: '100', title: 'Hello' },
        { __typename: 'User', id: '1', name: 'Alice' }
      ] },
      tree
    )

    const link = new BinaryTransferLink({
      uri: '/graphql',
      manifest: TEST_MANIFEST,
      fetch: mockFetch
    })

    await new Promise<void>((resolve, reject) => {
      link.request({ query: doc, variables: { q: 'test' } } as any)!
        .subscribe({ next() {}, complete: resolve, error: reject })
    })

    const body = mockFetch.mock.calls[0][1].body
    const decoded = msgpackDecode(body) as any
    // $q should be remapped to v0 (counter-based)
    expect(decoded.v).toEqual({ v0: 'test' })
  })

  it('handles nested arg remapping', async () => {
    // User.posts has a "limit" arg
    const doc = parse(`
      query($userId: ID!, $postCount: Int) {
        user(id: $userId) { id posts(limit: $postCount) { id title } }
      }
    `)
    const { tree } = encodeSelection(doc, TEST_MANIFEST)
    const mockFetch = createMockFetch(
      { user: { id: '1', posts: [{ id: '100', title: 'Hello' }] } },
      tree
    )

    const link = new BinaryTransferLink({
      uri: '/graphql',
      manifest: TEST_MANIFEST,
      fetch: mockFetch
    })

    await new Promise<void>((resolve, reject) => {
      link.request({ query: doc, variables: { userId: '1', postCount: 5 } } as any)!
        .subscribe({ next() {}, complete: resolve, error: reject })
    })

    const body = mockFetch.mock.calls[0][1].body
    const decoded = msgpackDecode(body) as any
    // user.id → v0, user.posts.limit → v1
    expect(decoded.v).toEqual({ v0: '1', v1: 5 })
  })

  it('extracts literal string value from AST', async () => {
    const doc = parse(`
      query { user(id: "alice-123") { id name } }
    `)
    const { tree } = encodeSelection(doc, TEST_MANIFEST)
    const mockFetch = createMockFetch(
      { user: { id: 'alice-123', name: 'Alice' } },
      tree
    )

    const link = new BinaryTransferLink({
      uri: '/graphql',
      manifest: TEST_MANIFEST,
      fetch: mockFetch
    })

    await new Promise<void>((resolve, reject) => {
      link.request({ query: doc, variables: {} } as any)!
        .subscribe({ next() {}, complete: resolve, error: reject })
    })

    const body = mockFetch.mock.calls[0][1].body
    const decoded = msgpackDecode(body) as any
    expect(decoded.v).toEqual({ v0: 'alice-123' })
  })

  it('passes through variables that already match arg names', async () => {
    const { tree } = encodeSelection(GET_USER_SIMPLE, TEST_MANIFEST)
    const mockFetch = createMockFetch(
      { user: { id: '1', name: 'Alice', email: 'alice@example.com' } },
      tree
    )

    const link = new BinaryTransferLink({
      uri: '/graphql',
      manifest: TEST_MANIFEST,
      fetch: mockFetch
    })

    await new Promise<void>((resolve, reject) => {
      link.request({ query: GET_USER_SIMPLE, variables: { id: '1' } } as any)!
        .subscribe({ next() {}, complete: resolve, error: reject })
    })

    const body = mockFetch.mock.calls[0][1].body
    const decoded = msgpackDecode(body) as any
    // id → v0 (counter-based naming regardless of original name)
    expect(decoded.v).toEqual({ v0: '1' })
  })
})

describe('BinaryTransferLink — collision resolution', () => {
  it('two fields with same schema arg name get unique counter-based variables', async () => {
    // Both user(id:) and post(id:) have schema arg "id" — old approach would collide
    const doc = parse(`
      query($userId: ID!, $postId: ID!) {
        user(id: $userId) { id name }
        post(id: $postId) { id title }
      }
    `)
    const { tree } = encodeSelection(doc, TEST_MANIFEST)

    // We need mock data that matches both user and post sub-selections
    // user tree: [4, 6] (id, name), post tree: [3, 6] (id, title)
    const mockFetch = createMockFetch(
      { user: { id: '1', name: 'Alice' }, post: { id: '100', title: 'Hello' } },
      tree
    )

    const link = new BinaryTransferLink({
      uri: '/graphql',
      manifest: TEST_MANIFEST,
      fetch: mockFetch
    })

    await new Promise<void>((resolve, reject) => {
      link.request({
        query: doc,
        variables: { userId: 'user-1', postId: 'post-100' }
      } as any)!
        .subscribe({ next() {}, complete: resolve, error: reject })
    })

    const body = mockFetch.mock.calls[0][1].body
    const decoded = msgpackDecode(body) as any
    // user.id → v0, post.id → v1 — no collision!
    expect(decoded.v.v0).toBe('user-1')
    expect(decoded.v.v1).toBe('post-100')
  })

  it('field with multiple args assigns sequential counters', async () => {
    // users(limit: Int, offset: Int) — both args get unique names
    const doc = parse(`
      query($n: Int, $skip: Int) {
        users(limit: $n, offset: $skip) { id name }
      }
    `)
    const { tree } = encodeSelection(doc, TEST_MANIFEST)
    const mockFetch = createMockFetch(
      { users: [{ id: '1', name: 'Alice' }] },
      tree
    )

    const link = new BinaryTransferLink({
      uri: '/graphql',
      manifest: TEST_MANIFEST,
      fetch: mockFetch
    })

    await new Promise<void>((resolve, reject) => {
      link.request({
        query: doc,
        variables: { n: 10, skip: 20 }
      } as any)!
        .subscribe({ next() {}, complete: resolve, error: reject })
    })

    const body = mockFetch.mock.calls[0][1].body
    const decoded = msgpackDecode(body) as any
    // users args alphabetical: limit(v0), offset(v1)
    expect(decoded.v.v0).toBe(10)
    expect(decoded.v.v1).toBe(20)
  })

  it('unprovided optional args are skipped in values but still counted', async () => {
    // users(limit: Int, offset: Int) but only limit provided
    const doc = parse(`
      query($n: Int) {
        users(limit: $n) { id name }
      }
    `)
    const { tree } = encodeSelection(doc, TEST_MANIFEST)
    const mockFetch = createMockFetch(
      { users: [{ id: '1', name: 'Alice' }] },
      tree
    )

    const link = new BinaryTransferLink({
      uri: '/graphql',
      manifest: TEST_MANIFEST,
      fetch: mockFetch
    })

    await new Promise<void>((resolve, reject) => {
      link.request({
        query: doc,
        variables: { n: 10 }
      } as any)!
        .subscribe({ next() {}, complete: resolve, error: reject })
    })

    const body = mockFetch.mock.calls[0][1].body
    const decoded = msgpackDecode(body) as any
    // limit → v0 (provided), offset → v1 (counter increments but no value set)
    expect(decoded.v.v0).toBe(10)
    expect(decoded.v.v1).toBeUndefined()
  })
})

describe('BinaryTransferLink — error handling', () => {
  it('throws on unexpected content-type', async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      headers: {
        get: (name: string) => {
          if (name === 'content-type') return 'text/plain'
          if (name === HEADER_SCHEMA_HASH) return TEST_MANIFEST.schemaHash
          return null
        }
      },
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as any

    const link = new BinaryTransferLink({
      uri: '/graphql',
      manifest: TEST_MANIFEST,
      fetch: mockFetch
    })

    await expect(new Promise<any>((resolve, reject) => {
      link.request({ query: GET_USER_SIMPLE, variables: { id: '1' } } as any)!
        .subscribe({
          next: resolve,
          error: reject
        })
    })).rejects.toThrow('Unexpected content-type')
  })
})
