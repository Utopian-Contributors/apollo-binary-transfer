import gql from 'graphql-tag'

// Seeded PRNG for deterministic "random" data across runs
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

const rand = mulberry32(42)

// Realistic data pools — varied lengths, no shared prefixes
const firstNames = [
  'Alice', 'Marcus', 'Yuki', 'Priya', 'Oleksandr', 'Fatima', 'Chen Wei',
  'Isabella', 'James', 'Nkechi', 'Sofia', 'Mohammed', 'Lena', 'Raj',
  'Anastasia', 'Kofi', 'Mei-Ling', 'Roberto', 'Aisha', 'Björn'
]

const lastNames = [
  'Chen', 'Williams', 'Nakamura', 'Patel', 'Kovalenko', 'Al-Rashid',
  'García', 'Rossi', 'Thompson', 'Okafor', 'Müller', 'Singh', 'Kim',
  'Johansson', 'Mensah', 'Zhang', 'López', 'Hassan', 'Eriksson', 'Dubois'
]

const titles = [
  'Understanding GraphQL Subscriptions in Production',
  'Why We Migrated from REST to GraphQL',
  'A Deep Dive into Apollo Cache Normalization',
  'Building Real-time Dashboards with WebSockets',
  'The Case for Server-Side Rendering in 2025',
  'How Binary Protocols Reduce Bandwidth by 60%',
  'Optimizing Database Queries for GraphQL Resolvers',
  'Type-Safe API Design with TypeScript and GraphQL',
  'Scaling Node.js: Lessons from Serving 10M Requests/Day',
  'Introduction to Schema Stitching and Federation',
  'React Server Components: A Practical Guide',
  'Implementing Cursor-Based Pagination',
  'GraphQL Error Handling Best Practices',
  'Monitoring GraphQL Performance in Production',
  'Caching Strategies for GraphQL APIs',
  'Authentication and Authorization in GraphQL',
  'Testing GraphQL APIs with Vitest',
  'Deploying GraphQL Services on Edge Networks',
  'Reducing Bundle Size with Code Splitting',
  'Managing Complex State in React Applications'
]

const bodies = [
  'In this article, we explore the challenges of implementing real-time features using GraphQL subscriptions at scale. We cover WebSocket connection management, subscription filtering, and error recovery patterns that have worked well in production environments.',
  'After three years of maintaining a REST API with over 200 endpoints, our team made the decision to migrate to GraphQL. This post covers the technical challenges, organizational hurdles, and measurable outcomes of that transition.',
  "Apollo Client's normalized cache is powerful but often misunderstood. We'll walk through how cache normalization works under the hood, common pitfalls, and advanced patterns for cache manipulation.",
  'Real-time dashboards require careful architecture to handle thousands of concurrent updates without overwhelming the browser. This post shares our approach using WebSocket multiplexing and virtual scrolling.',
  'Server-side rendering has evolved significantly. We compare modern approaches including React Server Components, Next.js App Router, and traditional SSR, with benchmarks on real-world applications.',
  'Binary wire protocols can dramatically reduce bandwidth compared to JSON. We demonstrate a positional encoding scheme that eliminates field names entirely, achieving 40-65% size reduction on typical GraphQL payloads.',
  'N+1 queries are the bane of GraphQL performance. This guide covers DataLoader patterns, query complexity analysis, and database-level optimizations that eliminated our worst performance bottlenecks.',
  'Combining TypeScript with GraphQL code generation gives you end-to-end type safety from schema to component props. We show our setup using graphql-codegen with custom plugins.',
  "Scaling a Node.js GraphQL server to handle 10 million requests per day required rethinking our architecture. This post covers worker threads, connection pooling, and the observability tools that made it possible.",
  'Schema stitching and Apollo Federation solve different problems in different ways. We compare both approaches with real examples from our multi-team microservices architecture.',
  'React Server Components change how we think about data fetching. This practical guide walks through converting a traditional React app to use RSC, with before/after performance measurements.',
  'Offset-based pagination breaks down at scale. We implemented cursor-based pagination using Relay-style connections, and this post explains the schema design, resolver logic, and client integration.',
  'GraphQL error handling is surprisingly nuanced. Should errors be in the errors array or modeled as union types? We explore both approaches with patterns for partial data, field-level errors, and retry logic.',
  'You cannot improve what you cannot measure. This post covers our GraphQL observability stack: trace sampling, resolver-level metrics, query complexity scoring, and alerting on performance regressions.',
  'Caching GraphQL responses requires understanding query semantics. We compare CDN-level caching, persisted queries, and normalized client caches, with guidance on when to use each approach.',
  'Implementing fine-grained authorization in GraphQL requires careful design. We share our schema directive approach, resolver middleware, and the testing strategy that gives us confidence in our access control.',
  "Writing comprehensive tests for GraphQL APIs doesn't have to be painful. We show our testing patterns using Vitest, including schema validation, resolver unit tests, and integration tests with a real database.",
  'Edge computing changes the latency equation for GraphQL. We deployed our API to 30 edge locations and share the architectural trade-offs, data replication challenges, and latency improvements.',
  'Our React bundle was 2.4MB. Through systematic code splitting, tree shaking, and lazy loading, we reduced it to 340KB. This post details every optimization and its individual impact.',
  'Managing complex application state across server cache, URL state, form state, and global UI state requires a clear strategy. We present our layered state management approach using React context and Apollo cache.'
]

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)]
}

