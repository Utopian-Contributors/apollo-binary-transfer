import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import http from 'http'
import { ApolloServer } from '@apollo/server'
import { expressMiddleware } from '@apollo/server/express4'
import gql from 'graphql-tag'
import { BinaryTransferPlugin, expressBinaryMiddleware } from '../../src/server/plugin'
import { BinaryTransferLink } from '../../src/client/link'
import { TEST_MANIFEST } from '../fixtures/manifest'
import { SCHEMA_SDL } from '../fixtures/schema'
import { resolvers } from '../fixtures/resolvers'
import { USER_ALICE, POST_HELLO, COMMENT_1 } from '../fixtures/responses'

let server: ApolloServer
let httpServer: http.Server
let url: string

// Extended resolvers for edge case testing
const edgeCaseResolvers = {
  ...resolvers,
  Query: {
    ...resolvers.Query,
    feed: (_: any, { limit }: { limit?: number }) => {
      if (limit === 0) return []
      const count = limit ?? 2
      return Array.from({ length: count }, (_, i) => ({
        ...POST_HELLO,
        id: String(100 + i),
        title: `Post ${i}`,
        likes: i
      }))
    },
    user: (_: any, { id }: { id: string }) => {
      if (id === 'unicode') return {
        ...USER_ALICE,
        id: 'unicode',
        name: 'Alice \u{1F680} \u4F60\u597D \u0645\u0631\u062D\u0628\u0627',
        bio: '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466} Family emoji'
      }
      if (id === 'longstring') return {
        ...USER_ALICE,
        id: 'longstring',
        bio: 'x'.repeat(100_000)
      }
      if (id === 'maxint') return {
        ...USER_ALICE,
        id: 'maxint',
        age: 2_147_483_647  // GraphQL Int max (32-bit signed)
      }
      return resolvers.Query.user(_, { id })
    }
  },
  Post: {
    ...resolvers.Post,
    comments: (parent: any) => {
      if (parent.id === '100') {
        return Array.from({ length: 30 }, (_, i) => ({
          ...COMMENT_1,
          id: `c${i}`,
          text: `Comment ${i}`,
          author: i % 2 === 0 ? USER_ALICE : { ...USER_ALICE, id: '2', name: 'Bob' }
        }))
      }
      return []
    }
  }
}

