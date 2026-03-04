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
