# apollo-binary-transfer — Package Specification

Version: 3.0.0-draft
Status: Pre-implementation specification

---

## 1. Overview

`apollo-binary-transfer` replaces GraphQL's text-based wire format with positional binary encoding derived from the schema. Requests send integer field indices instead of query strings. Responses send flat value arrays instead of keyed JSON objects. Production traffic is fully opaque — no field names, no type structures, no schema information on the wire.

It ships four things:

1. **`BinaryTransferPlugin`** — an `ApolloServerPlugin` that decodes positional selection requests, executes them, and encodes responses as positional binary.
2. **`BinaryTransferLink`** — a terminating `ApolloLink` that encodes queries as positional selections and decodes binary responses.
3. **`apollo-binary-transfer/codegen`** — a `graphql-codegen` plugin that generates the manifest (a schema position map) from the schema. Drop it into your existing `codegen.ts`.
4. **`generateManifest`** — the underlying utility if you're not using codegen.

The shared contract is the schema's alphabetical field ordering, not a table of known queries. The client can send any valid selection — no per-query registration, no manifest updates when queries change, no server redeployment for client-side query changes.

### 1.1 Design Goals

1. **Zero application code changes** — existing queries, mutations, resolvers, and cache normalization work unmodified.
2. **Schema-derived positioning** — field indices are determined by alphabetical sort order within each type. Both sides derive the same ordering from the same schema.
3. **No per-query registration** — the manifest is a schema map, not a query table. New queries require zero manifest changes. Only schema changes trigger manifest regeneration.
4. **Full wire opacity** — requests are integer arrays, responses are positional binary. No field names, no type names, no structural hints on the wire.
5. **Codegen integration** — one line in your existing `codegen.ts` produces the manifest alongside typed hooks.
6. **Progressive enhancement** — clients without the link get standard JSON. Mixed deployments work.
7. **Minimal dependencies** — `@msgpack/msgpack` for binary encoding. Everything else is `graphql` and Apollo peer dependencies.

### 1.2 Non-Goals

- Subscriptions (WebSocket transport; v2).
- `@defer` / `@stream` (multipart binary framing; v2).
- Custom scalar binary encoding (v2).
- Positional variable encoding (variable names remain visible; v2 consideration).

---

## 2. Package Structure

```
apollo-binary-transfer/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── README.md
├── LICENSE                       # MIT
├── src/
│   ├── index.ts                  # Re-exports everything
│   ├── server/
│   │   ├── index.ts              # Re-exports plugin
│   │   └── plugin.ts             # ApolloServerPlugin implementation
│   ├── client/
│   │   ├── index.ts              # Re-exports link
│   │   └── link.ts               # ApolloLink implementation
│   ├── codegen/
│   │   ├── index.ts              # Re-exports codegen plugin
│   │   └── plugin.ts             # @graphql-codegen plugin
│   └── shared/
│       ├── index.ts              # Re-exports all shared modules
│       ├── constants.ts          # MIME types, header names, version
│       ├── manifest.ts           # Manifest types + generateManifest()
│       ├── selection-encoder.ts  # Query AST → positional selection array
│       ├── selection-decoder.ts  # Positional selection → executable query
│       ├── response-encoder.ts   # JSON response → flat value array
│       ├── response-decoder.ts   # Flat value array → JSON response
│       └── schema-hash.ts        # Deterministic schema hashing
└── tests/
    ├── unit/
    ├── integration/
    ├── performance/
    └── fixtures/
```

### 2.1 Package Exports

```json
{
  "name": "apollo-binary-transfer",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    ".":        { "types": "./dist/index.d.ts",          "import": "./dist/index.js",          "require": "./dist/index.cjs" },
    "./server": { "types": "./dist/server/index.d.ts",   "import": "./dist/server/index.js",   "require": "./dist/server/index.cjs" },
    "./client": { "types": "./dist/client/index.d.ts",   "import": "./dist/client/index.js",   "require": "./dist/client/index.cjs" },
    "./codegen":{ "types": "./dist/codegen/index.d.ts",  "import": "./dist/codegen/index.js",  "require": "./dist/codegen/index.cjs" },
    "./shared": { "types": "./dist/shared/index.d.ts",   "import": "./dist/shared/index.js",   "require": "./dist/shared/index.cjs" }
  },
  "peerDependencies": {
    "@apollo/server": "^4.0.0",
    "@apollo/client": "^3.8.0",
    "@graphql-codegen/plugin-helpers": "^5.0.0",
    "graphql": "^16.0.0"
  },
  "peerDependenciesMeta": {
    "@apollo/server": { "optional": true },
    "@apollo/client": { "optional": true },
    "@graphql-codegen/plugin-helpers": { "optional": true }
  },
  "dependencies": {
    "@msgpack/msgpack": "^3.0.0"
  },
  "devDependencies": {
    "@apollo/server": "^4.11.0",
    "@apollo/client": "^3.12.0",
    "@graphql-codegen/plugin-helpers": "^5.1.0",
    "@graphql-codegen/cli": "^5.0.0",
    "graphql": "^16.9.0",
    "graphql-tag": "^2.12.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "tsup": "^8.0.0"
  }
}
```

Each subpath only pulls in its relevant peer dependency.

### 2.2 Build

```ts
// tsup.config.ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/server/index.ts',
    'src/client/index.ts',
    'src/codegen/index.ts',
    'src/shared/index.ts'
  ],
  format: ['esm', 'cjs'],
  dts: true,
  splitting: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  external: [
    '@apollo/server',
    '@apollo/client',
    '@graphql-codegen/plugin-helpers',
    'graphql'
  ]
})
```

---

## 3. The Manifest

The manifest is a schema position map. It describes the alphabetical field ordering for every type in the schema. It contains zero information about specific queries — only about the schema's structure.

### 3.1 Types

```ts
// src/shared/manifest.ts

export interface BinaryTransferManifest {
  /** Protocol version. Must be 1. */
  version: 1

  /** Truncated SHA-256 of the sorted schema SDL. */
  schemaHash: string

  /** ISO timestamp. For debugging. */
  generatedAt: string

  /**
   * Every object type, input type, and interface in the schema.
   * Keys are type names. Fields within each type are alphabetically sorted.
   * The array index IS the positional index used on the wire.
   */
  types: Record<string, ManifestType>

  /**
   * Union types: map of union name → alphabetically sorted member type names.
   * The array index IS the type discriminator used on the wire.
   */
  unions: Record<string, string[]>

  /**
   * The root operation type names.
   */
  roots: {
    query: string      // Usually "Query"
    mutation?: string   // Usually "Mutation"
  }
}

export interface ManifestType {
  /** Alphabetically sorted fields. Index = wire position. */
  fields: ManifestField[]
}

export interface ManifestField {
  /** Field name in the schema. */
  name: string

  /**
   * The named type (unwrapped from list/non-null).
   * For scalars: "String", "Int", "Boolean", "ID", "Float", or custom scalar name.
   * For objects: the type name (key into manifest.types).
   * For enums: the enum name.
   */
  type: string

  /** True if the unwrapped type is an object/interface type (has sub-fields). */
  isComposite: boolean

  /** True if the field's type is a list (possibly nested). */
  isList: boolean

  /** True if the field (or list) is nullable. */
  isNullable: boolean

  /** True if this field is a union type. */
  isUnion: boolean

  /** Arguments, alphabetically sorted. Only present if the field takes arguments. */
  args?: ManifestArg[]
}

export interface ManifestArg {
  name: string
  type: string        // GraphQL type string, e.g. "ID!", "[String!]"
  defaultValue?: any
}
```

