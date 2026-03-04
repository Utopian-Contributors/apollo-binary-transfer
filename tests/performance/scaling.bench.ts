import { describe, bench } from 'vitest'
import { encode as msgpackEncode } from '@msgpack/msgpack'
import { encodeSelection } from '../../src/shared/selection-encoder'
import { flattenResponse, encodeResponse } from '../../src/shared/response-encoder'
import { TEST_MANIFEST } from '../fixtures/manifest'
import { TIERS } from './fixtures'
import gql from 'graphql-tag'

// Pre-compute selection tree for feed query
const feedQuery = TIERS.mediumList.query
const { tree: feedTree } = encodeSelection(feedQuery, TEST_MANIFEST)
const feedRootType = TEST_MANIFEST.roots.query

function generateFeedData(count: number) {
  return {
    feed: Array.from({ length: count }, (_, i) => ({
      id: String(i),
      title: `Post ${i}`,
      likes: i * 10,
      author: { name: `Author${i % 10}` }
    }))
  }
}

// === Scaling: list length ===

const listLengths = [1, 5, 10, 20, 50, 100, 200, 500, 1000]

console.log('\n=== Scaling: Response Size vs List Length ===')
console.log('| Length | JSON (B) | Binary (B) | Reduction |')
console.log('|---|---|---|---|')
for (const n of listLengths) {
  const data = generateFeedData(n)
  const json = JSON.stringify({ data })
  const binary = encodeResponse(data, feedTree, feedRootType, TEST_MANIFEST)
  const reduction = ((1 - binary.byteLength / Buffer.byteLength(json)) * 100).toFixed(1)
  console.log(`| ${n} | ${Buffer.byteLength(json)} | ${binary.byteLength} | -${reduction}% |`)
}
console.log('')

describe('Scaling — list length', () => {
  for (const n of [10, 100, 1000]) {
    const data = generateFeedData(n)
    bench(`${n} items: JSON.stringify`, () => {
      JSON.stringify({ data })
    })
    bench(`${n} items: encodeResponse`, () => {
      encodeResponse(data, feedTree, feedRootType, TEST_MANIFEST)
    })
  }
})

// === Scaling: request selection size ===

const userQuery = gql`query($id: ID!) { user(id: $id) { name } }`
const userFullQuery = gql`query($id: ID!) { user(id: $id) { age avatar bio email id isAdmin name } }`

describe('Scaling — request complexity', () => {
  bench('1 field selection', () => {
    encodeSelection(userQuery, TEST_MANIFEST)
  })
  bench('7 field selection', () => {
    encodeSelection(userFullQuery, TEST_MANIFEST)
  })
  bench('Nested with list', () => {
    encodeSelection(TIERS.deepNesting.query, TEST_MANIFEST)
  })
  bench('Multi-root', () => {
    encodeSelection(TIERS.multiRoot.query, TEST_MANIFEST)
  })
})
