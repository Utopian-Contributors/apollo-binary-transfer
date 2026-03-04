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
    expect(decoded.v).toEqual({ id: '1' })
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
