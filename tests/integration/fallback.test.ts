import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import http from 'http'
import { ApolloServer } from '@apollo/server'
import { expressMiddleware } from '@apollo/server/express4'
import { print } from 'graphql'
import { BinaryTransferPlugin, expressBinaryMiddleware } from '../../src/server/plugin'
import { MIME_BINARY } from '../../src/shared/constants'
import { TEST_MANIFEST } from '../fixtures/manifest'
import { SCHEMA_SDL } from '../fixtures/schema'
import { resolvers } from '../fixtures/resolvers'
import { GET_USER_SIMPLE, GET_FEED } from '../fixtures/queries'

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

describe('fallback — standard JSON client works alongside binary', () => {
  it('standard JSON request returns correct data', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json'
      },
      body: JSON.stringify({
        query: print(GET_USER_SIMPLE),
        variables: { id: '1' }
      })
    })

    const body = await res.json() as any
    expect(body.data.user.id).toBe('1')
    expect(body.data.user.name).toBe('Alice')
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  it('JSON request still gets BT version and schema hash headers', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json'
      },
      body: JSON.stringify({
        query: '{ viewer { id name } }'
      })
    })

    expect(res.headers.get('x-graphql-bt-version')).toBe('1')
    expect(res.headers.get('x-graphql-schema-hash')).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('fallback — binary request with Accept: JSON gets JSON response', () => {
  it('server returns JSON when client only accepts JSON', async () => {
    // Send binary request but only accept JSON
    const { encodeSelection } = await import('../../src/shared/selection-encoder')
    const { encode: msgpackEncode } = await import('@msgpack/msgpack')

    const { tree, operationType } = encodeSelection(GET_USER_SIMPLE, TEST_MANIFEST)
    const requestBody = { s: tree, o: operationType, v: { id: '1' } }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': MIME_BINARY,
        'accept': 'application/json'  // Only JSON, not binary
      },
      body: msgpackEncode(requestBody)
    })

    // Should get JSON response since accept doesn't include binary
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json() as any
    expect(body.data.user.id).toBe('1')
    expect(body.data.user.name).toBe('Alice')
  })
})

describe('fallback — error propagation through binary layer', () => {
  it('GraphQL validation error returns proper error', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json'
      },
      body: JSON.stringify({
        query: '{ nonExistentField }'
      })
    })

    const body = await res.json() as any
    expect(body.errors).toBeDefined()
    expect(body.errors.length).toBeGreaterThan(0)
  })
})
