# apollo-binary-transfer — Test Suite Specification

Version: 3.0.0-draft
Companion to: Package Specification v3.0.0-draft

---

## 1. Overview

All tests use Vitest. Three tiers: unit tests for each shared module, integration tests for full plugin + link round-trip, and edge case / regression tests.

### 1.1 Coverage Targets

| Module | Line | Branch | Notes |
|---|---|---|---|
| `shared/manifest.ts` | 100% | 100% | Schema-derived, must be exhaustive |
| `shared/selection-encoder.ts` | 100% | 100% | Core correctness |
| `shared/selection-decoder.ts` | 100% | 100% | Core correctness |
| `shared/response-encoder.ts` | 100% | 100% | Core correctness |
| `shared/response-decoder.ts` | 100% | 100% | Core correctness |
| `shared/schema-hash.ts` | 95%+ | 90%+ | |
| `codegen/plugin.ts` | 95%+ | 90%+ | Thin wrapper over generateManifest |
| `server/plugin.ts` | 90%+ | 85%+ | Some paths require mocked Apollo internals |
| `client/link.ts` | 90%+ | 85%+ | Network-dependent paths mocked |

### 1.2 Test Configuration

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts'],
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 90,
        statements: 90
      }
    },
    testTimeout: 10_000,
    hookTimeout: 10_000
  }
})
```

---

## 2. Test Fixtures

### 2.1 Schema

```ts
// tests/fixtures/schema.ts

export const SCHEMA_SDL = `#graphql
  type Query {
    feed(limit: Int): [Post!]!
    post(id: ID!): Post
    search(query: String!): [SearchResult!]!
    user(id: ID!): User
    users(limit: Int, offset: Int): [User!]!
    viewer: User
  }

  type Mutation {
    createPost(input: CreatePostInput!): Post!
    deletePost(id: ID!): Boolean!
    updateUser(id: ID!, input: UpdateUserInput!): User!
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
    comments: [Comment!]!
    id: ID!
    likes: Int!
    tags: [String!]!
    title: String!
  }

  type Comment {
    author: User!
    createdAt: String!
    id: ID!
    text: String!
  }

  union SearchResult = Post | User

  input CreatePostInput {
    body: String!
    tags: [String!]
    title: String!
  }

  input UpdateUserInput {
    bio: String
    email: String
    name: String
  }
`
```

**Expected alphabetical field indices:**

```
Query:    feed=0, post=1, search=2, user=3, users=4, viewer=5
Mutation: createPost=0, deletePost=1, updateUser=2
User:     age=0, avatar=1, bio=2, email=3, id=4, isAdmin=5, name=6, posts=7
Post:     author=0, body=1, comments=2, id=3, likes=4, tags=5, title=6
Comment:  author=0, createdAt=1, id=2, text=3
SearchResult union: Post=0, User=1
```

These indices are referenced throughout the test suite as the ground truth.

### 2.2 Queries

```ts
// tests/fixtures/queries.ts
import { gql } from 'graphql-tag'

export const GET_USER_SIMPLE = gql`
  query GetUser($id: ID!) {
    user(id: $id) { id name email }
  }
`
// Expected selection: [[3, [3, 4, 6]]]
// user(3) → email(3), id(4), name(6)

export const GET_POST_WITH_AUTHOR = gql`
  query GetPost($id: ID!) {
    post(id: $id) { id title body likes author { id name } }
  }
`
// Expected: [[1, [[0, [4, 6]], 1, 3, 4, 6]]]
// post(1) → author(0) → {id(4), name(6)}, body(1), id(3), likes(4), title(6)

export const GET_FEED = gql`
  query GetFeed($limit: Int) {
    feed(limit: $limit) { id title likes author { name } }
  }
`
// Expected: [[0, [[0, [6]], 3, 4, 6]]]
// feed(0) → author(0) → {name(6)}, id(3), likes(4), title(6)

export const GET_POST_WITH_COMMENTS = gql`
  query GetPostWithComments($id: ID!) {
    post(id: $id) {
      id title
      comments { id text author { id name } createdAt }
    }
  }
`
// Expected: [[1, [[2, [[0, [4, 6]], 1, 2, 3]], 3, 6]]]

export const DASHBOARD = gql`
  query Dashboard {
    viewer { id name isAdmin }
    feed(limit: 5) { id title likes }
  }
`
// Expected: [[0, [3, 4, 6]], [5, [4, 5, 6]]]
// feed(0) → {id(3), likes(4), title(6)}; viewer(5) → {id(4), isAdmin(5), name(6)}

