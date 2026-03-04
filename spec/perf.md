# apollo-binary-transfer — Performance Test Specification

Version: 3.0.0-draft
Companion to: Package Specification v3.0.0-draft, Test Suite Specification v3.0.0-draft

---

## 1. Overview

Performance tests measure wire size, encoding/decoding throughput, and end-to-end latency. All benchmarks use Vitest's `bench` API. Results are saved as JSON baselines for regression detection in CI.

The key measurement axis in this architecture is **both directions** — the schema-positional encoding reduces both request and response sizes, unlike the previous hash-based design which only reduced requests by a fixed amount.

---

## 2. Payload Tiers

Every benchmark runs against a standard set of query/response tiers that cover the range from trivial to stress-test.

```ts
const TIERS = {
  // Tier 1: Micro — 3 leaf fields
  micro: {
    query: gql`query { user(id: "1") { id name email } }`,
    data: { user: { id: "1", name: "Alice", email: "alice@example.com" } }
  },

  // Tier 2: Small — 8 fields with one level of nesting
  small: {
    query: gql`query { user(id: "1") { id name email bio isAdmin avatar posts(limit: 3) { id title } } }`,
    data: { user: { id: "1", name: "Alice", email: "alice@example.com", bio: "Engineer", isAdmin: true, avatar: "https://...", posts: [
      { id: "100", title: "Hello" }, { id: "101", title: "World" }, { id: "102", title: "Test" }
    ] } }
  },

  // Tier 3: Medium list — 20 items × 5 fields
  mediumList: {
    query: gql`query { feed(limit: 20) { id title likes author { name } } }`,
    data: { feed: generatePosts(20) }
  },

  // Tier 4: Large list — 100 items × 5 fields
  largeList: {
    query: gql`query { feed(limit: 100) { id title likes author { name } } }`,
    data: { feed: generatePosts(100) }
  },

  // Tier 5: Deep nesting — 3 levels (post → comments → author)
  deepNesting: {
    query: gql`query { post(id: "1") { id title comments { id text author { id name } createdAt } } }`,
    data: { post: { id: "1", title: "Hello", comments: generateComments(30) } }
  },

  // Tier 6: Multi-root — dashboard with 2 root fields
  multiRoot: {
    query: gql`query { viewer { id name isAdmin } feed(limit: 5) { id title likes } }`,
    data: { viewer: { id: "1", name: "Alice", isAdmin: true }, feed: generatePosts(5) }
  },

  // Tier 7: Stress — 1000 items × 6 fields
  stress: {
    query: gql`query { feed(limit: 1000) { id title body likes author { name } } }`,
    data: { feed: generatePosts(1000) }
  },

  // Tier 8: Minimal — single scalar
  minimal: {
    query: gql`query { user(id: "1") { name } }`,
    data: { user: { name: "Alice" } }
  },

  // Tier 9: Union — mixed types
  union: {
    query: gql`query { search(query: "test") { ... on Post { id title } ... on User { id name } } }`,
    data: { search: generateSearchResults(20) }
  }
}
```

---

## 3. Wire Size Benchmarks

File: `tests/performance/wire-size.bench.ts`

### 3.1 Request Size Comparison

```
SUITE: Request size — query text vs positional selection

  For each tier:

    MEASURE: Full query text
      Method: JSON.stringify({ query: print(document), variables })
      Record: byte length

    MEASURE: Positional selection (binary)
      Method: msgpackEncode({ s: tree, o: opType, v: variables })
      Record: byte length

    MEASURE: Positional selection (JSON, for reference)
      Method: JSON.stringify({ s: tree, o: opType, v: variables })
      Record: byte length

    COMPUTE:
      - Binary selection vs full query text (% reduction)
      - Binary selection vs JSON selection (msgpack overhead/savings)

    REPORT TABLE:
      | Tier | Query Text | JSON Selection | Binary Selection | vs Query |
```

**Expected results:**

| Tier | Query Text (bytes) | Binary Selection (bytes) | Reduction |
|---|---|---|---|
| Micro (3 fields) | ~55 | ~12 | -78% |
| Small (8 fields, nested) | ~120 | ~22 | -82% |
| Medium list (same query) | ~70 | ~15 | -79% |
| Deep nesting | ~110 | ~25 | -77% |
| Multi-root | ~85 | ~20 | -76% |
| Stress (same query) | ~80 | ~18 | -78% |
| Minimal | ~35 | ~8 | -77% |
| Union | ~100 | ~25 | -75% |