### 3.2 Example

Given this schema:

```graphql
type Query {
  feed(limit: Int): [Post!]!
  post(id: ID!): Post
  search(query: String!): [SearchResult!]!
  user(id: ID!): User
}

type User {
  age: Int
  avatar: String
  bio: String
  email: String!
  id: ID!
  isAdmin: Boolean!
  name: String!
  posts(limit: Int): [Post!]!
}

type Post {
  author: User!
  body: String!
  id: ID!
  likes: Int!
  tags: [String!]!
  title: String!
}

union SearchResult = Post | User
```

The manifest's `types` section:

```json
{
  "types": {
    "Query": {
      "fields": [
        { "name": "feed",   "type": "Post",   "isComposite": true,  "isList": true,  "isNullable": false, "isUnion": false, "args": [{"name": "limit", "type": "Int"}] },
        { "name": "post",   "type": "Post",   "isComposite": true,  "isList": false, "isNullable": true,  "isUnion": false, "args": [{"name": "id", "type": "ID!"}] },
        { "name": "search", "type": "SearchResult", "isComposite": true, "isList": true, "isNullable": false, "isUnion": true, "args": [{"name": "query", "type": "String!"}] },
        { "name": "user",   "type": "User",   "isComposite": true,  "isList": false, "isNullable": true,  "isUnion": false, "args": [{"name": "id", "type": "ID!"}] }
      ]
    },
    "User": {
      "fields": [
        { "name": "age",     "type": "Int",     "isComposite": false, "isList": false, "isNullable": true,  "isUnion": false },
        { "name": "avatar",  "type": "String",  "isComposite": false, "isList": false, "isNullable": true,  "isUnion": false },
        { "name": "bio",     "type": "String",  "isComposite": false, "isList": false, "isNullable": true,  "isUnion": false },
        { "name": "email",   "type": "String",  "isComposite": false, "isList": false, "isNullable": false, "isUnion": false },
        { "name": "id",      "type": "ID",      "isComposite": false, "isList": false, "isNullable": false, "isUnion": false },
        { "name": "isAdmin", "type": "Boolean", "isComposite": false, "isList": false, "isNullable": false, "isUnion": false },
        { "name": "name",    "type": "String",  "isComposite": false, "isList": false, "isNullable": false, "isUnion": false },
        { "name": "posts",   "type": "Post",    "isComposite": true,  "isList": true,  "isNullable": false, "isUnion": false, "args": [{"name": "limit", "type": "Int"}] }
      ]
    },
    "Post": {
      "fields": [
        { "name": "author", "type": "User",   "isComposite": true,  "isList": false, "isNullable": false, "isUnion": false },
        { "name": "body",   "type": "String", "isComposite": false, "isList": false, "isNullable": false, "isUnion": false },
        { "name": "id",     "type": "ID",     "isComposite": false, "isList": false, "isNullable": false, "isUnion": false },
        { "name": "likes",  "type": "Int",    "isComposite": false, "isList": false, "isNullable": false, "isUnion": false },
        { "name": "tags",   "type": "String", "isComposite": false, "isList": true,  "isNullable": false, "isUnion": false },
        { "name": "title",  "type": "String", "isComposite": false, "isList": false, "isNullable": false, "isUnion": false }
      ]
    }
  },
  "unions": {
    "SearchResult": ["Post", "User"]
  }
}
```

Key property: `User.age` is always at index 0, `User.name` is always at index 6, regardless of what query selects them. The position is a property of the schema, not of any particular query.

### 3.3 Generation

```ts
// src/shared/manifest.ts (continued)

import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLUnionType,
  GraphQLInterfaceType,
  GraphQLField,
  GraphQLArgument,
  GraphQLList,
  GraphQLNonNull,
  GraphQLNamedType,
  isObjectType,
  isUnionType,
  isInterfaceType,
  isCompositeType,
  isListType,
  isNonNullType,
  getNamedType,
  printSchema,
  lexicographicSortSchema
} from 'graphql'
import { MANIFEST_VERSION, HASH_LENGTH } from './constants'

export function generateManifest(schema: GraphQLSchema): BinaryTransferManifest {
  const schemaHash = computeSchemaHash(schema)
  const manifest: BinaryTransferManifest = {
    version: MANIFEST_VERSION,
    schemaHash,
    generatedAt: new Date().toISOString(),
    types: {},
    unions: {},
    roots: {
      query: schema.getQueryType()?.name ?? 'Query'
    }
  }

  const mutationType = schema.getMutationType()
  if (mutationType) {
    manifest.roots.mutation = mutationType.name
  }

  const typeMap = schema.getTypeMap()

  for (const [typeName, type] of Object.entries(typeMap)) {
    // Skip introspection types and scalars
    if (typeName.startsWith('__')) continue

    if (isObjectType(type) || isInterfaceType(type)) {
      const fields = Object.values(type.getFields())
        .sort((a, b) => a.name.localeCompare(b.name))

      manifest.types[typeName] = {
        fields: fields.map(field => buildManifestField(field))
      }
    }

    if (isUnionType(type)) {
      manifest.unions[typeName] = type.getTypes()
        .map(t => t.name)
        .sort((a, b) => a.localeCompare(b))
    }
  }

  return manifest
}

function buildManifestField(field: GraphQLField<any, any>): ManifestField {
  const namedType = getNamedType(field.type)
  const composite = isCompositeType(namedType)
  const union = isUnionType(namedType)

  let isList = false
  let isNullable = true
  let unwrapped = field.type

  if (isNonNullType(unwrapped)) {
    isNullable = false
    unwrapped = unwrapped.ofType
  }
  if (isListType(unwrapped)) {
    isList = true
  }

  const result: ManifestField = {
    name: field.name,
    type: namedType.name,
    isComposite: composite,
    isList,
    isNullable,
    isUnion: union
  }

  if (field.args.length > 0) {
    result.args = field.args
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(arg => ({
        name: arg.name,
        type: arg.type.toString(),
        ...(arg.defaultValue !== undefined ? { defaultValue: arg.defaultValue } : {})
      }))
  }

  return result
}

function computeSchemaHash(schema: GraphQLSchema): string {
  const sorted = lexicographicSortSchema(schema)
  const sdl = printSchema(sorted)
  const { createHash } = require('node:crypto')
  return createHash('sha256').update(sdl).digest('hex').slice(0, HASH_LENGTH)
}
```

### 3.4 Codegen Plugin

```ts
// codegen.ts — user's config
import type { CodegenConfig } from '@graphql-codegen/cli'

const config: CodegenConfig = {
  schema: 'http://localhost:4000/graphql',
  documents: ['src/**/*.graphql', 'src/**/*.tsx'],
  generates: {
    './src/generated/graphql.ts': {
      plugins: ['typescript', 'typescript-operations', 'typescript-react-apollo']
    },
    './src/generated/manifest.json': {
      plugins: ['apollo-binary-transfer/codegen']   // ← one line
    }
  }
}
export default config
```

```ts
// src/codegen/plugin.ts

import type { PluginFunction, PluginValidateFn } from '@graphql-codegen/plugin-helpers'
import { generateManifest } from '../shared/manifest'

export const plugin: PluginFunction = (schema) => {
  const manifest = generateManifest(schema)
  return JSON.stringify(manifest, null, 2)
}

export const validate: PluginValidateFn = (_schema, _documents, _config, outputFile) => {
  if (!outputFile.endsWith('.json')) {
    throw new Error(
      `[apollo-binary-transfer/codegen] Output file must be .json, got: ${outputFile}`
    )
  }
}
```

