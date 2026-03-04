# apollo-binary-transfer

Drop-in binary wire format for Apollo GraphQL. Replaces JSON text with positional binary encoding — no field names on the wire, no query text on the wire.

## How it works

Standard GraphQL sends field names in both directions:

```
→  {"query":"{ user(id:\"1\") { id name email } }","variables":{"id":"1"}}
←  {"data":{"user":{"id":"1","name":"Alice","email":"alice@example.com"}}}
```

With binary transfer, both sides share a **manifest**: a schema position map where fields are identified by their alphabetical sort index within each type. Requests send integer field indices, responses send flat value arrays:

```
→  msgpack({ s: [[3, [3, 4, 6]]], o: 0, v: { id: "1" } })    // 29 bytes
←  msgpack(["alice@example.com", "1", "Alice"])                 // 32 bytes
```

**Request reduction: 79–85%. Response reduction: 59–91%** (depending on query shape and list length).

## Setup

### 1. Install

```bash
npm install apollo-binary-transfer
```

Peer dependencies: `graphql`, `@apollo/server` (server), `@apollo/client` (client).

### 2. Generate the manifest

The manifest maps your schema's types and fields to positional indices. Generate it whenever your schema changes.

**Option A: Codegen plugin** (recommended)

```yaml
# codegen.yml
schema: ./schema.graphql
generates:
  ./src/generated/bt-manifest.json:
    plugins:
      - apollo-binary-transfer/codegen
```

```bash
npx graphql-codegen
```

**Option B: Programmatic**

```ts
import { buildSchema } from 'graphql'
import { generateManifest } from 'apollo-binary-transfer/shared'

const schema = buildSchema(sdl)
const manifest = generateManifest(schema)
fs.writeFileSync('bt-manifest.json', JSON.stringify(manifest, null, 2))
```

### 3. Server setup (Apollo Server + Express)

```ts
import { ApolloServer } from '@apollo/server'
import { expressMiddleware } from '@apollo/server/express4'
import express from 'express'
import { BinaryTransferPlugin, expressBinaryMiddleware } from 'apollo-binary-transfer/server'
import manifest from './generated/bt-manifest.json'

const server = new ApolloServer({
  typeDefs,
  resolvers,
  plugins: [BinaryTransferPlugin({ manifest })]
})
await server.start()

const app = express()

// Binary middleware MUST come before express.json() and expressMiddleware
app.use('/graphql', expressBinaryMiddleware())
app.use('/graphql', express.json())
app.use('/graphql', expressMiddleware(server))

app.listen(4000)
```

**Middleware order matters.** `expressBinaryMiddleware()` does two things:
- Parses incoming `application/graphql-binary` requests (raw body → msgpack)
- Intercepts outgoing responses to send binary bytes when the plugin encodes them

### 4. Client setup (Apollo Client)

```ts
import { ApolloClient, InMemoryCache } from '@apollo/client'
import { BinaryTransferLink } from 'apollo-binary-transfer/client'
import manifest from './generated/bt-manifest.json'

const link = new BinaryTransferLink({
  uri: 'http://localhost:4000/graphql',
  manifest
})

const client = new ApolloClient({
  link,
  cache: new InMemoryCache()
})
```

That's it. All `client.query()` and `client.mutate()` calls now use binary encoding. Apollo Client cache normalization works because `__typename` is automatically injected on all composite objects.

### Link options

```ts
new BinaryTransferLink({
  uri: string,                // GraphQL endpoint
  manifest: BinaryTransferManifest,
  fetch?: typeof fetch,       // Custom fetch implementation
  headers?: Record<string, string> | (() => Record<string, string>),
  credentials?: RequestCredentials,  // Default: 'same-origin'
  onDecodingFailure?: 'error' | 'warn'  // Default: 'error'
})
```

## Schema drift detection

Both client and server compare the manifest's schema hash against the live schema. If they drift:

- **Server** logs a warning at startup when the manifest hash doesn't match the running schema
- **Client** logs a warning per-request when the server's `X-GraphQL-Schema-Hash` header differs from the manifest

Regenerate the manifest when you see these warnings.

## Fallback behavior

- JSON clients work alongside binary on the same server. The plugin only activates for `application/graphql-binary` requests.
- If binary encoding fails (e.g. encoding error), the server falls back to JSON automatically.
- If GraphQL errors are too large for the `X-GraphQL-Errors` header (default 8KB limit), the response falls back to JSON.

## Performance characteristics

### Wire size reduction

| Query shape | Request | Response |
|---|---|---|
| Micro (3 fields) | -79% | -59% |
| Small (8 fields, nested) | -83% | -70% |
| Medium list (20 items) | -83% | -73% |
| Large list (100 items) | -85% | -78% |
| Stress (1000 items) | -85% | -91% |

### Why it's smaller

**Requests:** Query text (`query { user(id: $id) { id name email } }`) is replaced by a flat integer array (`[[3, [3, 4, 6]]]`). Field names become single-byte indices. The larger and more complex the query, the bigger the savings.

**Responses:** JSON keys (`"id"`, `"name"`, `"email"`) are eliminated entirely. The response is a flat value array in positional order: the client knows which value corresponds to which field from the shared manifest + selection tree. For large lists, this compounds: 100 items means 100x fewer key strings.

**Encoding:** msgpack is used for serialization, which is more compact than JSON for numbers, booleans, and binary data.

### Why it's fast

The encoding/decoding is a simple tree walk with no parsing, no string manipulation, and no hash lookups on field names. Both `flattenResponse` and `rebuildResponse` are single-pass O(n) where n is the number of values.

## API reference

### Exports

| Entry point | Exports |
|---|---|
| `apollo-binary-transfer/server` | `BinaryTransferPlugin`, `expressBinaryMiddleware` |
| `apollo-binary-transfer/client` | `BinaryTransferLink` |
| `apollo-binary-transfer/codegen` | `plugin`, `validate` (codegen plugin) |
| `apollo-binary-transfer/shared` | `generateManifest`, `encodeSelection`, `decodeSelection`, `flattenResponse`, `encodeResponse`, `rebuildResponse`, `decodeResponse`, `computeSchemaHash` |
| `apollo-binary-transfer` | Re-exports all shared utilities |

### Plugin options

```ts
BinaryTransferPlugin({
  manifest: BinaryTransferManifest,
  maxErrorHeaderSize?: number  // Default: 8192 bytes
})
```

## Development

```bash
bun install
bun run test           # 190 tests
bun run test:coverage  # Coverage report
bun run bench          # Performance benchmarks
bun run build          # Build ESM + CJS + DTS
```