Request size reduction is consistent (~75-82%) because it's proportional to the number of field name characters replaced by integers. Larger queries save more absolute bytes but the ratio is stable.

### 3.2 Response Size Comparison

```
SUITE: Response size — JSON vs binary

  For each tier:

    MEASURE: JSON response
      Method: JSON.stringify({ data })
      Record: byte length

    MEASURE: JSON + gzip response
      Method: gzip(JSON.stringify({ data }))
      Record: byte length

    MEASURE: JSON + brotli response
      Method: brotli(JSON.stringify({ data }))
      Record: byte length

    MEASURE: Binary response
      Method: msgpackEncode(flattenResponse(data, tree, rootType, manifest))
      Record: byte length

    MEASURE: Binary + gzip response
    MEASURE: Binary + brotli response

    COMPUTE:
      - Binary vs JSON (% reduction)
      - Binary vs JSON+gzip (% reduction)
      - Binary+gzip vs JSON+gzip (% reduction)

    REPORT TABLE:
      | Tier | JSON | JSON+gz | JSON+br | Binary | Bin+gz | Bin+br | vs JSON+gz |
```

### 3.3 Total Round-Trip Size

```
SUITE: Total round-trip bytes — request + response

  For each tier, for each encoding combination:
    - Standard: query text request + JSON response
    - Standard + gzip: query text + JSON+gzip
    - Binary: positional selection + binary response
    - Binary + gzip: positional selection + binary+gzip

    COMPUTE:
      - Total bytes for each
      - Binary vs Standard (% reduction)
      - Binary+gzip vs Standard+gzip (% reduction)

    REPORT TABLE:
      | Tier | Standard | Standard+gz | Binary | Binary+gz | vs Std+gz |
```

### 3.4 Field Name Overhead Analysis

```
SUITE: Field name overhead — quantifying what binary eliminates

  For each tier:

    MEASURE: Total bytes spent on JSON field name strings (keys)
      Method: walk the JSON, sum byte lengths of all keys + quotes + colons
    MEASURE: Total bytes spent on JSON values
    MEASURE: Total bytes spent on structural characters ({, }, [, ], commas)

    COMPUTE:
      - Key overhead as % of total JSON
      - Theoretical maximum binary savings (keys + most structural chars)
      - Actual binary savings vs theoretical

    EXPECTED: Keys typically account for 30-50% of JSON response size.
              Binary eliminates all of it.
```

### 3.5 Session Simulations

```
SUITE: Simulated user sessions — cumulative savings

  SESSION A: "Browse and read" (8 queries)
    1. Dashboard (Tier 6)
    2. Feed page 1 (Tier 3)
    3. Feed page 2 (Tier 3)
    4. Post detail (Tier 5, 30 comments)
    5. Author profile (Tier 2)
    6. Feed page 3 (Tier 3)
    7. Post detail (Tier 5, 15 comments)
    8. Feed page 4 (Tier 3)

    MEASURE for each encoding:
      - Total request bytes (sum of all 8)
      - Total response bytes (sum of all 8)
      - Total round-trip bytes

    COMPUTE:
      - Cumulative savings binary vs standard (bytes and %)
      - Cumulative savings binary+gzip vs standard+gzip
      - Per-request average savings

  SESSION B: "Create and edit" (5 queries)
    1. Dashboard (Tier 6)
    2. Create post mutation (small response)
    3. Post detail (Tier 5, 0 comments)
    4. Update user mutation (small response)
    5. Post detail (Tier 5, 2 comments)

  SESSION C: "Power user" (8 data-heavy queries)
    1. Dashboard (Tier 6)
    2. Users list (100 items)
    3. Feed (100 items)
    4. Post detail (50 comments)
    5. Search (Tier 9, 20 results)
    6. Feed (100 items, different offset)
    7. User profile (Tier 2)
    8. Feed (100 items, another offset)
```

---

## 4. Encoding Throughput Benchmarks

File: `tests/performance/throughput.bench.ts`

### 4.1 Selection Encoding Throughput

```
SUITE: encodeSelection throughput

  For each tier:
    PRE-COMPUTE: document = parse(queryString)
    BENCH: encodeSelection(document, manifest)
    REPORT: ops/sec, mean time (μs)

  ASSERTION: All tiers < 100μs mean
  NOTE: This runs on every client request. Must be fast.
```

