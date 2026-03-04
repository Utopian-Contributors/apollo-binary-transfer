import { describe, bench } from 'vitest'
import { print } from 'graphql'
import { encode as msgpackEncode } from '@msgpack/msgpack'
import { encodeSelection } from '../../src/shared/selection-encoder'
import { flattenResponse, encodeResponse } from '../../src/shared/response-encoder'
import { TEST_MANIFEST } from '../fixtures/manifest'
import { TIERS } from './fixtures'

// Pre-compute all tier data
const tierData = Object.entries(TIERS).map(([key, tier]) => {
  const { tree, operationType } = encodeSelection(tier.query, TEST_MANIFEST)
  const rootTypeName = operationType === 1
    ? TEST_MANIFEST.roots.mutation!
    : TEST_MANIFEST.roots.query

  const queryText = JSON.stringify({
    query: print(tier.query),
    variables: tier.variables
  })
  const queryTextSize = Buffer.byteLength(queryText)

  const binaryRequest = msgpackEncode({
    s: tree,
    o: operationType,
    ...(tier.variables ? { v: tier.variables } : {})
  })
  const binaryRequestSize = binaryRequest.byteLength

  const jsonResponse = JSON.stringify({ data: tier.data })
  const jsonResponseSize = Buffer.byteLength(jsonResponse)

  const binaryResponse = encodeResponse(tier.data, tree, rootTypeName, TEST_MANIFEST)
  const binaryResponseSize = binaryResponse.byteLength

  return {
    key,
    name: tier.name,
    tree,
    operationType,
    rootTypeName,
    data: tier.data,
    queryTextSize,
    binaryRequestSize,
    jsonResponseSize,
    binaryResponseSize,
    requestReduction: ((1 - binaryRequestSize / queryTextSize) * 100).toFixed(1),
    responseReduction: ((1 - binaryResponseSize / jsonResponseSize) * 100).toFixed(1)
  }
})

// Print summary table
console.log('\n=== Wire Size Summary ===')
console.log('| Tier | Query Text | Binary Req | Req Reduction | JSON Resp | Binary Resp | Resp Reduction |')
console.log('|---|---|---|---|---|---|---|')
for (const t of tierData) {
  console.log(
    `| ${t.name} | ${t.queryTextSize}B | ${t.binaryRequestSize}B | -${t.requestReduction}% | ${t.jsonResponseSize}B | ${t.binaryResponseSize}B | -${t.responseReduction}% |`
  )
}
console.log('')

describe('Request size — query text vs positional selection', () => {
  for (const t of tierData) {
    bench(`${t.name}: query text (${t.queryTextSize}B)`, () => {
      JSON.stringify({ query: print(TIERS[t.key as keyof typeof TIERS].query), variables: TIERS[t.key as keyof typeof TIERS].variables })
    })

    bench(`${t.name}: binary selection (${t.binaryRequestSize}B, -${t.requestReduction}%)`, () => {
      msgpackEncode({ s: t.tree, o: t.operationType, v: TIERS[t.key as keyof typeof TIERS].variables })
    })
  }
})

describe('Response size — JSON vs binary', () => {
  for (const t of tierData) {
    bench(`${t.name}: JSON (${t.jsonResponseSize}B)`, () => {
      JSON.stringify({ data: t.data })
    })

    bench(`${t.name}: binary (${t.binaryResponseSize}B, -${t.responseReduction}%)`, () => {
      encodeResponse(t.data, t.tree, t.rootTypeName, TEST_MANIFEST)
    })
  }
})