function uuid(): string {
  const hex = '0123456789abcdef'
  let s = ''
  for (let i = 0; i < 32; i++) {
    if (i === 8 || i === 12 || i === 16 || i === 20) s += '-'
    s += hex[Math.floor(rand() * 16)]
  }
  return s
}

// Each generator produces ONLY the fields that its tier's query selects.
// This ensures fair JSON vs binary size comparisons — a real GraphQL server
// also only returns selected fields in JSON.

function generateFeedItems(count: number) {
  // For: { id title likes author { name } }
  return Array.from({ length: count }, () => {
    const first = pick(firstNames)
    const last = pick(lastNames)
    return {
      id: uuid(),
      title: pick(titles),
      likes: Math.floor(rand() * 50000),
      author: { name: `${first} ${last}` }
    }
  })
}

function generateFeedItemsSlim(count: number) {
  // For: { id title likes }
  return Array.from({ length: count }, () => ({
    id: uuid(),
    title: pick(titles),
    likes: Math.floor(rand() * 50000)
  }))
}

function generateFeedItemsFull(count: number) {
  // For: { id title body likes author { name } }
  return Array.from({ length: count }, () => {
    const first = pick(firstNames)
    const last = pick(lastNames)
    return {
      id: uuid(),
      title: pick(titles),
      body: pick(bodies),
      likes: Math.floor(rand() * 50000),
      author: { name: `${first} ${last}` }
    }
  })
}

function generateComments(count: number) {
  // For: { id text author { id name } createdAt }
  const commentTexts = [
    'Great article! This is exactly what I needed.',
    'I disagree with the conclusion — our experience has been very different.',
    "Thanks for sharing. Have you considered using DataLoader for this?",
    'We ran into the same issue. The fix was to increase the connection pool size.',
    'This is a really well-written explanation. Bookmarked for future reference.',
    "I wonder how this compares to the approach described in the Apollo docs?",
    'Interesting benchmarks. Can you share the test setup?',
    "We've been doing something similar but with a custom caching layer.",
    'The code examples are super clear. Would love to see a follow-up on testing.',
    'How does this handle the case where the schema changes between deployments?',
    '+1 for cursor-based pagination. Offset pagination caused us so many bugs.',
    "Nice write-up! We're evaluating this approach for our next project.",
    "I'd be curious about the memory overhead of this solution at scale.",
    "Have you measured the impact on TTFB? That's our main concern.",
    'This saved me hours of debugging. The error handling section was key.'
  ]

  return Array.from({ length: count }, () => {
    const first = pick(firstNames)
    const last = pick(lastNames)
    const day = Math.floor(rand() * 28) + 1
    const hour = Math.floor(rand() * 24)
    const min = Math.floor(rand() * 60)
    return {
      id: uuid(),
      text: pick(commentTexts),
      author: { id: uuid(), name: `${first} ${last}` },
      createdAt: `2025-${String(Math.floor(rand() * 12) + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00Z`
    }
  })
}

