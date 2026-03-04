import { gzipSync } from 'node:zlib'
import { encode as msgpackEncode } from '@msgpack/msgpack'
import { print } from 'graphql'
import { bench, describe } from 'vitest'
import { encodeResponse } from '../../src/shared/response-encoder'
import { encodeSelection } from '../../src/shared/selection-encoder'
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
  const jsonGzipSize = gzipSync(jsonResponse).byteLength

  const binaryResponse = encodeResponse(tier.data, tree, rootTypeName, TEST_MANIFEST)
  const binaryResponseSize = binaryResponse.byteLength
  const binaryGzipSize = gzipSync(binaryResponse).byteLength

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
    jsonGzipSize,
    binaryResponseSize,
    binaryGzipSize,
    requestReduction: ((1 - binaryRequestSize / queryTextSize) * 100).toFixed(1),
    responseReduction: ((1 - binaryResponseSize / jsonResponseSize) * 100).toFixed(1),
    jsonGzipReduction: ((1 - jsonGzipSize / jsonResponseSize) * 100).toFixed(1),
    binaryGzipReduction: ((1 - binaryGzipSize / jsonResponseSize) * 100).toFixed(1),
    binaryGzipVsJsonGzip: ((1 - binaryGzipSize / jsonGzipSize) * 100).toFixed(1)
  }
})

// Print summary tables
console.log('\n=== Wire Size: Uncompressed ===')
console.log('| Tier | JSON Resp | Binary Resp | Reduction |')
console.log('|---|---|---|---|')
for (const t of tierData) {
  console.log(`| ${t.name} | ${t.jsonResponseSize}B | ${t.binaryResponseSize}B | -${t.responseReduction}% |`)
}

console.log('\n=== Wire Size: With Gzip ===')
console.log('| Tier | JSON | JSON+gzip | Binary | Binary+gzip | Binary+gzip vs JSON+gzip |')
console.log('|---|---|---|---|---|---|')
for (const t of tierData) {
  console.log(`| ${t.name} | ${t.jsonResponseSize}B | ${t.jsonGzipSize}B (-${t.jsonGzipReduction}%) | ${t.binaryResponseSize}B | ${t.binaryGzipSize}B (-${t.binaryGzipReduction}%) | -${t.binaryGzipVsJsonGzip}% |`)
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

describe('Response size — JSON+gzip vs binary+gzip', () => {
  for (const t of tierData) {
    bench(`${t.name}: JSON+gzip (${t.jsonGzipSize}B)`, () => {
      gzipSync(JSON.stringify({ data: t.data }))
    })

    bench(`${t.name}: binary+gzip (${t.binaryGzipSize}B, -${t.binaryGzipVsJsonGzip}% vs JSON+gzip)`, () => {
      gzipSync(encodeResponse(t.data, t.tree, t.rootTypeName, TEST_MANIFEST))
    })
  }
})