export const GET_USER_ALIASED = gql`
  query GetUserAliased($id: ID!) {
    user(id: $id) { userId: id displayName: name contactEmail: email }
  }
`
// Selection same as GET_USER_SIMPLE: [[3, [3, 4, 6]]]
// Aliases applied client-side during decode

export const GET_USER_WITH_FRAGMENT = gql`
  fragment UserBasic on User { id name email }
  query GetUser($id: ID!) {
    user(id: $id) { ...UserBasic bio }
  }
`
// Expected: [[3, [2, 3, 4, 6]]]
// user(3) → bio(2), email(3), id(4), name(6)
// Fragment fields inlined

export const SEARCH_QUERY = gql`
  query Search($q: String!) {
    search(query: $q) {
      ... on Post { id title }
      ... on User { id name }
    }
  }
`
// Expected: [[2, { 0: [3, 6], 1: [4, 6] }]]
// search(2) → Post(0): {id(3), title(6)}, User(1): {id(4), name(6)}

export const GET_USER_WITH_NULLABLE = gql`
  query GetUser($id: ID!) {
    user(id: $id) { id name bio avatar }
  }
`
// Expected: [[3, [0, 1, 2, 4, 6]]]
// Oops wait: avatar=1, bio=2. So: 1(avatar), 2(bio), 4(id), 6(name)
// Actually: age=0, avatar=1, bio=2. The query selects avatar, bio, id, name.
// Expected: [[3, [1, 2, 4, 6]]]

export const CREATE_POST = gql`
  mutation CreatePost($input: CreatePostInput!) {
    createPost(input: $input) { id title body likes }
  }
`
// Expected selection tree: [[0, [1, 3, 4, 6]]]
// operationType: 1 (mutation)
// createPost(0) → body(1), id(3), likes(4), title(6)

export const GET_FEED_EMPTY = gql`
  query GetFeedEmpty { feed(limit: 0) { id title } }
`
// Expected: [[0, [3, 6]]]

export const GET_POST_TAGS = gql`
  query GetPostTags($id: ID!) {
    post(id: $id) { id title tags }
  }
`
// Expected: [[1, [3, 5, 6]]]
// post(1) → id(3), tags(5), title(6)
```

### 2.3 Response Data

```ts
// tests/fixtures/responses.ts

export const USER_ALICE = {
  __typename: 'User',
  id: '1', name: 'Alice', email: 'alice@example.com',
  bio: 'Software engineer', age: 30, isAdmin: true,
  avatar: 'https://example.com/alice.jpg'
}

export const USER_BOB = {
  __typename: 'User',
  id: '2', name: 'Bob', email: 'bob@example.com',
  bio: null, age: 25, isAdmin: false, avatar: null
}

export const POST_HELLO = {
  __typename: 'Post',
  id: '100', title: 'Hello World', body: 'This is my first post.',
  likes: 42, published: true, tags: ['intro', 'hello'],
  author: USER_ALICE
}

export const POST_GOODBYE = {
  __typename: 'Post',
  id: '101', title: 'Goodbye', body: 'This is my last post.',
  likes: 17, published: false, tags: [], author: USER_BOB
}

export const COMMENT_1 = {
  __typename: 'Comment',
  id: 'c1', text: 'Great post!', author: USER_BOB,
  createdAt: '2025-01-15T10:00:00Z'
}

export const COMMENT_2 = {
  __typename: 'Comment',
  id: 'c2', text: 'Thanks!', author: USER_ALICE,
  createdAt: '2025-01-15T11:00:00Z'
}
```

### 2.4 Shared Test Manifest

```ts
// tests/fixtures/manifest.ts
import { makeExecutableSchema } from '@graphql-tools/schema'
import { generateManifest } from '../../src/shared/manifest'
import { SCHEMA_SDL } from './schema'

export function createTestManifest() {
  const schema = makeExecutableSchema({ typeDefs: SCHEMA_SDL })
  return generateManifest(schema)
}

export const TEST_MANIFEST = createTestManifest()
```

---

## 3. Unit Tests: Manifest Generation

File: `tests/unit/manifest.test.ts`

```
SUITE: generateManifest — structure

  TEST: produces version 1
    EXPECT: manifest.version === 1

  TEST: produces schemaHash
    EXPECT: manifest.schemaHash is 16-char hex string

  TEST: produces generatedAt timestamp
    EXPECT: new Date(manifest.generatedAt) is valid and recent

  TEST: includes roots.query
    EXPECT: manifest.roots.query === "Query"

  TEST: includes roots.mutation
    EXPECT: manifest.roots.mutation === "Mutation"

  TEST: does not include roots.subscription
    EXPECT: manifest.roots.subscription is undefined


