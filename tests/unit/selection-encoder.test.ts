import { describe, it, expect } from 'vitest'
import { parse } from 'graphql'
import { encodeSelection } from '../../src/shared/selection-encoder'
import { TEST_MANIFEST } from '../fixtures/manifest'
import {
  GET_USER_SIMPLE,
  GET_POST_WITH_AUTHOR,
  GET_FEED,
  GET_POST_WITH_COMMENTS,
  DASHBOARD,
  GET_USER_ALIASED,
  GET_USER_WITH_FRAGMENT,
  SEARCH_QUERY,
  CREATE_POST,
  GET_FEED_EMPTY,
  GET_POST_TAGS
} from '../fixtures/queries'

describe('encodeSelection — leaf fields', () => {
  it('simple flat query', () => {
    const { tree, operationType } = encodeSelection(GET_USER_SIMPLE, TEST_MANIFEST)
    expect(operationType).toBe(0)
    // user=3, sub-selects: fields appear in AST order (id, name, email)
    // id=4, name=6, email=3
    expect(tree).toEqual([[3, [4, 6, 3]]])
  })

  it('returns operationType 0 for queries', () => {
    const { operationType } = encodeSelection(GET_USER_SIMPLE, TEST_MANIFEST)
    expect(operationType).toBe(0)
  })

  it('returns operationType 1 for mutations', () => {
    const { operationType } = encodeSelection(CREATE_POST, TEST_MANIFEST)
    expect(operationType).toBe(1)
  })
})

describe('encodeSelection — composite fields', () => {
  it('nested object', () => {
    const { tree } = encodeSelection(GET_POST_WITH_AUTHOR, TEST_MANIFEST)
    // post(1) → sub-selections in AST order: id(3), title(6), body(1), likes(4), author(0)→{id(4), name(6)}
    expect(tree).toEqual([[1, [3, 6, 1, 4, [0, [4, 6]]]]])
  })

  it('deeply nested (3 levels)', () => {
    const { tree } = encodeSelection(GET_POST_WITH_COMMENTS, TEST_MANIFEST)
    // post(1) → id(3), title(6), comments(2)→{id(2), text(3), author(0)→{id(4), name(6)}, createdAt(1)}
    expect(tree).toEqual([[1, [3, 6, [2, [2, 3, [0, [4, 6]], 1]]]]])
  })

  it('list field', () => {
    const { tree } = encodeSelection(GET_FEED, TEST_MANIFEST)
    // feed(0) → id(3), title(6), likes(4), author(0)→{name(6)}
    expect(tree).toEqual([[0, [3, 6, 4, [0, [6]]]]])
  })
})

describe('encodeSelection — multiple root fields', () => {
  it('dashboard with two root fields', () => {
    const { tree } = encodeSelection(DASHBOARD, TEST_MANIFEST)
    // viewer(5) → {id(4), name(6), isAdmin(5)}; feed(0) → {id(3), title(6), likes(4)}
    expect(tree).toEqual([
      [5, [4, 6, 5]],
      [0, [3, 6, 4]]
    ])
  })
})

describe('encodeSelection — aliases', () => {
  it('aliases do not affect selection tree', () => {
    const { tree: aliasedTree } = encodeSelection(GET_USER_ALIASED, TEST_MANIFEST)
    const { tree: normalTree } = encodeSelection(GET_USER_SIMPLE, TEST_MANIFEST)
    expect(aliasedTree).toEqual(normalTree)
  })
})

describe('encodeSelection — fragments', () => {
  it('fragment spread inlines at spread site', () => {
    const { tree } = encodeSelection(GET_USER_WITH_FRAGMENT, TEST_MANIFEST)
    // user(3) → fragment fields (id=4, name=6, email=3) then bio=2
    expect(tree).toEqual([[3, [4, 6, 3, 2]]])
  })

  it('inline fragment on non-union type flattens', () => {
    const doc = parse(`query { user(id: "1") { ... on User { name email } } }`)
    const { tree } = encodeSelection(doc, TEST_MANIFEST)
    // name=6, email=3
    expect(tree).toEqual([[3, [6, 3]]])
  })
})

describe('encodeSelection — unions', () => {
  it('union with inline fragments', () => {
    const { tree } = encodeSelection(SEARCH_QUERY, TEST_MANIFEST)
    expect(tree).toEqual([[2, { 0: [3, 6], 1: [4, 6] }]])
  })

  it('union member type indices match manifest.unions alphabetical order', () => {
    expect(TEST_MANIFEST.unions.SearchResult).toEqual(['Post', 'User'])
  })
})

describe('encodeSelection — __typename', () => {
  it('__typename fields are skipped', () => {
    const doc = parse(`query { user(id: "1") { __typename id name } }`)
    const { tree } = encodeSelection(doc, TEST_MANIFEST)
    expect(tree).toEqual([[3, [4, 6]]])
  })
})

describe('encodeSelection — fragment spread on union', () => {
  it('named fragment spread on union field', () => {
    const doc = parse(`
      fragment PostFields on Post { id title }
      fragment UserFields on User { id name }
      query($q: String!) {
        search(query: $q) {
          ...PostFields
          ...UserFields
        }
      }
    `)
    const { tree } = encodeSelection(doc, TEST_MANIFEST)
    // Should produce same result as inline fragments
    expect(tree).toEqual([[2, { 0: [3, 6], 1: [4, 6] }]])
  })

  it('mixed inline + named fragment on union', () => {
    const doc = parse(`
      fragment UserFields on User { id name }
      query($q: String!) {
        search(query: $q) {
          ... on Post { id title }
          ...UserFields
        }
      }
    `)
    const { tree } = encodeSelection(doc, TEST_MANIFEST)
    expect(tree).toEqual([[2, { 0: [3, 6], 1: [4, 6] }]])
  })
})

describe('encodeSelection — errors', () => {
  it('unknown field name throws', () => {
    const doc = parse(`query { user(id: "1") { nonexistent } }`)
    expect(() => encodeSelection(doc, TEST_MANIFEST)).toThrow('Unknown field: nonexistent')
  })

  it('unknown type name throws', () => {
    const manifest = { ...TEST_MANIFEST, roots: { query: 'NonExistent' } }
    const doc = parse(`query { user(id: "1") { id } }`)
    expect(() => encodeSelection(doc, manifest)).toThrow('Unknown type: NonExistent')
  })

  it('no operation definition throws', () => {
    const doc = parse(`fragment F on User { id }`)
    expect(() => encodeSelection(doc, TEST_MANIFEST)).toThrow('No operation definition found')
  })
})
