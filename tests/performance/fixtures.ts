import gql from 'graphql-tag'

function generatePosts(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    __typename: 'Post',
    id: String(100 + i),
    title: `Post Title ${i}`,
    body: `This is the body of post ${i}. It contains some text.`,
    likes: Math.floor(Math.random() * 1000),
    tags: ['tag1', 'tag2'],
    author: { __typename: 'User', id: String(i % 5), name: `User${i % 5}`, email: `user${i % 5}@example.com` }
  }))
}

function generateComments(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    __typename: 'Comment',
    id: `c${i}`,
    text: `Comment text number ${i}`,
    createdAt: `2025-01-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
    author: { __typename: 'User', id: String(i % 3), name: `Commenter${i % 3}` }
  }))
}

function generateSearchResults(count: number) {
  return Array.from({ length: count }, (_, i) =>
    i % 2 === 0
      ? { __typename: 'Post' as const, id: String(100 + i), title: `Search Post ${i}` }
      : { __typename: 'User' as const, id: String(i), name: `Search User ${i}` }
  )
}

export const TIERS = {
  micro: {
    name: 'Micro (3 fields)',
    query: gql`query($id: ID!) { user(id: $id) { id name email } }`,
    variables: { id: '1' },
    data: { user: { id: '1', name: 'Alice', email: 'alice@example.com' } }
  },

  small: {
    name: 'Small (8 fields, nested)',
    query: gql`query($id: ID!) { user(id: $id) { id name email bio isAdmin avatar posts(limit: 3) { id title } } }`,
    variables: { id: '1' },
    data: {
      user: {
        id: '1', name: 'Alice', email: 'alice@example.com',
        bio: 'Engineer', isAdmin: true, avatar: 'https://example.com/alice.jpg',
        posts: [
          { id: '100', title: 'Hello' },
          { id: '101', title: 'World' },
          { id: '102', title: 'Test' }
        ]
      }
    }
  },

  mediumList: {
    name: 'Medium list (20 items)',
    query: gql`query($limit: Int) { feed(limit: $limit) { id title likes author { name } } }`,
    variables: { limit: 20 },
    data: { feed: generatePosts(20) }
  },

  largeList: {
    name: 'Large list (100 items)',
    query: gql`query($limit: Int) { feed(limit: $limit) { id title likes author { name } } }`,
    variables: { limit: 100 },
    data: { feed: generatePosts(100) }
  },

  deepNesting: {
    name: 'Deep nesting (3 levels)',
    query: gql`query($id: ID!) { post(id: $id) { id title comments { id text author { id name } createdAt } } }`,
    variables: { id: '1' },
    data: { post: { id: '1', title: 'Hello', comments: generateComments(30) } }
  },

  multiRoot: {
    name: 'Multi-root (2 fields)',
    query: gql`query($limit: Int) { viewer { id name isAdmin } feed(limit: $limit) { id title likes } }`,
    variables: { limit: 5 },
    data: {
      viewer: { id: '1', name: 'Alice', isAdmin: true },
      feed: generatePosts(5)
    }
  },

  stress: {
    name: 'Stress (1000 items)',
    query: gql`query($limit: Int) { feed(limit: $limit) { id title body likes author { name } } }`,
    variables: { limit: 1000 },
    data: { feed: generatePosts(1000) }
  },

  minimal: {
    name: 'Minimal (1 field)',
    query: gql`query($id: ID!) { user(id: $id) { name } }`,
    variables: { id: '1' },
    data: { user: { name: 'Alice' } }
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