SUITE: generateManifest — type mapping

  TEST: includes all object types
    EXPECT: manifest.types has keys: Query, Mutation, User, Post, Comment

  TEST: does not include introspection types
    EXPECT: no key starting with "__"

  TEST: does not include scalar types
    EXPECT: no String, Int, Boolean, ID, Float keys

  TEST: does not include input types
    EXPECT: no CreatePostInput, UpdateUserInput keys

  TEST: includes union types
    EXPECT: manifest.unions.SearchResult exists


SUITE: generateManifest — alphabetical field ordering

  TEST: Query fields sorted alphabetically
    EXPECT: fields[0].name === "feed"
            fields[1].name === "post"
            fields[2].name === "search"
            fields[3].name === "user"
            fields[4].name === "users"
            fields[5].name === "viewer"

  TEST: User fields sorted alphabetically
    EXPECT: fields[0].name === "age"      (index 0)
            fields[1].name === "avatar"   (index 1)
            fields[2].name === "bio"      (index 2)
            fields[3].name === "email"    (index 3)
            fields[4].name === "id"       (index 4)
            fields[5].name === "isAdmin"  (index 5)
            fields[6].name === "name"     (index 6)
            fields[7].name === "posts"    (index 7)

  TEST: Post fields sorted alphabetically
    EXPECT: author=0, body=1, comments=2, id=3, likes=4, tags=5, title=6

  TEST: Comment fields sorted alphabetically
    EXPECT: author=0, createdAt=1, id=2, text=3


SUITE: generateManifest — field metadata

  TEST: scalar field has isComposite=false
    EXPECT: User.fields[6] (name) → isComposite: false

  TEST: object field has isComposite=true
    EXPECT: Post.fields[0] (author) → isComposite: true, type: "User"

  TEST: list field has isList=true
    EXPECT: Query.fields[0] (feed) → isList: true
            User.fields[7] (posts) → isList: true

  TEST: nullable field has isNullable=true
    EXPECT: User.fields[0] (age) → isNullable: true
            User.fields[2] (bio) → isNullable: true

  TEST: non-null field has isNullable=false
    EXPECT: User.fields[3] (email) → isNullable: false
            User.fields[4] (id) → isNullable: false

  TEST: union field has isUnion=true
    EXPECT: Query.fields[2] (search) → isUnion: true, type: "SearchResult"

  TEST: non-union composite field has isUnion=false
    EXPECT: Post.fields[0] (author) → isUnion: false


SUITE: generateManifest — union types

  TEST: union members sorted alphabetically
    EXPECT: manifest.unions.SearchResult === ["Post", "User"]
            Post is index 0, User is index 1


SUITE: generateManifest — arguments

  TEST: field with args includes args array
    EXPECT: Query.fields[3] (user) → args: [{ name: "id", type: "ID!" }]

  TEST: args sorted alphabetically
    EXPECT: Query.fields[4] (users) → args[0].name === "limit", args[1].name === "offset"

  TEST: field without args has no args property
    EXPECT: User.fields[6] (name) → args is undefined

  TEST: default values included when present


SUITE: generateManifest — determinism

  TEST: same schema produces same manifest (excluding generatedAt)
    SETUP: generate twice
    EXPECT: schemaHash matches, types deep-equal, unions deep-equal

  TEST: type definition order in SDL does not affect output
    SETUP: schema with User before Query vs Query before User
    EXPECT: identical manifest (same schemaHash, same field indices)

  TEST: manifest is JSON-serializable
    EXPECT: JSON.parse(JSON.stringify(manifest)) deep-equals manifest


SUITE: generateManifest — schema changes

  TEST: adding a field changes schemaHash
  TEST: removing a field changes schemaHash
  TEST: adding a field shifts subsequent indices
    SETUP: add "badge" to User (between bio and email)
    EXPECT: User.fields[3].name === "badge" (new)
            User.fields[4].name === "email" (was 3)
  TEST: adding a type adds entry to types map
  TEST: removing a type removes entry
```

---

## 4. Unit Tests: Selection Encoder

File: `tests/unit/selection-encoder.test.ts`

```
SUITE: encodeSelection — leaf fields

  TEST: simple flat query
    INPUT:  GET_USER_SIMPLE
    EXPECT: tree = [[3, [3, 4, 6]]], operationType = 0
            (user=3, email=3, id=4, name=6)

  TEST: returns operationType 0 for queries
  TEST: returns operationType 1 for mutations
    INPUT:  CREATE_POST
    EXPECT: operationType = 1