### 4.2 Selection Decoding Throughput

```
SUITE: decodeSelection throughput

  For each tier:
    PRE-COMPUTE: tree = encodeSelection(document, manifest).tree
    BENCH: decodeSelection(tree, opType, manifest)
    REPORT: ops/sec, mean time (μs)

  ASSERTION: All tiers < 100μs mean
  NOTE: This runs on every server request. Must be fast.
```

### 4.3 Response Flatten Throughput

```
SUITE: flattenResponse throughput

  For each tier:
    PRE-COMPUTE: tree, data
    BENCH: flattenResponse(data, tree, rootType, manifest)
    REPORT: ops/sec, mean time (μs)

  BASELINE comparison:
    BENCH: JSON.stringify(data)
    REPORT: ratio (flatten should be faster — no key serialization)

  ASSERTION: flatten ops/sec >= JSON.stringify ops/sec for equivalent data
```

### 4.4 Response Rebuild Throughput

```
SUITE: rebuildResponse throughput

  For each tier:
    PRE-COMPUTE: values = flattenResponse(data, tree, rootType, manifest)
    BENCH: rebuildResponse(values, tree, rootType, manifest)
    REPORT: ops/sec, mean time (μs)

  BASELINE comparison:
    BENCH: JSON.parse(JSON.stringify(data))
    REPORT: ratio

  ASSERTION: rebuild ops/sec >= JSON.parse ops/sec for equivalent data
```

### 4.5 Msgpack Isolation

```
SUITE: msgpack encode/decode throughput

  For each tier:
    PRE-COMPUTE: values = flattenResponse(...)
    BENCH: msgpackEncode(values)
    BENCH: msgpackDecode(encoded)
    REPORT: ops/sec for each

  COMPARE: msgpackEncode vs JSON.stringify, msgpackDecode vs JSON.parse
```

### 4.6 Manifest Generation Throughput

```
SUITE: generateManifest throughput

  For schema sizes [10, 25, 50, 100 types]:
    SETUP: generate schema with N types, ~8 fields each
    BENCH: generateManifest(schema)
    REPORT: total time (ms), per-type time (μs)

  ASSERTION: 50 types < 100ms
             100 types < 300ms
  NOTE: Runs once at build time. Not performance-critical, but shouldn't
        be annoying during development (codegen watch mode).
```

### 4.7 Full Pipeline Throughput

```
SUITE: Full encode/decode pipeline

  For each tier:

    BENCH: Client-side full pipeline
      encodeSelection(doc, manifest) → msgpackEncode(requestBody)
      REPORT: ops/sec (combined encoding)

    BENCH: Server-side full pipeline
      msgpackDecode(requestBody) → decodeSelection(tree) → print(doc)
      → [simulated resolve] →
      flattenResponse(data, tree) → msgpackEncode(values)
      REPORT: ops/sec (combined server processing)

    BENCH: Client-side decode pipeline
      msgpackDecode(responseBody) → rebuildResponse(values, tree)
      REPORT: ops/sec

    COMPUTE: Total pipeline overhead vs JSON.stringify + JSON.parse
```

---

## 5. Latency Benchmarks

File: `tests/performance/latency.bench.ts`

### 5.1 Setup

```ts
import { ApolloServer } from '@apollo/server'
import { startStandaloneServer } from '@apollo/server/standalone'
import { ApolloClient, InMemoryCache } from '@apollo/client/core'
import { BinaryTransferPlugin, expressBinaryMiddleware } from '../../src/server/plugin'
import { BinaryTransferLink } from '../../src/client/link'

const manifest = TEST_MANIFEST

// JSON baseline server (no plugin)
let jsonServer: ApolloServer
let jsonServerUrl: string

// Binary transfer server
let binaryServer: ApolloServer
let binaryServerUrl: string

beforeAll(async () => {
  jsonServer = new ApolloServer({ typeDefs, resolvers })
  const js = await startStandaloneServer(jsonServer, { listen: { port: 0 } })
  jsonServerUrl = js.url

  binaryServer = new ApolloServer({
    typeDefs, resolvers,
    plugins: [BinaryTransferPlugin({ manifest })]
  })
  const bs = await startStandaloneServer(binaryServer, { listen: { port: 0 } })
  binaryServerUrl = bs.url
})
```