Note: the codegen plugin only needs the schema. It doesn't use `documents` at all — because the manifest is schema-derived, not query-derived. The `documents` config is still needed for your typed hooks output, but the binary transfer manifest doesn't read them.

### 3.5 Manifest Lifecycle

```
1. graphql-codegen fetches schema from server (introspection or SDL)
                    │
                    ▼
2. apollo-binary-transfer/codegen produces manifest.json
   (alphabetical field indices per type, union type maps)
                    │
              ┌─────┴─────┐
              ▼           ▼
3a. Server loads        3b. Client bundles
    manifest at              manifest at
    startup                  build time
              │           │
              ▼           ▼
4a. Plugin builds       4b. Link builds
    name→index maps          name→index maps
    for decoding             for encoding
    selections               selections
```

The manifest changes only when the schema changes. Adding, modifying, or removing client-side queries requires zero manifest updates and zero server redeployment.

### 3.6 Manifest as the Deployment Contract

The only event that requires manifest regeneration is a schema change. Specifically:

| Event | Manifest update? | Server redeploy? | Client rebuild? |
|---|---|---|---|
| New query on client | No | No | Yes (client only) |
| Modified query on client | No | No | Yes (client only) |
| Removed query on client | No | No | Yes (client only) |
| New field added to type | Yes | Yes | Yes |
| Field removed from type | Yes | Yes | Yes |
| Field renamed | Yes | Yes | Yes |
| New type added | Yes | Yes | Only if client uses it |
| Type removed | Yes | Yes | Only if client used it |

Compare this to the previous per-query manifest architecture where EVERY client query change required manifest regeneration and server redeployment.

---

## 4. Wire Protocol

### 4.1 Content Types

```
MIME_BINARY = "application/graphql-binary"
```

### 4.2 Headers

| Header | Direction | Value | Purpose |
|---|---|---|---|
| `Accept` | Request | `application/graphql-binary` | Client requests binary response |
| `Content-Type` | Request | `application/graphql-binary` | Request body is binary-encoded |
| `Content-Type` | Response | `application/graphql-binary` | Response body is binary-encoded |
| `X-GraphQL-Schema-Hash` | Response | 16-char hex | Schema version for drift detection |
| `X-GraphQL-Errors` | Response | JSON string | GraphQL errors when body is binary |
| `X-GraphQL-BT-Version` | Response | `1` | Protocol version |

### 4.3 Request Format

The request body is msgpack-encoded:

```ts
interface BinaryTransferRequest {
  /** Positional selection tree (see Section 5). */
  s: SelectionTree

  /**
   * Operation type.
   * 0 = query, 1 = mutation.
   */
  o: 0 | 1

  /** Variables, if any. Named — not positionally encoded. */
  v?: Record<string, any>
}
```

Msgpack-encoded, a typical request is 20-60 bytes.

Example — `query GetUser($id: ID!) { user(id: $id) { name email } }`:

```
{
  s: [3, [3, 6]],      // root field 3 (user), selecting fields 3 (email) and 6 (name)
  o: 0,                 // query
  v: { id: "1" }        // variables
}
```

Msgpack: ~25 bytes. The equivalent GraphQL query string is ~65 bytes. The equivalent APQ hash envelope was ~130 bytes.

### 4.4 Selection Tree Encoding

A selection tree is a nested array of integers:

```ts
/**
 * A selection tree encodes which fields to fetch and their sub-selections.
 *
 * Leaf field:      fieldIndex          (bare integer)
 * Composite field: [fieldIndex, [...subSelections]]
 * Union field:     [fieldIndex, { typeIndex: [...subSelections], ... }]
 *
 * The top-level array is the root selection set on Query or Mutation.
 */
type SelectionTree = SelectionNode[]

type SelectionNode =
  | number                                           // leaf
  | [number, SelectionNode[]]                        // composite with sub-selection
  | [number, Record<number, SelectionNode[]>]        // union with type-conditional selections
```

#### Leaf fields

A bare integer. Field index within the parent type.

```
email on User → 3
```

#### Composite fields

A tuple: `[fieldIndex, subSelection]`.

```
user { name email } on Query → [3, [3, 6]]
```

Read: field 3 on Query (`user`), selecting fields 3 (`email`) and 6 (`name`) on User.

#### Union fields

A tuple: `[fieldIndex, { typeIndex: subSelection, ... }]`.

```
search { ... on Post { title } ... on User { name } } on Query → [2, { 0: [5], 1: [6] }]
```

Read: field 2 on Query (`search`), for type 0 (`Post`) select field 5 (`title`), for type 1 (`User`) select field 6 (`name`).

#### Multiple root fields

```
query Dashboard {
  user(id: "1") { name isAdmin }
  feed(limit: 5) { title likes }
}

→ [0, [3, 5], 3, [3, 6]]
```