SUITE: encodeSelection — composite fields

  TEST: nested object
    INPUT:  GET_POST_WITH_AUTHOR
    EXPECT: post=1, sub-selects author=0 (composite) → {id=4, name=6}, body=1, id=3, likes=4, title=6

  TEST: deeply nested (3 levels)
    INPUT:  GET_POST_WITH_COMMENTS
    EXPECT: post → comments → author → {id, name}

  TEST: list field
    INPUT:  GET_FEED
    EXPECT: feed=0 (composite), sub-selects with nested author


SUITE: encodeSelection — multiple root fields

  TEST: dashboard with two root fields
    INPUT:  DASHBOARD
    EXPECT: two entries in top-level array: feed and viewer
            both with their sub-selections


SUITE: encodeSelection — aliases

  TEST: aliases do not affect selection tree
    INPUT:  GET_USER_ALIASED
    EXPECT: tree identical to GET_USER_SIMPLE
            (aliases are invisible in the positional encoding)


SUITE: encodeSelection — fragments

  TEST: fragment spread inlines at spread site
    INPUT:  GET_USER_WITH_FRAGMENT
    EXPECT: all fragment fields + direct fields in one flat sub-selection
            bio=2, email=3, id=4, name=6

  TEST: inline fragment on non-union type flattens
    INPUT:  gql`query { user(id: "1") { ... on User { name email } } }`
    EXPECT: same as selecting name and email directly


SUITE: encodeSelection — unions

  TEST: union with inline fragments
    INPUT:  SEARCH_QUERY
    EXPECT: [[2, { 0: [3, 6], 1: [4, 6] }]]
            search=2, Post(0): {id=3, title=6}, User(1): {id=4, name=6}

  TEST: union member type indices match manifest.unions alphabetical order
    EXPECT: Post=0, User=1 (alphabetical)


SUITE: encodeSelection — __typename

  TEST: __typename fields are skipped
    INPUT:  gql`query { user(id: "1") { __typename id name } }`
    EXPECT: tree = [[3, [4, 6]]]
            __typename not in selection (handled implicitly by decoder)


SUITE: encodeSelection — errors

  TEST: unknown field name throws
    INPUT:  query referencing a field not in the schema
    EXPECT: throws Error("Unknown field: ...")

  TEST: unknown type name throws
    EXPECT: throws Error("Unknown type: ...")

  TEST: no operation definition throws
    INPUT:  parse("fragment F on User { id }")
    EXPECT: throws Error("No operation definition found")
```

---

## 5. Unit Tests: Selection Decoder

File: `tests/unit/selection-decoder.test.ts`

Every encoder test has a corresponding round-trip: `encodeSelection` → `decodeSelection` → the decoded `DocumentNode` when printed produces a valid GraphQL query that selects the same fields.

```
SUITE: decodeSelection — round-trip

  For each fixture query:
    TEST: encode → decode → print produces valid query with correct fields
      METHOD: encodeSelection(doc, manifest) → tree
              decodeSelection(tree, opType, manifest) → reconstructedDoc
              print(reconstructedDoc) → queryString
              parse(queryString) and validate against schema
      EXPECT: reconstructed query selects the same fields as original
              (field order may differ; alias names will be absent)

  TEST: simple flat query round-trip
  TEST: nested object round-trip
  TEST: deeply nested round-trip
  TEST: multiple root fields round-trip
  TEST: fragment (inlined) round-trip
  TEST: union round-trip
  TEST: mutation round-trip
  TEST: list field round-trip


SUITE: decodeSelection — direct tests

  TEST: leaf field index → FieldNode with correct name
    INPUT:  tree = [4], typeName = "User"
    EXPECT: single field: { name: "id" }

  TEST: composite field → FieldNode with selectionSet
    INPUT:  tree = [[3, [4, 6]]], typeName = "Query"
    EXPECT: field "user" with selectionSet containing "id" and "name"

  TEST: union field → FieldNode with InlineFragments
    INPUT:  tree = [[2, { 0: [6], 1: [6] }]], typeName = "Query"
    EXPECT: field "search" with inline fragments for Post and User

  TEST: out-of-bounds field index throws
    INPUT:  tree = [99], typeName = "User"
    EXPECT: throws (or returns undefined — decided during implementation)
