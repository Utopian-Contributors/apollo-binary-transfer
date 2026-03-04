import { USER_ALICE, USER_BOB, POST_HELLO, POST_GOODBYE, COMMENT_1, COMMENT_2 } from './responses'

const users = [USER_ALICE, USER_BOB]
const posts = [POST_HELLO, POST_GOODBYE]

export const resolvers = {
  Query: {
    user: (_: any, { id }: { id: string }) =>
      users.find(u => u.id === id) ?? null,
    users: (_: any, { limit, offset }: { limit?: number; offset?: number }) => {
      const start = offset ?? 0
      const end = limit ? start + limit : undefined
      return users.slice(start, end)
    },
    post: (_: any, { id }: { id: string }) =>
      posts.find(p => p.id === id) ?? null,
    feed: (_: any, { limit }: { limit?: number }) =>
      limit != null ? posts.slice(0, limit) : posts,
    search: (_: any, { query }: { query: string }) => [
      { ...POST_HELLO, __typename: 'Post' as const },
      { ...USER_ALICE, __typename: 'User' as const }
    ],
    viewer: () => USER_ALICE
  },
  Mutation: {
    createPost: (_: any, { input }: any) => ({
      ...POST_HELLO,
      id: '999',
      title: input.title,
      body: input.body,
      tags: input.tags ?? [],
      likes: 0
    }),
    deletePost: (_: any, { id }: { id: string }) => true,
    updateUser: (_: any, { id, input }: any) => ({
      ...USER_ALICE,
      id,
      ...input
    })
  },
  Post: {
    comments: () => [COMMENT_1, COMMENT_2]
  },
  User: {
    posts: (_: any, { limit }: { limit?: number }) =>
      limit != null ? posts.slice(0, limit) : posts
  },
  SearchResult: {
    __resolveType(obj: any) {
      return obj.__typename
    }
  }
}