function generateSearchResults(count: number) {
  // For: ... on Post { id title } / ... on User { id name }
  // __typename is required for union type discrimination
  return Array.from({ length: count }, () => {
    if (rand() < 0.5) {
      return { __typename: 'Post' as const, id: uuid(), title: pick(titles) }
    } else {
      const first = pick(firstNames)
      const last = pick(lastNames)
      return { __typename: 'User' as const, id: uuid(), name: `${first} ${last}` }
    }
  })
}

export const TIERS = {
  micro: {
    name: 'Micro (3 fields)',
    query: gql`query($id: ID!) { user(id: $id) { id name email } }`,
    variables: { id: '1' },
    data: { user: { id: uuid(), name: 'Alice Chen', email: 'alice.chen42@company.io' } }
  },

  small: {
    name: 'Small (8 fields, nested)',
    query: gql`query($id: ID!) { user(id: $id) { id name email bio isAdmin avatar posts(limit: 3) { id title } } }`,
    variables: { id: '1' },
    data: {
      user: {
        id: uuid(), name: 'Marcus Williams', email: 'marcus.w@outlook.com',
        bio: 'Senior software engineer focused on distributed systems and API design. Previously at Stripe and Cloudflare.',
        isAdmin: true, avatar: 'https://cdn.example.com/avatars/marcus-williams-a7f3b2.jpg',
        posts: [
          { id: uuid(), title: 'Understanding GraphQL Subscriptions in Production' },
          { id: uuid(), title: 'Optimizing Database Queries for GraphQL Resolvers' },
          { id: uuid(), title: 'The Case for Server-Side Rendering in 2025' }
        ]
      }
    }
  },

  mediumList: {
    name: 'Medium list (20 items)',
    query: gql`query($limit: Int) { feed(limit: $limit) { id title likes author { name } } }`,
    variables: { limit: 20 },
    data: { feed: generateFeedItems(20) }
  },

  largeList: {
    name: 'Large list (100 items)',
    query: gql`query($limit: Int) { feed(limit: $limit) { id title likes author { name } } }`,
    variables: { limit: 100 },
    data: { feed: generateFeedItems(100) }
  },

  deepNesting: {
    name: 'Deep nesting (3 levels)',
    query: gql`query($id: ID!) { post(id: $id) { id title comments { id text author { id name } createdAt } } }`,
    variables: { id: '1' },
    data: { post: { id: uuid(), title: pick(titles), comments: generateComments(30) } }
  },

  multiRoot: {
    name: 'Multi-root (2 fields)',
    query: gql`query($limit: Int) { viewer { id name isAdmin } feed(limit: $limit) { id title likes } }`,
    variables: { limit: 5 },
    data: {
      viewer: { id: uuid(), name: 'Priya Patel', isAdmin: true },
      feed: generateFeedItemsSlim(5)
    }
  },

  stress: {
    name: 'Stress (1000 items)',
    query: gql`query($limit: Int) { feed(limit: $limit) { id title body likes author { name } } }`,
    variables: { limit: 1000 },
    data: { feed: generateFeedItemsFull(1000) }
  },

  minimal: {
    name: 'Minimal (1 field)',
    query: gql`query($id: ID!) { user(id: $id) { name } }`,
    variables: { id: '1' },
    data: { user: { name: 'Yuki Nakamura' } }
  },

  union: {
    name: 'Union (mixed types)',
    query: gql`query($query: String!) {
      search(query: $query) {
        ... on Post { id title }
        ... on User { id name }
      }
    }`,
    variables: { query: 'test' },
    data: { search: generateSearchResults(20) }
  }
} as const
