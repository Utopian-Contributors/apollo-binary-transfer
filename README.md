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
→  msgpack({ s: [[3, [3, 4, 6]]], o: 0, v: { v0: "1" } })    // 29 bytes
←  msgpack(["alice@example.com", "1", "Alice"])                 // 32 bytes
```

Variables use counter-based naming (`v0`, `v1`, ...) to avoid collisions when multiple fields share the same argument name.

**Request reduction: 79–85%. Response reduction: 15–64%** (depending on query shape and payload diversity).

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

### Wire size reduction (uncompressed)

| Query shape | Request | Response |
|---|---|---|
| Micro (3 fields) | -81% | -37% |
| Small (8 fields, nested) | -85% | -21% |
| Medium list (20 items) | -83% | -33% |
| Large list (100 items) | -83% | -32% |
| Stress (1000 items) | -82% | -16% |

### Wire size with gzip

With gzip enabled (standard in production), the response savings are smaller because gzip already compresses repeated field names well:

| Query shape | JSON+gzip | Binary+gzip | Additional savings |
|---|---|---|---|
| Micro (3 fields) | 122B | 92B | -25% |
| Small (8 fields, nested) | 461B | 402B | -13% |
| Medium list (20 items) | 1177B | 1134B | -4% |
| Large list (100 items) | 4136B | 4066B | -2% |
| Stress (1000 items) | 40144B | 35735B | -11% |

The binary protocol's advantage compounds with gzip on small payloads (where gzip header overhead hurts JSON) and on stress-scale responses. For mid-size list responses with gzip, the savings are modest.

### Why it's smaller

**Requests:** Query text (`query { user(id: $id) { id name email } }`) is replaced by a flat integer array (`[[3, [3, 4, 6]]]`). Field names become single-byte indices. The larger and more complex the query, the bigger the savings.

**Responses:** JSON keys (`"id"`, `"name"`, `"email"`) are eliminated entirely. The response is a flat value array in positional order: the client knows which value corresponds to which field from the shared manifest + selection tree. List items use columnar encoding — all values of the same field are grouped together — which improves compression further.

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
bun run test           # 211 tests
bun run test:coverage  # Coverage report
bun run bench          # Performance benchmarks
bun run build          # Build ESM + CJS + DTS
```