```

---

## 6. Unit Tests: Response Encoder

File: `tests/unit/response-encoder.test.ts`

```
SUITE: flattenResponse — basics

  TEST: flat object
    DATA:   { user: { id: "1", name: "Alice", email: "alice@example.com" } }
    TREE:   [[3, [3, 4, 6]]]
    ROOT:   "Query"
    EXPECT: ["alice@example.com", "1", "Alice"]
            (email=3 first, then id=4, then name=6 — selection order)

  TEST: nested object
    DATA:   { post: { id: "100", title: "Hello", body: "...", likes: 42,
              author: { id: "1", name: "Alice" } } }
    TREE:   [[1, [[0, [4, 6]], 1, 3, 4, 6]]]
    EXPECT: ["1", "Alice", "...", "100", 42, "Hello"]
            (author.id, author.name, body, id, likes, title)

  TEST: list of objects
    DATA:   { feed: [
              { id: "100", title: "Hello", likes: 42, author: { name: "Alice" } },
              { id: "101", title: "Bye", likes: 17, author: { name: "Bob" } }
            ] }
    TREE:   [[0, [[0, [6]], 3, 4, 6]]]
    EXPECT: [2, "Alice", "100", 42, "Hello", "Bob", "101", 17, "Bye"]
            (length=2, then for each: author.name, id, likes, title)

  TEST: empty list
    DATA:   { feed: [] }
    TREE:   [[0, [3, 6]]]
    EXPECT: [0]

  TEST: null leaf values preserved
    DATA:   { user: { id: "2", name: "Bob", bio: null, avatar: null } }
    TREE:   [[3, [1, 2, 4, 6]]]
    EXPECT: [null, null, "2", "Bob"]

  TEST: null nested object → NULL_OBJECT sentinel (0xC1)
    DATA:   { post: null }
    TREE:   [[1, [3, 6]]]
    EXPECT: [0xC1]

  TEST: multiple root fields
    DATA:   { viewer: { id: "1", name: "Alice", isAdmin: true },
              feed: [{ id: "100", title: "Hello", likes: 42 }] }
    TREE:   [[0, [3, 4, 6]], [5, [4, 5, 6]]]
    EXPECT: [1, "100", 42, "Hello", "1", true, "Alice"]
            (feed length=1, feed item fields, then viewer fields)

  TEST: scalar list field (tags) pushed as-is
    DATA:   { post: { id: "100", title: "Hello", tags: ["intro", "hello"] } }
    TREE:   [[1, [3, 5, 6]]]
    EXPECT: ["100", ["intro", "hello"], "Hello"]

  TEST: boolean false preserved
  TEST: integer zero preserved

  TEST: union field
    DATA:   { search: [
              { __typename: "Post", id: "100", title: "Hello" },
              { __typename: "User", id: "1", name: "Alice" }
            ] }
    TREE:   [[2, { 0: [3, 6], 1: [4, 6] }]]
    EXPECT: [2, 0, "100", "Hello", 1, "1", "Alice"]
            (length=2, type0(Post), Post fields, type1(User), User fields)


SUITE: encodeResponse

  TEST: returns Uint8Array
  TEST: output is valid msgpack that decodes to same array as flattenResponse()
```

---

## 7. Unit Tests: Response Decoder

File: `tests/unit/response-decoder.test.ts`

Every encoder test has a corresponding round-trip.

```
SUITE: rebuildResponse — round-trip

  For each flattenResponse test case:
    TEST: flattenResponse → rebuildResponse produces original data shape
      METHOD: flatten(data, tree, root, manifest) → values
              rebuild(values, tree, root, manifest) → rebuilt
      EXPECT: rebuilt deep-equals the selected subset of data
              (only the fields in the selection, not the full object)

  TEST: flat object round-trip
  TEST: nested object round-trip
  TEST: list round-trip
  TEST: empty list round-trip
  TEST: null leaf round-trip
  TEST: null object (sentinel) round-trip
  TEST: multiple root fields round-trip
  TEST: scalar list field round-trip
  TEST: union round-trip
  TEST: deeply nested round-trip


SUITE: rebuildResponse — aliases

  TEST: aliases applied when AliasMap provided
    VALUES: ["alice@example.com", "1", "Alice"]
    TREE:   [[3, [3, 4, 6]]]
    ALIASES: User: { 3 → "contactEmail", 4 → "userId", 6 → "displayName" }
    EXPECT: { user: { contactEmail: "alice@example.com", userId: "1", displayName: "Alice" } }

  TEST: no AliasMap → field names from manifest
    EXPECT: { user: { email: "alice@example.com", id: "1", name: "Alice" } }


SUITE: rebuildResponse — __typename injection

  TEST: __typename injected for composite objects
    EXPECT: rebuilt objects include __typename derived from manifest type

  TEST: __typename for union members derived from type index
    EXPECT: Post items get __typename: "Post", User items get __typename: "User"


