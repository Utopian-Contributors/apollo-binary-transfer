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