### 5.2 Latency Benchmarks

```
SUITE: End-to-end latency — JSON vs binary

  For each tier:

    BENCH: JSON baseline
      ApolloClient with HttpLink → jsonServerUrl
      Measure: client.query() call to data received
      Iterations: 100 (after 10 warmup)

    BENCH: Binary transfer
      ApolloClient with BinaryTransferLink → binaryServerUrl
      Measure: same

    REPORT: mean, p50, p95, p99 for both
    COMPUTE: binary vs JSON latency difference (ms and %)

  EXPECTED: On localhost, differences will be sub-millisecond.
            Binary should be slightly faster on larger tiers due to
            smaller payloads (less serialization, less network I/O).
            The benchmark exists to catch regressions, not prove gains.


SUITE: End-to-end latency — concurrent requests

  For concurrency levels [1, 5, 10, 25, 50]:

    BENCH: JSON baseline
      Fire N concurrent client.query() (different queries from tier mix)
      Measure: time until all N complete

    BENCH: Binary transfer
      Same concurrent calls with BinaryTransferLink

    REPORT: total time, mean per-request, p99
    COMPUTE: throughput (requests/sec)
```

### 5.3 Server-Side Overhead Isolation

```
SUITE: Server processing overhead

  PURPOSE: Isolate plugin cost separate from network.

  For each tier:

    MEASURE: Selection decode time
      Record time for msgpackDecode + decodeSelection + print
      (the request-side overhead the plugin adds)

    MEASURE: Response encode time
      Record time for flattenResponse + msgpackEncode
      (the response-side overhead)

    BASELINE: Standard Apollo request processing (no plugin)

    REPORT: mean overhead per-request (μs) for each phase
    ASSERTION: Total plugin overhead < 500μs for Tiers 1-6
               Total plugin overhead < 2ms for Tier 7 (1000 items)
```

---

## 6. Scaling Analysis

File: `tests/performance/scaling.bench.ts`

### 6.1 Response Size vs List Length

```
SUITE: Scaling — list length

  For list lengths [1, 5, 10, 20, 50, 100, 200, 500, 1000]:

    FIXTURE: feed query with N posts × 5 fields

    MEASURE: JSON size, JSON+gzip, binary, binary+gzip
    PLOT: X = list length, Y = bytes for each encoding
    COMPUTE: at what list length does gzip on JSON close the gap to < 10% of binary?

  EXPECTED: Binary advantage is largest on small lists (gzip has less
            redundancy to exploit). On large lists (500+), JSON+gzip
            approaches binary because gzip eliminates repeated key strings.
            Binary+gzip should remain consistently smaller.
```

### 6.2 Response Size vs Field Count

```
SUITE: Scaling — field count per object

  For field counts [2, 5, 10, 15, 20, 30, 50]:

    FIXTURE: single object with N fields (mix of string, int, bool)

    MEASURE: JSON size, binary size
    COMPUTE: ratio as field count grows

  EXPECTED: More fields = higher key overhead in JSON = larger binary advantage.
```

### 6.3 Response Size vs Nesting Depth

```
SUITE: Scaling — nesting depth

  For depths [1, 2, 3, 5, 7, 10]:

    FIXTURE: chain of single objects nested N levels

    MEASURE: JSON size, binary size
    COMPUTE: overhead per nesting level for each format
```

### 6.4 Request Size vs Query Complexity

```
SUITE: Scaling — request selection size

  For selection sizes [1, 3, 5, 10, 20, 50 selected fields]:

    FIXTURE: query selecting N fields across various nesting levels

    MEASURE: GraphQL query text size
    MEASURE: Positional selection size (msgpack)
    PLOT: X = field count, Y = bytes
    COMPUTE: at what complexity does positional encoding save the most?

  EXPECTED: Savings grow with complexity because field name strings get
            longer (nested paths) while integer arrays grow slowly.
```

### 6.5 Request Size vs Value Type Distribution

```
SUITE: Scaling — value types

  For distributions:
    - All strings (worst case for binary — content dominates)
    - All integers (best case — msgpack integers are 1-5 bytes)
    - All booleans (best case — 1 byte each)
    - Mixed realistic
    - Lots of nulls

    FIXTURE: 50-item list with 8 fields per item, values from distribution

    MEASURE: JSON size, binary size, JSON+gzip, binary+gzip
    COMPUTE: binary advantage by value type

  EXPECTED: Integer/boolean-heavy responses show largest advantage.
            String-dominated responses show smallest (content dwarfs overhead).
```