SUITE: decodeResponse

  TEST: accepts output of encodeResponse and produces correct structure
```

---

## 8. Unit Tests: Schema Hash

File: `tests/unit/schema-hash.test.ts`

```
SUITE: computeSchemaHash

  TEST: produces 16-char hex string
  TEST: deterministic — same schema always same hash
  TEST: type definition order in SDL does not affect hash
  TEST: adding a field changes hash
  TEST: removing a field changes hash
  TEST: adding a type changes hash
```

---

## 9. Unit Tests: Codegen Plugin

File: `tests/unit/codegen-plugin.test.ts`

```
SUITE: codegen plugin

  TEST: plugin() returns valid JSON string
    SETUP: call plugin(schema, documents, config)
    EXPECT: JSON.parse(result) is a valid BinaryTransferManifest

  TEST: plugin() ignores documents parameter
    SETUP: call with empty documents array
    EXPECT: still produces valid manifest (schema-only)

  TEST: validate() rejects non-.json output
    SETUP: call validate(..., 'output.ts')
    EXPECT: throws Error containing ".json"

  TEST: validate() accepts .json output
    SETUP: call validate(..., 'output.json')
    EXPECT: no throw
```

---

## 10. Unit Tests: Server Plugin

File: `tests/unit/plugin.test.ts`

### 10.1 Setup

```ts
import { ApolloServer } from '@apollo/server'
import { BinaryTransferPlugin, expressBinaryMiddleware } from '../../src/server/plugin'
import { TEST_MANIFEST } from '../fixtures/manifest'
import { SCHEMA_SDL } from '../fixtures/schema'
import { encodeSelection } from '../../src/shared/selection-encoder'
import { encode as msgpackEncode } from '@msgpack/msgpack'

function createTestServer(pluginOpts = {}) {
  return new ApolloServer({
    typeDefs: SCHEMA_SDL,
    resolvers: fixtureResolvers,
    plugins: [
      BinaryTransferPlugin({ manifest: TEST_MANIFEST, ...pluginOpts })
    ]
  })
}

function buildBinaryRequest(query: DocumentNode, variables?: any) {
  const { tree, operationType } = encodeSelection(query, TEST_MANIFEST)
  const body: any = { s: tree, o: operationType }
  if (variables) body.v = variables
  return msgpackEncode(body)
}
```

### 10.2 Test Cases

```
SUITE: BinaryTransferPlugin — binary request handling

  TEST: binary request decoded and executed
    SETUP:  POST with Content-Type: application/graphql-binary
            body = buildBinaryRequest(GET_USER_SIMPLE, { id: "1" })
            Accept: application/graphql-binary
    EXPECT: response status 200
            Content-Type: application/graphql-binary
            decoded body matches expected user data

  TEST: binary request with JSON response (no Accept binary)
    SETUP:  POST with Content-Type: application/graphql-binary
            Accept: application/json
    EXPECT: response is standard JSON with correct data

  TEST: variables passed through correctly
    SETUP:  binary request for GET_USER_SIMPLE with variables { id: "2" }
    EXPECT: resolver receives id = "2"
            response reflects user with id "2"

  TEST: mutation request decoded and executed
    SETUP:  binary request for CREATE_POST
    EXPECT: operationType 1 handled, mutation executed

  TEST: all fixture queries produce correct results
    FOR EACH fixture query:
      build binary request → send → decode response → verify data


SUITE: BinaryTransferPlugin — standard request passthrough

  TEST: standard JSON GraphQL request processed normally
    SETUP:  POST with Content-Type: application/json
            body = { query: "{ user(id: \"1\") { name } }" }
    EXPECT: standard JSON response, plugin does not interfere

  TEST: binary plugin does not break standard Apollo behavior
    SETUP:  mix of binary and JSON requests
    EXPECT: both types handled correctly


SUITE: BinaryTransferPlugin — response encoding

  TEST: null data → JSON fallback even with Accept binary
  TEST: partial errors → X-GraphQL-Errors header
  TEST: errors exceeding maxErrorHeaderSize → JSON fallback
  TEST: encoding failure → JSON fallback + console.warn
  TEST: X-GraphQL-Schema-Hash matches live schema
  TEST: X-GraphQL-BT-Version is "1"

  TEST: schema mismatch at startup logs warning but starts
    SETUP:  manifest from schema v1, server with schema v2
    EXPECT: console.warn called, server starts, requests work


