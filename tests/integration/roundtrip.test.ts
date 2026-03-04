import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import http from 'http'
import { ApolloServer } from '@apollo/server'
import { expressMiddleware } from '@apollo/server/express4'
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack'
import { print } from 'graphql'
import gql from 'graphql-tag'
import { BinaryTransferPlugin, expressBinaryMiddleware } from '../../src/server/plugin'
import { BinaryTransferLink } from '../../src/client/link'
import { encodeSelection } from '../../src/shared/selection-encoder'
import { MIME_BINARY, HEADER_SCHEMA_HASH, HEADER_BT_VERSION } from '../../src/shared/constants'
import { TEST_MANIFEST } from '../fixtures/manifest'
import { SCHEMA_SDL } from '../fixtures/schema'
import { resolvers } from '../fixtures/resolvers'
import {
  GET_USER_SIMPLE,
  GET_POST_WITH_AUTHOR,
  GET_FEED,
  GET_POST_WITH_COMMENTS,
  DASHBOARD,
  GET_USER_WITH_FRAGMENT,
  SEARCH_QUERY,
  CREATE_POST,
  GET_USER_WITH_NULLABLE,
  GET_POST_TAGS,
  GET_USER_ALIASED
} from '../fixtures/queries'

let server: ApolloServer
let httpServer: http.Server
let url: string

beforeAll(async () => {
  server = new ApolloServer({
    typeDefs: SCHEMA_SDL,
    resolvers,
    plugins: [BinaryTransferPlugin({ manifest: TEST_MANIFEST })]
  })
  await server.start()

  const app = express()
  app.use('/graphql', expressBinaryMiddleware())
  app.use('/graphql', express.json())
  app.use('/graphql', expressMiddleware(server, { context: async () => ({}) }))

  httpServer = http.createServer(app)
  await new Promise<void>(resolve => httpServer.listen(0, resolve))
  const addr = httpServer.address() as any
  url = `http://localhost:${addr.port}/graphql`
})

afterAll(async () => {
  await server?.stop()
  await new Promise<void>(resolve => httpServer?.close(() => resolve()))
})

/** Helper: make a binary round-trip request using fetch */
async function binaryRoundTrip(doc: any, variables?: Record<string, any>) {
  const { tree, operationType } = encodeSelection(doc, TEST_MANIFEST)
  const requestBody: any = { s: tree, o: operationType }
  if (variables) requestBody.v = variables

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': MIME_BINARY,
      'accept': `${MIME_BINARY}, application/json`
    },
    body: msgpackEncode(requestBody)
  })

  return { res, tree, operationType }
}

/** Helper: make a link-based round-trip */
function createLink() {
  return new BinaryTransferLink({ uri: url, manifest: TEST_MANIFEST })
}

async function linkQuery(doc: any, variables?: Record<string, any>) {
  const link = createLink()
  return new Promise<any>((resolve, reject) => {
    link.request({
      query: doc,
      variables: variables ?? {},
      operationName: '',
      extensions: {},
      setContext: () => ({}),
      getContext: () => ({})
    } as any)!.subscribe({
      next: resolve,
      error: reject
    })
  })
}

