import gql from 'graphql-tag'

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
// Expected: [[5, [4, 5, 6]], [0, [3, 4, 6]]]
// viewer(5) → {id(4), isAdmin(5), name(6)}; feed(0) → {id(3), likes(4), title(6)}

export const GET_USER_ALIASED = gql`
  query GetUserAliased($id: ID!) {
    user(id: $id) { userId: id displayName: name contactEmail: email }
  }
`
// Selection same as GET_USER_SIMPLE: [[3, [3, 4, 6]]]

export const GET_USER_WITH_FRAGMENT = gql`
  fragment UserBasic on User { id name email }
  query GetUser($id: ID!) {
    user(id: $id) { ...UserBasic bio }
  }
`
// Expected: [[3, [4, 6, 3, 2]]]
// user(3) → id(4), name(6), email(3), bio(2)
// Note: fragment fields appear in AST order (id, name, email), then bio

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
// Expected: [[3, [4, 6, 2, 1]]]
// user(3) → id(4), name(6), bio(2), avatar(1) — in AST order

export const CREATE_POST = gql`
  mutation CreatePost($input: CreatePostInput!) {
    createPost(input: $input) { id title body likes }
  }
`
// Expected selection tree: [[0, [3, 6, 1, 4]]]
// operationType: 1 (mutation)
// createPost(0) → id(3), title(6), body(1), likes(4) — in AST order

export const GET_FEED_EMPTY = gql`
  query GetFeedEmpty { feed(limit: 0) { id title } }
`
// Expected: [[0, [3, 6]]]

export const GET_POST_TAGS = gql`
  query GetPostTags($id: ID!) {
    post(id: $id) { id title tags }
  }
`
// Expected: [[1, [3, 6, 5]]]
// post(1) → id(3), title(6), tags(5) — in AST order