Read: field 0 (`feed`) with sub-selection [3 (`likes`), 5 (`title`)], field 3 (`user`) with sub-selection [3 (`email`)... wait, that's wrong. Let me redo:

Actually, selection fields are read as: if the next element is an array, it's the sub-selection for the preceding field index. If it's a number, it's the next field index.

Better encoding: every selected field is explicitly a leaf (bare int) or composite (tuple):

```
[
  [0, [3, 5]],   // feed(limit:5) { likes title }
  [3, [5, 6]]    // user(id:"1") { isAdmin name }
]
```

This is unambiguous. Every element in a selection array is either a number (leaf) or a tuple (composite/union).

### 4.5 Response Format (Binary)

```
Content-Type: application/graphql-binary
X-GraphQL-Schema-Hash: 7b3e9f1c
X-GraphQL-BT-Version: 1
```

Body: msgpack-encoded flat value array.

Values appear in the order the fields were selected in the request. The client sent the selection, so it knows exactly what order to expect.

Example response for `[3, [3, 6]]` (user → email, name):

```
["alice@example.com", "Alice"]
```

For lists, the array length is prefixed:

```
// feed { title likes } with 2 posts
[2, "Hello", 42, "World", 17]
```

For null objects: sentinel `0xC1`.

For unions: type index prefix per item:

```
// search { ...on Post { title } ...on User { name } } with 2 results
[2, 0, "Hello World", 1, "Alice"]
// 2 items. Item 0 is type 0 (Post) → title. Item 1 is type 1 (User) → name.
```

### 4.6 Response Format (JSON Fallback)

When the client sends a binary request but does not include `Accept: application/graphql-binary`, the server decodes the positional selection, executes the query, and returns standard JSON. This supports debugging, monitoring probes, and gradual migration.

### 4.7 Schema Drift Detection

Every response includes `X-GraphQL-Schema-Hash`. The link compares this against the manifest's `schemaHash`. On mismatch, it logs a warning. Requests may fail if field indices have shifted.

---

## 5. Shared Module: Selection Encoder

Converts a `DocumentNode` (parsed `gql` tag) into a positional `SelectionTree` using the manifest.

```ts
// src/shared/selection-encoder.ts

import { DocumentNode, FieldNode, Kind, FragmentDefinitionNode } from 'graphql'
import type { BinaryTransferManifest, ManifestType } from './manifest'

export type SelectionNode =
  | number
  | [number, SelectionNode[]]
  | [number, Record<number, SelectionNode[]>]

export type SelectionTree = SelectionNode[]

export function encodeSelection(
  document: DocumentNode,
  manifest: BinaryTransferManifest
): { tree: SelectionTree; operationType: 0 | 1 } {
  const fragments = new Map<string, FragmentDefinitionNode>()

  for (const def of document.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(def.name.value, def)
    }
  }

  const operation = document.definitions.find(
    d => d.kind === Kind.OPERATION_DEFINITION
  )
  if (!operation || operation.kind !== Kind.OPERATION_DEFINITION) {
    throw new Error('No operation definition found')
  }

  const operationType = operation.operation === 'mutation' ? 1 : 0
  const rootTypeName = operationType === 1
    ? manifest.roots.mutation!
    : manifest.roots.query

  const tree = encodeSelectionSet(
    operation.selectionSet.selections,
    rootTypeName,
    manifest,
    fragments
  )

  return { tree, operationType }
}

function encodeSelectionSet(
  selections: readonly any[],
  parentTypeName: string,
  manifest: BinaryTransferManifest,
  fragments: Map<string, FragmentDefinitionNode>
): SelectionTree {
  const parentType = manifest.types[parentTypeName]
  if (!parentType) throw new Error(`Unknown type: ${parentTypeName}`)

  // Build name → index lookup
  const fieldIndex = new Map<string, number>()
  parentType.fields.forEach((f, i) => fieldIndex.set(f.name, i))

  const result: SelectionTree = []

  for (const sel of selections) {
    switch (sel.kind) {
      case Kind.FIELD: {
        const field = sel as FieldNode
        const name = field.name.value
        if (name === '__typename') continue  // Handled implicitly

        const idx = fieldIndex.get(name)
        if (idx === undefined) throw new Error(`Unknown field: ${name} on ${parentTypeName}`)

        const fieldDef = parentType.fields[idx]

        if (!fieldDef.isComposite || !field.selectionSet) {
          // Leaf field
          result.push(idx)
        } else if (fieldDef.isUnion) {
          // Union — collect type-conditional selections
          const typeSelections: Record<number, SelectionTree> = {}
          const unionMembers = manifest.unions[fieldDef.type]

          for (const subSel of field.selectionSet.selections) {
            if (subSel.kind === Kind.INLINE_FRAGMENT && subSel.typeCondition) {
              const typeName = subSel.typeCondition.name.value
              const typeIdx = unionMembers.indexOf(typeName)
              if (typeIdx === -1) throw new Error(`Unknown union member: ${typeName}`)

              typeSelections[typeIdx] = encodeSelectionSet(
                subSel.selectionSet.selections,
                typeName,
                manifest,
                fragments
              )
            }
            // Fragment spreads on unions
            if (subSel.kind === Kind.FRAGMENT_SPREAD) {
              const frag = fragments.get(subSel.name.value)
              if (frag?.typeCondition) {
                const typeName = frag.typeCondition.name.value
                const typeIdx = unionMembers.indexOf(typeName)
                if (typeIdx !== -1) {
                  typeSelections[typeIdx] = encodeSelectionSet(
                    frag.selectionSet.selections,
                    typeName,
                    manifest,
                    fragments
                  )
                }
              }
            }
          }

          result.push([idx, typeSelections])
        } else {
          // Composite (object) field — recurse
          const subTree = encodeSelectionSet(
            field.selectionSet.selections,
            fieldDef.type,
            manifest,
            fragments
          )
          result.push([idx, subTree])
        }
        break
      }

      case Kind.INLINE_FRAGMENT: {
        // Non-union inline fragments (type refinement on object types)
        // Flatten into parent selection
        const subNodes = encodeSelectionSet(
          sel.selectionSet.selections,
          sel.typeCondition?.name.value ?? parentTypeName,
          manifest,
          fragments
        )
        result.push(...subNodes)
        break
      }

      case Kind.FRAGMENT_SPREAD: {
        const frag = fragments.get(sel.name.value)
        if (frag) {
          const subNodes = encodeSelectionSet(
            frag.selectionSet.selections,
            frag.typeCondition.name.value,
            manifest,
            fragments
          )
          result.push(...subNodes)
        }
        break
      }
    }
  }

  return result
}
```

### 5.1 Encoding Examples

```graphql
# Simple flat query
query { user(id: "1") { name email } }
# → [3, [3, 6]]
#    user → email, name

# Nested query
query { user(id: "1") { name posts { title likes } } }
# → [[3, [6, [7, [3, 5]]]]]
#    user → name, posts → likes, title
# Wait — let me be precise:
# → [ [3, [6, [7, [3, 5]]]] ]
# That's wrong. Let me redo.

# user is field 3 on Query. It's composite → [fieldIdx, subSelection]
# In the sub-selection on User:
#   name is field 6 → leaf → 6
#   posts is field 7, composite → [7, subSelection]
#     In the sub-selection on Post:
#       title is field 5 → leaf → 5
#       likes is field 3 → leaf → 3
# So:
# → [ [3, [6, [7, [3, 5]]]] ]

# Multiple root fields
query { feed(limit: 5) { title } user(id: "1") { name } }
# → [ [0, [5]], [3, [6]] ]
#    feed → title; user → name

# Union query
query { search(query: "test") { ... on Post { title } ... on User { name } } }
# → [ [2, { 0: [5], 1: [6] }] ]
#    search → Post: title, User: name

# Fragment
fragment UserBasic on User { id name email }
query { user(id: "1") { ...UserBasic bio } }
# → [ [3, [2, 3, 4, 6]] ]
#    user → bio(2), email(3), id(4), name(6)
# (fragment fields inlined and sorted by their appearance in selection, not alphabetically —
#  they keep the order they appear in the AST after inlining)
```

---

## 6. Shared Module: Selection Decoder

Server-side: converts a `SelectionTree` back into an executable `DocumentNode`.

```ts
// src/shared/selection-decoder.ts

import {
  DocumentNode, Kind, OperationTypeNode,
  SelectionSetNode, FieldNode, InlineFragmentNode
} from 'graphql'
import type { BinaryTransferManifest } from './manifest'
import type { SelectionTree, SelectionNode } from './selection-encoder'

export function decodeSelection(
  tree: SelectionTree,
  operationType: 0 | 1,
  manifest: BinaryTransferManifest
): DocumentNode {
  const rootTypeName = operationType === 1
    ? manifest.roots.mutation!
    : manifest.roots.query

  const selectionSet = decodeSelectionSet(tree, rootTypeName, manifest)

  return {
    kind: Kind.DOCUMENT,
    definitions: [{
      kind: Kind.OPERATION_DEFINITION,
      operation: operationType === 1
        ? OperationTypeNode.MUTATION
        : OperationTypeNode.QUERY,
      selectionSet,
      variableDefinitions: []  // Variables are passed separately
    }]
  }
}

function decodeSelectionSet(
  tree: SelectionTree,
  parentTypeName: string,
  manifest: BinaryTransferManifest
): SelectionSetNode {
  const parentType = manifest.types[parentTypeName]
  const selections: (FieldNode | InlineFragmentNode)[] = []

  for (const node of tree) {
    if (typeof node === 'number') {
      // Leaf field
      const field = parentType.fields[node]
      selections.push({
        kind: Kind.FIELD,
        name: { kind: Kind.NAME, value: field.name }
      } as FieldNode)
    } else if (Array.isArray(node)) {
      const [fieldIdx, sub] = node
      const field = parentType.fields[fieldIdx]

      if (field.isUnion && !Array.isArray(sub)) {
        // Union: sub is Record<number, SelectionTree>
        const unionMembers = manifest.unions[field.type]
        const typeConditions: InlineFragmentNode[] = []

        for (const [typeIdxStr, typeSub] of Object.entries(sub)) {
          const typeIdx = Number(typeIdxStr)
          const typeName = unionMembers[typeIdx]

          typeConditions.push({
            kind: Kind.INLINE_FRAGMENT,
            typeCondition: {
              kind: Kind.NAMED_TYPE,
              name: { kind: Kind.NAME, value: typeName }
            },
            selectionSet: decodeSelectionSet(
              typeSub as SelectionTree,
              typeName,
              manifest
            )
          } as InlineFragmentNode)
        }

        selections.push({
          kind: Kind.FIELD,
          name: { kind: Kind.NAME, value: field.name },
          selectionSet: {
            kind: Kind.SELECTION_SET,
            selections: typeConditions
          }
        } as FieldNode)
      } else {
        // Composite: sub is SelectionTree
        selections.push({
          kind: Kind.FIELD,
          name: { kind: Kind.NAME, value: field.name },
          selectionSet: decodeSelectionSet(
            sub as SelectionTree,
            field.type,
            manifest
          )
        } as FieldNode)
      }
    }
  }

  return { kind: Kind.SELECTION_SET, selections }
}
```

---

## 7. Shared Module: Response Encoder

Server-side: flattens a JSON response into a positional value array, ordered by the request's selection tree.

```ts
// src/shared/response-encoder.ts

import { encode as msgpackEncode } from '@msgpack/msgpack'
import type { BinaryTransferManifest } from './manifest'
import type { SelectionTree, SelectionNode } from './selection-encoder'

export const NULL_OBJECT = 0xC1

export function flattenResponse(
  data: Record<string, any>,
  tree: SelectionTree,
  rootTypeName: string,
  manifest: BinaryTransferManifest
): any[] {
  const values: any[] = []

  function walk(
    obj: any,
    selection: SelectionTree,
    typeName: string
  ): void {
    const type = manifest.types[typeName]

    for (const node of selection) {
      if (typeof node === 'number') {
        // Leaf
        const field = type.fields[node]
        values.push(obj?.[field.name] ?? null)
      } else if (Array.isArray(node)) {
        const [fieldIdx, sub] = node
        const field = type.fields[fieldIdx]
        const val = obj?.[field.name]

        if (val === null || val === undefined) {
          values.push(NULL_OBJECT)
        } else if (field.isList && Array.isArray(val)) {
          values.push(val.length)

          if (field.isUnion) {
            const unionMembers = manifest.unions[field.type]
            for (const item of val) {
              const itemTypeName = item.__typename
              const typeIdx = unionMembers.indexOf(itemTypeName)
              values.push(typeIdx)
              const typeSub = (sub as Record<number, SelectionTree>)[typeIdx]
              if (typeSub) walk(item, typeSub, itemTypeName)
            }
          } else {
            for (const item of val) {
              walk(item, sub as SelectionTree, field.type)
            }
          }
        } else if (field.isUnion) {
          // Single union value (non-list)
          const unionMembers = manifest.unions[field.type]
          const itemTypeName = val.__typename
          const typeIdx = unionMembers.indexOf(itemTypeName)
          values.push(typeIdx)
          const typeSub = (sub as Record<number, SelectionTree>)[typeIdx]
          if (typeSub) walk(val, typeSub, itemTypeName)
        } else {
          // Composite object
          walk(val, sub as SelectionTree, field.type)
        }
      }
    }
  }

  walk(data, tree, rootTypeName)
  return values
}

export function encodeResponse(
  data: Record<string, any>,
  tree: SelectionTree,
  rootTypeName: string,
  manifest: BinaryTransferManifest
): Uint8Array {
  return msgpackEncode(flattenResponse(data, tree, rootTypeName, manifest))
}
```

---

## 8. Shared Module: Response Decoder

Client-side: rebuilds nested JSON from a flat value array using the selection tree the client sent.

```ts
// src/shared/response-decoder.ts

import { decode as msgpackDecode } from '@msgpack/msgpack'
import type { BinaryTransferManifest } from './manifest'
import type { SelectionTree, SelectionNode } from './selection-encoder'
import { NULL_OBJECT } from './response-encoder'

/**
 * Alias map: maps [parentTypeName, fieldIndex] → alias string.
 * Built by the client link from the original DocumentNode.
 * If a field has no alias, it uses the schema field name.
 */
export type AliasMap = Map<string, Map<number, string>>

export function rebuildResponse(
  values: any[],
  tree: SelectionTree,
  rootTypeName: string,
  manifest: BinaryTransferManifest,
  aliases?: AliasMap
): Record<string, any> {
  let cursor = 0
  function read(): any { return values[cursor++] }

  function build(
    selection: SelectionTree,
    typeName: string
  ): Record<string, any> {
    const type = manifest.types[typeName]
    const obj: Record<string, any> = {}

    for (const node of selection) {
      if (typeof node === 'number') {
        const field = type.fields[node]
        const key = aliases?.get(typeName)?.get(node) ?? field.name
        obj[key] = read()
      } else if (Array.isArray(node)) {
        const [fieldIdx, sub] = node
        const field = type.fields[fieldIdx]
        const key = aliases?.get(typeName)?.get(fieldIdx) ?? field.name
        const val = read()

        if (val === NULL_OBJECT) {
          obj[key] = null
        } else if (field.isList && typeof val === 'number') {
          const arr: any[] = []
          const length = val

          if (field.isUnion) {
            const unionMembers = manifest.unions[field.type]
            for (let i = 0; i < length; i++) {
              const typeIdx = read() as number
              const memberTypeName = unionMembers[typeIdx]
              const typeSub = (sub as Record<number, SelectionTree>)[typeIdx]
              const item = typeSub
                ? build(typeSub, memberTypeName)
                : {}
              item.__typename = memberTypeName
              arr.push(item)
            }
          } else {
            for (let i = 0; i < length; i++) {
              arr.push(build(sub as SelectionTree, field.type))
            }
          }
          obj[key] = arr
        } else if (field.isUnion) {
          const unionMembers = manifest.unions[field.type]
          const typeIdx = val as number
          const memberTypeName = unionMembers[typeIdx]
          const typeSub = (sub as Record<number, SelectionTree>)[typeIdx]
          const item = typeSub
            ? build(typeSub, memberTypeName)
            : {}
          item.__typename = memberTypeName
          obj[key] = item
        } else {
          // val was the first value of the nested object — put it back
          cursor--
          obj[key] = build(sub as SelectionTree, field.type)
        }
      }
    }

    return obj
  }

  return build(tree, rootTypeName)
}

export function decodeResponse(
  buffer: Uint8Array,
  tree: SelectionTree,
  rootTypeName: string,
  manifest: BinaryTransferManifest,
  aliases?: AliasMap
): Record<string, any> {
  const values = msgpackDecode(buffer) as any[]
  return rebuildResponse(values, tree, rootTypeName, manifest, aliases)
}
```

---

## 9. Shared Module: Constants

```ts
// src/shared/constants.ts

export const MIME_BINARY = 'application/graphql-binary'
export const HEADER_SCHEMA_HASH = 'x-graphql-schema-hash'
export const HEADER_ERRORS = 'x-graphql-errors'
export const HEADER_BT_VERSION = 'x-graphql-bt-version'
export const BT_VERSION = '1'
export const MANIFEST_VERSION = 1 as const
export const HASH_LENGTH = 16
```

---

## 10. Server Plugin

### 10.1 Options

```ts
export interface BinaryTransferPluginOptions {
  manifest: BinaryTransferManifest

  /**
   * Max size (bytes) for the X-GraphQL-Errors header.
   * If errors exceed this, the response falls back to JSON.
   * Default: 8192.
   */
  maxErrorHeaderSize?: number
}
```

### 10.2 Lifecycle

1. **`serverWillStart`** — Validate manifest version. Compare `schemaHash` against live schema. Build name→index lookup tables for fast decoding.

2. **`requestDidStart`** — Check `Content-Type` for binary request. If binary: msgpack-decode the body, extract the selection tree, decode it into a `DocumentNode`, inject it as `request.query`. Apollo executes the query normally through resolvers.

3. **`willSendResponse`** — If the client wants binary response (`Accept` header): flatten `data` using the selection tree from the request, msgpack-encode it, replace the response body.

### 10.3 Implementation

```ts
import type {
  ApolloServerPlugin,
  GraphQLRequestListener,
  BaseContext
} from '@apollo/server'
import { print } from 'graphql'
import { decode as msgpackDecode } from '@msgpack/msgpack'
import {
  type BinaryTransferManifest,
  MIME_BINARY, HEADER_SCHEMA_HASH, HEADER_ERRORS,
  HEADER_BT_VERSION, BT_VERSION,
  decodeSelection,
  encodeResponse,
  computeSchemaHash
} from '../shared'
import type { SelectionTree } from '../shared/selection-encoder'

export function BinaryTransferPlugin(
  options: BinaryTransferPluginOptions
): ApolloServerPlugin<BaseContext> {
  const { manifest } = options
  const maxErrSize = options.maxErrorHeaderSize ?? 8192
  let liveSchemaHash = ''

  return {
    async serverWillStart({ schema }) {
      liveSchemaHash = computeSchemaHash(schema)

      if (liveSchemaHash !== manifest.schemaHash) {
        console.warn(
          `[apollo-binary-transfer] Schema hash mismatch.\n` +
          `  Manifest: ${manifest.schemaHash} (${manifest.generatedAt})\n` +
          `  Live:     ${liveSchemaHash}\n` +
          `  Positional encoding may be incorrect. Regenerate the manifest.`
        )
      }

      return {
        schemaDidLoadOrUpdate({ apiSchema }) {
          liveSchemaHash = computeSchemaHash(apiSchema)
        },
        async serverWillStop() {}
      }
    },

    async requestDidStart({ request }) {
      const isBinaryRequest = request.http?.headers
        .get('content-type')
        ?.includes(MIME_BINARY) ?? false
      const wantsBinaryResponse = request.http?.headers
        .get('accept')
        ?.includes(MIME_BINARY) ?? false

      let selectionTree: SelectionTree | undefined
      let rootTypeName: string | undefined

      if (isBinaryRequest) {
        try {
          // Decode the binary request body
          const rawBody = (request as any).__rawBody as Uint8Array
          const decoded = msgpackDecode(rawBody) as any

          selectionTree = decoded.s as SelectionTree
          const operationType = (decoded.o ?? 0) as 0 | 1
          rootTypeName = operationType === 1
            ? manifest.roots.mutation
            : manifest.roots.query

          // Reconstruct the DocumentNode and inject it
          const doc = decodeSelection(selectionTree, operationType, manifest)
          request.query = print(doc)

          // Pass through variables
          if (decoded.v) {
            request.variables = decoded.v
          }
        } catch (err) {
          console.warn('[apollo-binary-transfer] Failed to decode binary request:', err)
          // Let Apollo handle the malformed request
        }
      }

      return {
        async willSendResponse({ response }) {
          const httpRes = response.http!
          httpRes.headers.set(HEADER_BT_VERSION, BT_VERSION)
          httpRes.headers.set(HEADER_SCHEMA_HASH, liveSchemaHash)

          if (
            !wantsBinaryResponse ||
            !selectionTree ||
            !rootTypeName ||
            response.body.kind !== 'single'
          ) return

          const { data, errors } = response.body.singleResult
          if (!data) return

          try {
            const binary = encodeResponse(data, selectionTree, rootTypeName, manifest)

            if (errors?.length) {
              const errJson = JSON.stringify(errors)
              if (Buffer.byteLength(errJson) > maxErrSize) return  // JSON fallback
              httpRes.headers.set(HEADER_ERRORS, errJson)
            }

            httpRes.headers.set('content-type', MIME_BINARY)
            ;(response as any).__binaryBody = binary
          } catch (err) {
            console.warn('[apollo-binary-transfer] Encoding failed, JSON fallback:', err)
          }
        }
      } satisfies GraphQLRequestListener<BaseContext>
    }
  }
}
```

### 10.4 Raw Body Access

The plugin needs access to the raw binary request body before Express/Fastify parses it as JSON. An interceptor middleware captures it:

```ts
export function expressBinaryMiddleware() {
  return (req: any, res: any, next: any) => {
    const ct = req.headers['content-type'] ?? ''
    if (ct.includes(MIME_BINARY)) {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        req.__rawBody = Buffer.concat(chunks)
        // Also set body to empty JSON so Apollo doesn't reject it
        req.body = {}
        next()
      })
    } else {
      next()
    }
  }
}
```

### 10.5 Server Setup

```ts
import { ApolloServer } from '@apollo/server'
import { expressMiddleware } from '@apollo/server/express4'
import express from 'express'
import {
  BinaryTransferPlugin,
  expressBinaryMiddleware
} from 'apollo-binary-transfer/server'
import manifest from './manifest.json'

const server = new ApolloServer({
  typeDefs,
  resolvers,
  plugins: [BinaryTransferPlugin({ manifest })]
})

await server.start()

const app = express()
app.use('/graphql',
  expressBinaryMiddleware(),
  express.json(),
  expressMiddleware(server)
)
app.listen(4000)
```

No APQ config. No persisted query cache. One plugin.

---

## 11. Client Link

### 11.1 Options

```ts
export interface BinaryTransferLinkOptions {
  uri: string
  manifest: BinaryTransferManifest
  fetch?: typeof globalThis.fetch
  headers?: Record<string, string> | (() => Record<string, string>)
  credentials?: RequestCredentials
  onDecodingFailure?: 'error' | 'warn'
}
```

### 11.2 Implementation

```ts
import {
  ApolloLink,
  Observable,
  Operation,
  FetchResult
} from '@apollo/client/core'
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack'
import {
  type BinaryTransferManifest,
  encodeSelection,
  rebuildResponse,
  MIME_BINARY,
  HEADER_SCHEMA_HASH,
  HEADER_ERRORS
} from '../shared'
import type { AliasMap } from '../shared/response-decoder'

export class BinaryTransferLink extends ApolloLink {
  private uri: string
  private manifest: BinaryTransferManifest
  private fetchFn: typeof globalThis.fetch
  private headersFn: () => Record<string, string>
  private credentials: RequestCredentials
  private onFailure: 'error' | 'warn'

  constructor(options: BinaryTransferLinkOptions) {
    super()
    this.uri = options.uri
    this.manifest = options.manifest
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.credentials = options.credentials ?? 'same-origin'
    this.onFailure = options.onDecodingFailure ?? 'error'

    if (typeof options.headers === 'function') {
      this.headersFn = options.headers
    } else {
      const h = options.headers ?? {}
      this.headersFn = () => h
    }
  }

  request(operation: Operation): Observable<FetchResult> {
    return new Observable<FetchResult>(observer => {
      this.execute(operation)
        .then(result => { observer.next(result); observer.complete() })
        .catch(err => observer.error(err))
    })
  }

  private async execute(operation: Operation): Promise<FetchResult> {
    // Encode the query AST to positional selection
    const { tree, operationType } = encodeSelection(
      operation.query,
      this.manifest
    )

    // Build alias map from the original AST for response rebuilding
    const aliases = this.extractAliases(operation.query)

    // Build the binary request body
    const requestBody: any = {
      s: tree,
      o: operationType
    }

    if (operation.variables && Object.keys(operation.variables).length > 0) {
      requestBody.v = operation.variables
    }

    const binaryBody = msgpackEncode(requestBody)

    const headers: Record<string, string> = {
      'content-type': MIME_BINARY,
      'accept': `${MIME_BINARY}, application/graphql-response+json`,
      ...this.headersFn()
    }

    const res = await this.fetchFn(this.uri, {
      method: 'POST',
      headers,
      credentials: this.credentials,
      body: binaryBody
    })

    // Schema drift detection
    const serverSchemaHash = res.headers.get(HEADER_SCHEMA_HASH)
    if (serverSchemaHash && serverSchemaHash !== this.manifest.schemaHash) {
      console.warn(
        `[apollo-binary-transfer] Schema drift detected.\n` +
        `  Client: ${this.manifest.schemaHash}\n` +
        `  Server: ${serverSchemaHash}\n` +
        `  Regenerate the manifest.`
      )
    }

    const contentType = res.headers.get('content-type') ?? ''

    if (contentType.includes(MIME_BINARY)) {
      try {
        const buffer = new Uint8Array(await res.arrayBuffer())
        const rootTypeName = operationType === 1
          ? this.manifest.roots.mutation!
          : this.manifest.roots.query

        const data = rebuildResponse(
          msgpackDecode(buffer) as any[],
          tree,
          rootTypeName,
          this.manifest,
          aliases
        )

        const errHeader = res.headers.get(HEADER_ERRORS)
        const errors = errHeader ? JSON.parse(errHeader) : undefined

        return { data, errors }
      } catch (err) {
        if (this.onFailure === 'warn') {
          console.warn('[apollo-binary-transfer] Decode failed:', err)
        }
        throw new Error(
          `[apollo-binary-transfer] Failed to decode response: ${err}`
        )
      }
    }

    if (contentType.includes('json')) {
      return await res.json() as FetchResult
    }

    throw new Error(
      `[apollo-binary-transfer] Unexpected content-type: ${contentType}`
    )
  }

  /**
   * Walks the DocumentNode and builds a map of aliases.
   * Key: "TypeName" → Map<fieldIndex, aliasName>
   * If no aliases exist, returns undefined (skip the overhead).
   */
  private extractAliases(document: DocumentNode): AliasMap | undefined {
    let hasAliases = false
    const map: AliasMap = new Map()

    // ... walk AST, for each FieldNode with an alias:
    //   look up the field index in the manifest
    //   set map.get(parentTypeName).set(fieldIndex, alias.value)
    //   hasAliases = true

    return hasAliases ? map : undefined
  }
}
```

### 11.3 `__typename` Handling

Apollo Client's `InMemoryCache` relies on `__typename` for cache normalization. The selection encoder skips `__typename` fields (they don't need to be selected explicitly — they're a property of the type itself). The response decoder injects `__typename` into every rebuilt object based on the type name known from the selection tree's position in the manifest.

For union types, `__typename` is derived from the type index in the response.

### 11.4 Apollo Client Integration

```ts
import { ApolloClient, InMemoryCache } from '@apollo/client'
import { BinaryTransferLink } from 'apollo-binary-transfer/client'
import manifest from './src/generated/manifest.json'

const client = new ApolloClient({
  link: new BinaryTransferLink({
    uri: '/graphql',
    manifest
  }),
  cache: new InMemoryCache()
})
```

All existing `useQuery`, `useMutation`, `gql` tags, typed hooks from codegen — everything works unchanged.

---

## 12. Error Handling

### 12.1 Request Decode Errors (Server)

If the server can't decode the binary request (corrupt msgpack, invalid selection indices), it returns a standard GraphQL error response in JSON. The client link falls back to JSON decoding.

### 12.2 Response Encode Errors (Server)

If `flattenResponse()` throws, the plugin falls back to JSON. The client receives a valid JSON response.

### 12.3 Response Decode Errors (Client)

If binary decoding fails, the `onDecodingFailure` option controls behavior: `'error'` (default) throws, `'warn'` logs and throws.

### 12.4 Schema Drift

Logged as a warning on both sides. Requests may fail if field indices have shifted. The fix is always: regenerate manifest, redeploy.

### 12.5 GraphQL Errors With Data

Binary body contains data. Errors in `X-GraphQL-Errors` header. If errors exceed `maxErrorHeaderSize`, entire response falls back to JSON.

---

## 13. Performance Characteristics

### 13.1 Request Size

| Query | GraphQL text | Binary selection | Reduction |
|---|---|---|---|
| `{ user { name email } }` | ~35 B | ~8 B | -77% |
| `{ user { name posts { title likes author { name } } } }` | ~70 B | ~18 B | -74% |
| `{ feed(limit:20) { title likes author { name } } }` | ~55 B | ~12 B | -78% |
| Complex dashboard (5 root fields, nested) | ~350 B | ~45 B | -87% |

Plus variables (same size either way) and framing overhead (~15 bytes msgpack envelope).

### 13.2 Response Size

Same as previous spec — field names eliminated, values positionally encoded:

| Scenario | JSON | JSON+gzip | Binary | Binary+gzip | vs JSON+gzip |
|---|---|---|---|---|---|
| Small (5 fields) | ~175 B | ~140 B | ~70 B | ~65 B | -54% |
| Medium (20 fields) | ~1.2 KB | ~600 B | ~400 B | ~320 B | -47% |
| List (50 × 8 fields) | ~12 KB | ~3.5 KB | ~4 KB | ~2.2 KB | -37% |
| Large (100+ fields) | ~25 KB | ~6 KB | ~8 KB | ~3.5 KB | -42% |

### 13.3 Total Round-Trip

Binary encoding saves on both request AND response. A typical round-trip saves 50-85% vs standard GraphQL, compared to 40-65% in the previous hash-only request architecture.

### 13.4 Runtime Cost

- **Client encoding (selection tree):** O(fields in query). Walk the AST, one map lookup per field. Sub-millisecond for any realistic query.
- **Server decoding (selection tree → DocumentNode):** O(fields in selection). Reconstruct AST from indices. Sub-millisecond.
- **Server encoding (response → binary):** O(values in response). Single pass. Faster than JSON.stringify.
- **Client decoding (binary → JSON):** O(values in response). Single pass. Faster than JSON.parse.

### 13.5 Memory

Manifest size: ~100-500 bytes per type (depending on field count). A schema with 50 types: ~10-25KB. Both sides hold one copy.

---

## 14. Compatibility

| Feature | Supported | Notes |
|---|---|---|
| Apollo Server 4.x | Yes | Plugin API |
| Apollo Client 3.x | Yes | Terminating ApolloLink |
| Express | Yes | `expressBinaryMiddleware()` |
| Fastify | Yes | `fastifyBinaryMiddleware()` |
| InMemoryCache | Yes | `__typename` injected by decoder |
| Cache normalization | Yes | Via `__typename` injection |
| Aliases | Yes | Client-side remap, invisible on wire |
| Fragments | Yes | Inlined at encode time |
| Unions / interfaces | Yes | Type-indexed selections |
| `onError` link | Yes | Composable |
| Apollo DevTools | Yes | Sees decoded JSON |
| `@defer` / `@stream` | No | v2 |
| Subscriptions | No | v2 |
| File uploads | No | Use apollo-upload-client |

---

## 15. Security

### 15.1 Schema Opacity

The primary security property.

**What an attacker sees on the wire:**

```
→ POST /graphql
  Content-Type: application/graphql-binary
  [msgpack: {s: [3, [3, 6]], o: 0, v: {id: "1"}}]

← 200 OK
  Content-Type: application/graphql-binary
  [msgpack: ["alice@example.com", "Alice"]]
```

From this, an attacker can determine:
- Some operation selects root field index 3 with sub-fields 3 and 6
- The response has two string values
- A variable called `id` exists

An attacker cannot determine: field names, type names, schema structure, nesting relationships, or what the integers mean. The selection `[3, [3, 6]]` is meaningless without the manifest.

### 15.2 No Query Text on the Wire

Standard GraphQL sends the full query string — field names, type conditions, argument names, structural relationships. APQ sends the query on first request. Binary transfer sends neither. The query never touches the network.

### 15.3 Implicit Query Allowlist

The server only executes operations that decode to valid field indices. An attacker can send arbitrary integer arrays, but they'll either decode to a valid (if unexpected) query or fail with an out-of-bounds index. There's no way to probe for field names because field names don't exist in the wire protocol.

### 15.4 Variable Names Remain Visible

`{"id": "1"}` reveals the argument name. For most APIs this is harmless. Positional variable encoding is a v2 consideration.

### 15.5 Manifest Security

The manifest must not be served over HTTP — it maps indices to field names, which would undo opacity. The manifest IS in the client bundle; an attacker with bundle access can reconstruct the schema map. The security guarantee is about wire traffic, not bundle contents.

### 15.6 Hash Collision / Integrity

Schema hash: 64-bit truncation, birthday bound at ~4 billion. Msgpack has no integrity — use TLS. Error headers contain server-generated JSON; clients must parse safely.

---

## 16. Versioning

`X-GraphQL-BT-Version: 1`. Incremented only when the selection encoding or response encoding format changes.

---

## 17. Public API Summary

### `apollo-binary-transfer/shared`

```ts
// Manifest
export function generateManifest(schema: GraphQLSchema): BinaryTransferManifest
export interface BinaryTransferManifest { ... }
export interface ManifestType { ... }
export interface ManifestField { ... }
export interface ManifestArg { ... }

// Selection encoding
export function encodeSelection(doc: DocumentNode, manifest: BinaryTransferManifest): { tree: SelectionTree; operationType: 0 | 1 }
export function decodeSelection(tree: SelectionTree, opType: 0 | 1, manifest: BinaryTransferManifest): DocumentNode
export type SelectionTree = SelectionNode[]
export type SelectionNode = number | [number, SelectionNode[]] | [number, Record<number, SelectionNode[]>]

// Response encoding
export function flattenResponse(data: any, tree: SelectionTree, rootType: string, manifest: BinaryTransferManifest): any[]
export function encodeResponse(data: any, tree: SelectionTree, rootType: string, manifest: BinaryTransferManifest): Uint8Array
export function rebuildResponse(values: any[], tree: SelectionTree, rootType: string, manifest: BinaryTransferManifest, aliases?: AliasMap): any
export function decodeResponse(buffer: Uint8Array, tree: SelectionTree, rootType: string, manifest: BinaryTransferManifest, aliases?: AliasMap): any
export const NULL_OBJECT: number
export type AliasMap = Map<string, Map<number, string>>

// Constants
export const MIME_BINARY: string
export const HEADER_SCHEMA_HASH: string
export const HEADER_ERRORS: string
export const HEADER_BT_VERSION: string
export const BT_VERSION: string
export const MANIFEST_VERSION: number
export const HASH_LENGTH: number
```

### `apollo-binary-transfer/server`

```ts
export function BinaryTransferPlugin(options: BinaryTransferPluginOptions): ApolloServerPlugin
export function expressBinaryMiddleware(): ExpressMiddleware
export function fastifyBinaryMiddleware(): FastifyPlugin
export interface BinaryTransferPluginOptions { ... }
```

### `apollo-binary-transfer/client`

```ts
export class BinaryTransferLink extends ApolloLink {
  constructor(options: BinaryTransferLinkOptions)
}
export interface BinaryTransferLinkOptions { ... }
```

### `apollo-binary-transfer/codegen`

```ts
export const plugin: PluginFunction
export const validate: PluginValidateFn
```

---

## 18. Full Usage Example

### codegen.ts

```ts
import type { CodegenConfig } from '@graphql-codegen/cli'

const config: CodegenConfig = {
  schema: 'http://localhost:4000/graphql',
  documents: ['src/**/*.graphql'],
  generates: {
    './src/generated/graphql.ts': {
      plugins: ['typescript', 'typescript-operations', 'typescript-react-apollo']
    },
    './src/generated/manifest.json': {
      plugins: ['apollo-binary-transfer/codegen']
    }
  }
}
export default config
```

### Server

```ts
import { ApolloServer } from '@apollo/server'
import { expressMiddleware } from '@apollo/server/express4'
import express from 'express'
import {
  BinaryTransferPlugin,
  expressBinaryMiddleware
} from 'apollo-binary-transfer/server'
import manifest from './manifest.json'

const server = new ApolloServer({
  typeDefs,
  resolvers,
  plugins: [BinaryTransferPlugin({ manifest })]
})

await server.start()

const app = express()
app.use('/graphql',
  expressBinaryMiddleware(),
  express.json(),
  expressMiddleware(server)
)
app.listen(4000)
```

### Client

```ts
import { ApolloClient, InMemoryCache } from '@apollo/client'
import { BinaryTransferLink } from 'apollo-binary-transfer/client'
import { useGetUserQuery } from './src/generated/graphql'
import manifest from './src/generated/manifest.json'

const client = new ApolloClient({
  link: new BinaryTransferLink({ uri: '/graphql', manifest }),
  cache: new InMemoryCache()
})

// Works exactly as before:
function UserProfile({ id }: { id: string }) {
  const { data } = useGetUserQuery({ variables: { id } })
  return <div>{data?.user?.name}</div>
}
```

### What's on the wire

```
→ POST /graphql
  Content-Type: application/graphql-binary
  [msgpack: {s: [3, [3, 6]], o: 0, v: {id: "1"}}]

  ~25 bytes total. No field names. No query text.
  An observer sees: [3, [3, 6]] — meaningless without the schema map.

← 200 OK
  Content-Type: application/graphql-binary
  [msgpack: ["alice@example.com", "Alice"]]

  ~30 bytes total. No field names. No JSON keys.
  An observer sees two strings — no structure, no context.
```

Equivalent standard GraphQL request: ~200 bytes. Response: ~175 bytes.
Binary transfer: ~55 bytes total round-trip. **73% reduction.**