SUITE: BinaryTransferPlugin — malformed binary requests

  TEST: corrupt msgpack → error response
  TEST: invalid selection index (out of bounds) → error response
  TEST: missing selection field in body → error response
  TEST: empty body → error response
```

---

## 11. Unit Tests: Client Link

File: `tests/unit/link.test.ts`

### 11.1 Setup

```ts
import { BinaryTransferLink } from '../../src/client/link'
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack'
import { TEST_MANIFEST } from '../fixtures/manifest'
import { MIME_BINARY, HEADER_SCHEMA_HASH, HEADER_ERRORS } from '../../src/shared'

function createMockFetch(responses: MockResponse[]) {
  let callIndex = 0
  const calls: { url: string; init: RequestInit }[] = []

  const mockFetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return createFetchResponse(responses[callIndex++])
  }

  return { fetch: mockFetch as typeof globalThis.fetch, calls }
}

interface MockResponse {
  status?: number
  headers?: Record<string, string>
  body?: any               // JSON response
  binaryBody?: any[]       // Positional value array
}

function createFetchResponse(mock: MockResponse): Response {
  const headers = new Headers(mock.headers ?? {})
  return {
    status: mock.status ?? 200,
    headers,
    json: async () => mock.body,
    arrayBuffer: async () => {
      if (mock.binaryBody) return msgpackEncode(mock.binaryBody).buffer
      return new ArrayBuffer(0)
    }
  } as unknown as Response
}

function createTestLink(fetchMock: typeof globalThis.fetch, opts = {}) {
  return new BinaryTransferLink({
    uri: 'http://test/graphql',
    manifest: TEST_MANIFEST,
    fetch: fetchMock,
    ...opts
  })
}
```

### 11.2 Test Cases

```
SUITE: BinaryTransferLink — request encoding

  TEST: sends Content-Type: application/graphql-binary
  TEST: sends Accept header including binary MIME type

  TEST: request body is valid msgpack
    EXPECT: decode the raw body → has fields 's', 'o'

  TEST: selection tree matches expected encoding for each fixture query
    FOR EACH query:
      execute through link, inspect call body
      EXPECT: decoded 's' field matches expected selection tree

  TEST: operationType 0 for queries, 1 for mutations

  TEST: variables included as 'v' when present
  TEST: variables omitted when empty

  TEST: custom static headers sent
  TEST: custom header function called per request

  TEST: no query text in request body
    EXPECT: decoded body has no 'query' or 'operationName' field


SUITE: BinaryTransferLink — response decoding

  TEST: binary response decoded correctly
    SETUP:  response Content-Type: application/graphql-binary
            binaryBody: ["alice@example.com", "1", "Alice"]
    EXPECT: result.data = { user: { email: "alice@example.com", id: "1", name: "Alice" } }

  TEST: aliases applied from original query AST
    SETUP:  use GET_USER_ALIASED query
            binaryBody: ["alice@example.com", "1", "Alice"]
    EXPECT: result.data = { user: { contactEmail: "alice@example.com", userId: "1", displayName: "Alice" } }

  TEST: __typename injected in decoded objects
    EXPECT: result.data.user.__typename === "User"

  TEST: union types decoded with correct __typename
    SETUP:  use SEARCH_QUERY, binaryBody with type indices
    EXPECT: Post items have __typename: "Post", User items have __typename: "User"

  TEST: JSON response passed through unchanged
  TEST: errors from X-GraphQL-Errors header parsed into result


SUITE: BinaryTransferLink — error handling

  TEST: binary decode failure with onDecodingFailure='error' throws
  TEST: binary decode failure with onDecodingFailure='warn' logs + throws
  TEST: network error propagates
  TEST: unknown content-type throws


SUITE: BinaryTransferLink — schema drift detection

  TEST: matching schema hash → no warning
  TEST: mismatched schema hash → console.warn
    EXPECT: warning logged, request still succeeds
```

---

## 12. Integration Tests: Full Round-Trip

File: `tests/integration/roundtrip.test.ts`

### 12.1 Setup

```ts
import { ApolloServer } from '@apollo/server'
import { startStandaloneServer } from '@apollo/server/standalone'
import { ApolloClient, InMemoryCache } from '@apollo/client/core'
import { BinaryTransferPlugin } from '../../src/server/plugin'
import { BinaryTransferLink } from '../../src/client/link'
import { TEST_MANIFEST } from '../fixtures/manifest'
import { SCHEMA_SDL } from '../fixtures/schema'

let server: ApolloServer
let url: string
let client: ApolloClient<any>