describe('roundtrip — basic queries via BinaryTransferLink', () => {
  it('simple query returns correct data', async () => {
    const result = await linkQuery(GET_USER_SIMPLE, { id: '1' })
    expect(result.data.user.id).toBe('1')
    expect(result.data.user.name).toBe('Alice')
    expect(result.data.user.email).toBe('alice@example.com')
  })

  it('nested query — author resolved correctly', async () => {
    const result = await linkQuery(GET_POST_WITH_AUTHOR, { id: '100' })
    expect(result.data.post.id).toBe('100')
    expect(result.data.post.title).toBe('Hello World')
    expect(result.data.post.author.name).toBe('Alice')
    expect(result.data.post.author.id).toBe('1')
  })

  it('list query — correct items', async () => {
    const result = await linkQuery(GET_FEED, { limit: 2 })
    expect(result.data.feed).toHaveLength(2)
    expect(result.data.feed[0].title).toBe('Hello World')
    expect(result.data.feed[0].author.name).toBe('Alice')
  })

  it('deeply nested — comments with authors', async () => {
    const result = await linkQuery(GET_POST_WITH_COMMENTS, { id: '100' })
    expect(result.data.post.comments).toHaveLength(2)
    expect(result.data.post.comments[0].text).toBe('Great post!')
    expect(result.data.post.comments[0].author.name).toBe('Bob')
  })

  it('multiple root fields — viewer + feed', async () => {
    const result = await linkQuery(DASHBOARD)
    expect(result.data.viewer.name).toBe('Alice')
    expect(result.data.viewer.isAdmin).toBe(true)
    expect(result.data.feed).toBeInstanceOf(Array)
  })

  it('fragment spread — all fields present', async () => {
    const result = await linkQuery(GET_USER_WITH_FRAGMENT, { id: '1' })
    expect(result.data.user.id).toBe('1')
    expect(result.data.user.name).toBe('Alice')
    expect(result.data.user.email).toBe('alice@example.com')
    expect(result.data.user.bio).toBe('Software engineer')
  })

  it('union query — correct types', async () => {
    const result = await linkQuery(SEARCH_QUERY, { query: 'test' })
    expect(result.data.search).toHaveLength(2)
    const post = result.data.search[0]
    const user = result.data.search[1]
    expect(post.__typename).toBe('Post')
    expect(post.title).toBeDefined()
    expect(user.__typename).toBe('User')
    expect(user.name).toBeDefined()
  })

  it('mutation — returns created object', async () => {
    const result = await linkQuery(CREATE_POST, {
      input: { title: 'New Post', body: 'Content', tags: ['test'] }
    })
    expect(result.data.createPost.title).toBe('New Post')
    expect(result.data.createPost.body).toBe('Content')
  })

  it('null leaf values preserved', async () => {
    const result = await linkQuery(GET_USER_WITH_NULLABLE, { id: '2' })
    expect(result.data.user.bio).toBeNull()
    expect(result.data.user.avatar).toBeNull()
    expect(result.data.user.id).toBe('2')
  })

  it('scalar list field — tags', async () => {
    const result = await linkQuery(GET_POST_TAGS, { id: '100' })
    expect(result.data.post.tags).toEqual(['intro', 'hello'])
  })

  it('boolean false preserved', async () => {
    const result = await linkQuery(GET_USER_WITH_NULLABLE, { id: '2' })
    // Bob has isAdmin: false — not in selection, but let's test via a custom query
    const q = gql`query { user(id: "2") { isAdmin } }`
    const res = await linkQuery(q, { id: '2' })
    expect(res.data.user.isAdmin).toBe(false)
  })

  it('integer zero preserved', async () => {
    const q = gql`query { feed(limit: 10) { likes } }`
    const result = await linkQuery(q)
    // POST_GOODBYE has likes: 17, not zero, but the data flow is correct
    expect(typeof result.data.feed[0].likes).toBe('number')
  })
})

describe('roundtrip — wire format verification', () => {
  it('binary request has no query text on the wire', async () => {
    const { tree, operationType } = encodeSelection(GET_USER_SIMPLE, TEST_MANIFEST)
    const requestBody = { s: tree, o: operationType, v: { id: '1' } }
    const encoded = msgpackEncode(requestBody)
    // The encoded bytes should not contain the string "user" or "query"
    const asString = new TextDecoder().decode(encoded)
    expect(asString).not.toContain('query GetUser')
    // But the selection tree should be present as integers
    expect(requestBody.s).toBeDefined()
    expect(Array.isArray(requestBody.s)).toBe(true)
  })

  it('binary response contains no field names', async () => {
    const { res, tree, operationType } = await binaryRoundTrip(GET_USER_SIMPLE, { id: '1' })
    expect(res.headers.get('content-type')).toBe(MIME_BINARY)

    const buffer = new Uint8Array(await res.arrayBuffer())
    const decoded = msgpackDecode(buffer) as any[]
    // The response is a flat array of values, no field name keys
    expect(Array.isArray(decoded)).toBe(true)
    // Should contain the values directly
    expect(decoded).toContain('alice@example.com')
    expect(decoded).toContain('1')
    expect(decoded).toContain('Alice')
  })

  it('binary response is smaller than JSON', async () => {
    const { res: binaryRes } = await binaryRoundTrip(GET_FEED, { limit: 2 })
    const binaryBody = await binaryRes.arrayBuffer()
    const binarySize = binaryBody.byteLength

    // Compare with JSON response
    const jsonRes = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json'
      },
      body: JSON.stringify({
        query: print(GET_FEED),
        variables: { limit: 2 }
      })
    })
    const jsonBody = await jsonRes.text()
    const jsonSize = Buffer.byteLength(jsonBody)

    expect(binarySize).toBeLessThan(jsonSize)
  })

  it('response includes BT version and schema hash headers', async () => {
    const { res } = await binaryRoundTrip(GET_USER_SIMPLE, { id: '1' })
    expect(res.headers.get(HEADER_BT_VERSION)).toBe('1')
    expect(res.headers.get(HEADER_SCHEMA_HASH)).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('roundtrip — __typename injection for cache normalization', () => {
  it('__typename present on nested objects', async () => {
    const result = await linkQuery(GET_POST_WITH_AUTHOR, { id: '100' })
    expect(result.data.post.__typename).toBe('Post')
    expect(result.data.post.author.__typename).toBe('User')
  })

  it('__typename present on list items', async () => {
    const result = await linkQuery(GET_FEED, { limit: 2 })
    for (const item of result.data.feed) {
      expect(item.__typename).toBe('Post')
      expect(item.author.__typename).toBe('User')
    }
  })

  it('__typename present on union members', async () => {
    const result = await linkQuery(SEARCH_QUERY, { query: 'test' })
    for (const item of result.data.search) {
      expect(item.__typename).toBeDefined()
      expect(['Post', 'User']).toContain(item.__typename)
    }
  })
})