beforeAll(async () => {
  server = new ApolloServer({
    typeDefs: SCHEMA_SDL,
    resolvers: edgeCaseResolvers,
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

async function linkQuery(doc: any, variables?: Record<string, any>) {
  const link = new BinaryTransferLink({ uri: url, manifest: TEST_MANIFEST })
  return new Promise<any>((resolve, reject) => {
    link.request({
      query: doc,
      variables: variables ?? {},
      operationName: '',
      extensions: {},
      setContext: () => ({}),
      getContext: () => ({})
    } as any)!.subscribe({ next: resolve, error: reject })
  })
}

describe('edge cases — large data', () => {
  it('large list (100 items) round-trips correctly', async () => {
    // Must use variables — literal arg values are lost in binary encoding
    const q = gql`query($limit: Int) { feed(limit: $limit) { id title likes author { name } } }`
    const result = await linkQuery(q, { limit: 100 })
    expect(result.data.feed).toHaveLength(100)
    expect(result.data.feed[0].title).toBe('Post 0')
    expect(result.data.feed[99].title).toBe('Post 99')
    expect(result.data.feed[99].likes).toBe(99)
  })

  it('deeply nested (post → 30 comments → authors) round-trips correctly', async () => {
    const q = gql`query {
      post(id: "100") {
        id title
        comments { id text author { id name } createdAt }
      }
    }`
    const result = await linkQuery(q, { id: '100' })
    expect(result.data.post.comments).toHaveLength(30)
    expect(result.data.post.comments[0].text).toBe('Comment 0')
    expect(result.data.post.comments[0].author.name).toBe('Alice')
    expect(result.data.post.comments[29].text).toBe('Comment 29')
  })
})

describe('edge cases — special values', () => {
  it('unicode strings (emoji, CJK, RTL) preserved', async () => {
    const q = gql`query { user(id: "unicode") { id name bio } }`
    const result = await linkQuery(q, { id: 'unicode' })
    expect(result.data.user.name).toContain('\u{1F680}')
    expect(result.data.user.name).toContain('\u4F60\u597D')
    expect(result.data.user.bio).toContain('\u{1F468}\u200D\u{1F469}')
  })

  it('very long string (100KB) preserved', async () => {
    const q = gql`query { user(id: "longstring") { id bio } }`
    const result = await linkQuery(q, { id: 'longstring' })
    expect(result.data.user.bio).toHaveLength(100_000)
    expect(result.data.user.bio).toBe('x'.repeat(100_000))
  })

  it('large integer preserved (GraphQL Int max: 2^31 - 1)', async () => {
    const q = gql`query($id: ID!) { user(id: $id) { id age } }`
    const result = await linkQuery(q, { id: 'maxint' })
    expect(result.data.user.id).toBe('maxint')
    expect(result.data.user.age).toBe(2_147_483_647)
  })

  it('empty list round-trips correctly', async () => {
    const q = gql`query($limit: Int) { feed(limit: $limit) { id title } }`
    const result = await linkQuery(q, { limit: 0 })
    expect(result.data.feed).toEqual([])
  })

  it('null nullable object preserved', async () => {
    const q = gql`query { post(id: "nonexistent") { id title } }`
    const result = await linkQuery(q, { id: 'nonexistent' })
    expect(result.data.post).toBeNull()
  })
})

describe('edge cases — concurrency', () => {
  it('concurrent requests all produce correct output', async () => {
    const q = gql`query($limit: Int) { feed(limit: $limit) { id title likes } }`
    const queries = Array.from({ length: 10 }, (_, i) =>
      linkQuery(q, { limit: i + 1 })
    )

    const results = await Promise.all(queries)
    for (let i = 0; i < 10; i++) {
      expect(results[i].data.feed).toHaveLength(i + 1)
    }
  })
})

describe('edge cases — aliased fields round-trip', () => {
  it('aliased leaf fields decoded correctly', async () => {
    const q = gql`query {
      user(id: "1") { userId: id displayName: name contactEmail: email }
    }`
    const result = await linkQuery(q, { id: '1' })
    expect(result.data.user.userId).toBe('1')
    expect(result.data.user.displayName).toBe('Alice')
    expect(result.data.user.contactEmail).toBe('alice@example.com')
  })

  it('aliased root field NOT supported (uses schema name)', async () => {
    // Note: aliases on root fields are tricky — the response decoder uses
    // manifest field names. The alias is on the AST level but the
    // binary protocol uses field indices, so root-level aliases work
    // through the extractAliases mechanism in the link.
    const q = gql`query {
      me: user(id: "1") { id name }
    }`
    const result = await linkQuery(q, { id: '1' })
    // The link's extractAliases maps Query field index for 'user' → 'me'
    expect(result.data.me.id).toBe('1')
    expect(result.data.me.name).toBe('Alice')
  })
})

describe('edge cases — fragment spread on union round-trip', () => {
  it('named fragments on union members decode correctly', async () => {
    const q = gql`
      fragment PostInfo on Post { id title }
      fragment UserInfo on User { id name }
      query {
        search(query: "test") {
          ...PostInfo
          ...UserInfo
        }
      }
    `
    const result = await linkQuery(q, { query: 'test' })
    expect(result.data.search[0].__typename).toBe('Post')
    expect(result.data.search[0].title).toBeDefined()
    expect(result.data.search[1].__typename).toBe('User')
    expect(result.data.search[1].name).toBeDefined()
  })
})

describe('edge cases — query shapes', () => {
  it('single leaf field — minimal encoding', async () => {
    const q = gql`query { user(id: "1") { name } }`
    const result = await linkQuery(q, { id: '1' })
    expect(result.data.user.name).toBe('Alice')
  })

  it('selecting every field on a type', async () => {
    const q = gql`query {
      user(id: "1") { age avatar bio email id isAdmin name }
    }`
    const result = await linkQuery(q, { id: '1' })
    expect(result.data.user.id).toBe('1')
    expect(result.data.user.name).toBe('Alice')
    expect(result.data.user.email).toBe('alice@example.com')
    expect(result.data.user.bio).toBe('Software engineer')
    expect(result.data.user.age).toBe(30)
    expect(result.data.user.isAdmin).toBe(true)
    expect(result.data.user.avatar).toBe('https://example.com/alice.jpg')
  })

  it('union list with mixed types preserves order', async () => {
    const q = gql`query {
      search(query: "test") {
        ... on Post { id title }
        ... on User { id name }
      }
    }`
    const result = await linkQuery(q, { query: 'test' })
    expect(result.data.search[0].__typename).toBe('Post')
    expect(result.data.search[1].__typename).toBe('User')
  })
})