beforeAll(async () => {
  server = new ApolloServer({
    typeDefs: SCHEMA_SDL,
    resolvers: fixtureResolvers,
    plugins: [BinaryTransferPlugin({ manifest: TEST_MANIFEST })]
  })

  const standalone = await startStandaloneServer(server, { listen: { port: 0 } })
  url = standalone.url

  client = new ApolloClient({
    link: new BinaryTransferLink({ uri: url, manifest: TEST_MANIFEST }),
    cache: new InMemoryCache()
  })
})

afterAll(async () => { await server.stop() })
```

### 12.2 Test Cases

```
SUITE: Full round-trip

  TEST: simple query → correct data
  TEST: nested query → author resolved correctly
  TEST: list query → correct length and item data
  TEST: empty list → []
  TEST: deeply nested with lists → comments with nested authors
  TEST: multiple root fields → viewer + feed both present
  TEST: aliased fields → alias keys in decoded response
  TEST: fragment spread → all fields present
  TEST: union query → correct types with correct fields
  TEST: mutation → returns created object
  TEST: null leaf values → preserved as null
  TEST: null nullable object → preserved as null
  TEST: scalar list field → tags is array of strings
  TEST: boolean false → preserved
  TEST: integer zero → preserved

  TEST: no query text on the wire
    METHOD: intercept fetch, decode request body
    EXPECT: body has 's' (selection tree), no 'query' field

  TEST: no field names in response
    METHOD: capture raw response bytes, inspect
    EXPECT: no JSON field name strings, only values

  TEST: response is smaller than JSON equivalent
    METHOD: capture binary bytes, compare to JSON.stringify(data)
    EXPECT: binary < JSON for all non-trivial queries

  TEST: cache normalization works (__typename present)
    SETUP:  run same query twice
    EXPECT: second query served from cache
            cache entries have correct __typename keys

  TEST: newly written query (not in any fixture list) works
    NOTE:   This is the key test for schema-positional architecture.
            A query that was never pre-registered should work.
    SETUP:  gql`query { user(id: "1") { age isAdmin } }`
    EXPECT: correct data returned
```

---

## 13. Integration Tests: Schema Drift

File: `tests/integration/schema-drift.test.ts`

```
SUITE: Schema drift

  TEST: server schema changed, manifest stale → drift warning
    SETUP:  manifest from schema v1, server running schema v2
    EXPECT: client logs schema drift warning
            requests may still succeed for unchanged fields

  TEST: field index shift after schema change → incorrect data or error
    SETUP:  manifest has User.email at index 3
            server schema added a field before email, shifting it to index 4
    EXPECT: data corruption or decode error detected
            (this demonstrates WHY schema hash checking matters)
```

---

## 14. Integration Tests: Fallback Behavior

File: `tests/integration/fallback.test.ts`

```
SUITE: Graceful fallback

  TEST: standard JSON client works alongside binary client
    SETUP:  binary BinaryTransferLink client + standard HttpLink client
    EXPECT: both get correct data from same server

  TEST: binary request with Accept: JSON gets JSON response
    EXPECT: server decodes positional selection, returns standard JSON

  TEST: server resolver throws → error propagates to client
```

---

## 15. Edge Cases

File: `tests/integration/edge-cases.test.ts`

```
SUITE: Edge cases

  TEST: very large list (1000 items × 10 fields) → correct round-trip
  TEST: deeply nested (10 levels) → correct at all depths
  TEST: unicode strings (emoji, CJK, RTL) → preserved
  TEST: very long string (100KB) → preserved
  TEST: integer at MAX_SAFE_INTEGER → preserved
  TEST: concurrent requests → all produce correct output
  TEST: duplicate field names at different type depths → correct values
  TEST: query selecting every field on a type → correct ordering
  TEST: query selecting single leaf field → minimal encoding
  TEST: empty response object → correct handling
  TEST: union list with mixed types in arbitrary order → type indices correct
```

---

## 16. Test Execution

```bash
npm test                                    # All tests
npm test -- --dir tests/unit                # Unit only
npm test -- --dir tests/integration         # Integration only
npm test -- --coverage                      # With coverage
npx vitest tests/unit/selection-encoder.test.ts  # Single file
npx vitest --watch                          # Watch mode
```

### 16.1 CI

```yaml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18, 20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '${{ matrix.node }}' }
      - run: npm ci
      - run: npm test -- --coverage
      - uses: codecov/codecov-action@v4
        with: { files: coverage/lcov.info }
```

### 16.2 Isolation

- Each integration suite starts its own Apollo Server on port 0.
- Servers started in `beforeAll`, stopped in `afterAll`.
- No shared state between suites.
- Unit tests are fully synchronous and isolated.