---

## 7. Regression Detection

### 7.1 Baseline File

```ts
// tests/performance/baseline.json
{
  "version": "3.0.0",
  "generated": "2025-...",
  "wire_size": {
    "micro": { "request_query": 55, "request_binary": 12, "response_json": 175, "response_binary": 70 },
    "small": { ... },
    ...
  },
  "throughput": {
    "encode_selection_micro": { "ops_sec": 500000 },
    "decode_selection_micro": { "ops_sec": 500000 },
    "flatten_micro": { "ops_sec": 400000 },
    "rebuild_micro": { "ops_sec": 400000 },
    ...
  },
  "latency": {
    "e2e_micro_json_p50": 2.1,
    "e2e_micro_binary_p50": 1.8,
    ...
  }
}
```

### 7.2 Regression Thresholds

| Metric | Tolerance | Action on Breach |
|---|---|---|
| Wire size (request binary) | 0% (deterministic) | Fail CI |
| Wire size (response binary) | 0% (deterministic) | Fail CI |
| Throughput (ops/sec) | -10% | Warn |
| Throughput (ops/sec) | -25% | Fail CI |
| Latency (p50) | +15% | Warn |
| Latency (p50) | +30% | Fail CI |

Wire sizes are deterministic — same input always produces same output. Any change indicates a bug or an intentional format change.

### 7.3 CI Integration

```yaml
name: Performance
on: [pull_request]
jobs:
  perf:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm ci
      - run: npm run bench
      - run: npm run bench:compare  # Compare against baseline.json
      - uses: actions/github-script@v7
        with:
          script: |
            // Post benchmark results as PR comment
```

---

## 8. Benchmark Execution

```bash
npm run bench                               # All benchmarks
npm run bench -- wire-size                   # Wire size only
npm run bench -- throughput                  # Throughput only
npm run bench -- latency                     # Latency only
npm run bench -- scaling                     # Scaling analysis only
npm run bench:baseline                       # Generate new baseline.json
npm run bench:compare                        # Compare current vs baseline
```

```json
// package.json scripts
{
  "bench": "vitest bench tests/performance/",
  "bench:baseline": "vitest bench tests/performance/ --reporter=json > tests/performance/baseline.json",
  "bench:compare": "node scripts/compare-benchmarks.js"
}
```

---

## 9. Expected Performance Profile

### 9.1 Where Binary Wins Hardest

- **Small responses (Tier 1-2):** Key overhead is 40-50% of JSON. Binary eliminates all of it. 50-60% reduction vs JSON, 40-50% vs JSON+gzip.
- **Integer/boolean-heavy data:** Msgpack encodes `42` as 1 byte, `true` as 1 byte. JSON: 2+ bytes plus key overhead.
- **Deeply nested responses:** Each nesting level adds `{`, `}`, key strings. Binary: zero nesting overhead.
- **Requests:** 75-85% smaller across all tiers. Consistent because the ratio of field name characters to integer bytes is stable.

### 9.2 Where Binary Wins Least

- **Large string-heavy responses (Tier 4, 7):** String content dominates. Keys are a smaller fraction. Gzip on JSON recovers most of the difference. Binary+gzip still wins by 15-25%.
- **Minimal responses (Tier 8):** Absolute savings are tiny (5-10 bytes). Relative savings are large (50%+) but irrelevant in practice.

### 9.3 New Advantage: Bidirectional Savings

The previous hash-based architecture saved ~100 bytes per request (fixed hash size). The schema-positional architecture saves proportional to query complexity:

| Query complexity | Hash-based request savings | Positional request savings |
|---|---|---|
| Simple (3 fields) | ~55 → ~130 bytes (APQ envelope) | ~55 → ~12 bytes |
| Medium (10 fields) | ~120 → ~130 bytes | ~120 → ~22 bytes |
| Complex (30 fields) | ~350 → ~130 bytes | ~350 → ~45 bytes |

The hash-based approach actually made small requests LARGER (APQ envelope overhead). The positional approach always makes requests smaller, and the savings grow with query complexity.
