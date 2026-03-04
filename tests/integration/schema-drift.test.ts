import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import express from 'express'
import http from 'http'
import { ApolloServer } from '@apollo/server'
import { expressMiddleware } from '@apollo/server/express4'
import { buildSchema } from 'graphql'
import { BinaryTransferPlugin, expressBinaryMiddleware } from '../../src/server/plugin'
import { BinaryTransferLink } from '../../src/client/link'
import { generateManifest } from '../../src/shared/manifest'
import { SCHEMA_SDL } from '../fixtures/schema'
import { resolvers } from '../fixtures/resolvers'
import gql from 'graphql-tag'

describe('schema drift detection', () => {
  let server: ApolloServer
  let httpServer: http.Server
  let url: string

  // Create manifest from original schema
  const originalManifest = generateManifest(buildSchema(SCHEMA_SDL))

  // Create a modified schema with an extra field that shifts indices
  const MODIFIED_SDL = SCHEMA_SDL.replace(
    'email: String!',
    'department: String\n    email: String!'
  )

  beforeAll(async () => {
    // Server runs MODIFIED schema but client has ORIGINAL manifest
    const modifiedManifest = generateManifest(buildSchema(MODIFIED_SDL))

    server = new ApolloServer({
      typeDefs: MODIFIED_SDL,
      resolvers: {
        ...resolvers,
        User: {
          ...resolvers.User,
          department: () => 'Engineering'
        }
      },
      plugins: [BinaryTransferPlugin({ manifest: modifiedManifest })]
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

  it('client detects schema hash mismatch and logs warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const link = new BinaryTransferLink({
      uri: url,
      manifest: originalManifest
    })

    try {
      await new Promise<any>((resolve, reject) => {
        link.request({
          query: gql`query { user(id: "1") { id name } }`,
          variables: { id: '1' },
          operationName: '',
          extensions: {},
          setContext: () => ({}),
          getContext: () => ({})
        } as any)!.subscribe({ next: resolve, error: reject })
      })
    } catch {
      // May fail due to encoding mismatch — that's expected
    }

    const driftWarnings = warnSpy.mock.calls.filter(
      args => String(args[0]).includes('Schema drift')
    )
    expect(driftWarnings.length).toBeGreaterThan(0)

    warnSpy.mockRestore()
  })

  it('server logs schema hash mismatch on startup when manifest is stale', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Create a server with stale manifest (original manifest, modified schema)
    const staleServer = new ApolloServer({
      typeDefs: MODIFIED_SDL,
      resolvers,
      plugins: [BinaryTransferPlugin({ manifest: originalManifest })]
    })
    await staleServer.start()

    const mismatchWarnings = warnSpy.mock.calls.filter(
      args => String(args[0]).includes('Schema hash mismatch')
    )
    expect(mismatchWarnings.length).toBeGreaterThan(0)

    await staleServer.stop()
    warnSpy.mockRestore()
  })
})
