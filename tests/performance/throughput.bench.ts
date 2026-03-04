import { describe, bench } from 'vitest'
import { print } from 'graphql'
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack'
import { encodeSelection } from '../../src/shared/selection-encoder'
import { decodeSelection } from '../../src/shared/selection-decoder'
import { flattenResponse, encodeResponse } from '../../src/shared/response-encoder'
import { rebuildResponse } from '../../src/shared/response-decoder'
import { TEST_MANIFEST } from '../fixtures/manifest'
import { TIERS } from './fixtures'

// Pre-compute all tier data
const tierData = Object.entries(TIERS).map(([key, tier]) => {
  const { tree, operationType } = encodeSelection(tier.query, TEST_MANIFEST)
  const rootTypeName = operationType === 1
    ? TEST_MANIFEST.roots.mutation!
    : TEST_MANIFEST.roots.query

  const flat = flattenResponse(tier.data, tree, rootTypeName, TEST_MANIFEST)
  const encoded = encodeResponse(tier.data, tree, rootTypeName, TEST_MANIFEST)
  const jsonStr = JSON.stringify({ data: tier.data })

  return {
    key,
    name: tier.name,
    query: tier.query,
    data: tier.data,
    tree,
    operationType,
    rootTypeName,
    flat,
    encoded,
    jsonStr
  }
})

describe('encodeSelection throughput', () => {
  for (const t of tierData) {
    bench(`${t.name}`, () => {
      encodeSelection(t.query, TEST_MANIFEST)
    })
  }
})

describe('decodeSelection throughput', () => {
  for (const t of tierData) {
    bench(`${t.name}`, () => {
      decodeSelection(t.tree, t.operationType as 0 | 1, TEST_MANIFEST)
    })
  }
})

describe('flattenResponse throughput', () => {
  for (const t of tierData) {
    bench(`${t.name}: flattenResponse`, () => {
      flattenResponse(t.data, t.tree, t.rootTypeName, TEST_MANIFEST)
    })

    bench(`${t.name}: JSON.stringify (baseline)`, () => {
      JSON.stringify(t.data)
    })
  }
})

describe('rebuildResponse throughput', () => {
  for (const t of tierData) {
    bench(`${t.name}: rebuildResponse`, () => {
      rebuildResponse(t.flat, t.tree, t.rootTypeName, TEST_MANIFEST)
    })

    bench(`${t.name}: JSON.parse (baseline)`, () => {
      JSON.parse(t.jsonStr)
    })
  }
})

describe('msgpack encode/decode throughput', () => {
  for (const t of tierData) {
    bench(`${t.name}: msgpackEncode`, () => {
      msgpackEncode(t.flat)
    })

    bench(`${t.name}: msgpackDecode`, () => {
      msgpackDecode(t.encoded)
    })
  }
})

describe('Full pipeline throughput', () => {
  for (const t of tierData) {
    bench(`${t.name}: client encode pipeline`, () => {
      const { tree, operationType } = encodeSelection(t.query, TEST_MANIFEST)
      msgpackEncode({ s: tree, o: operationType, v: {} })
    })

    bench(`${t.name}: server decode+encode pipeline`, () => {
      const doc = decodeSelection(t.tree, t.operationType as 0 | 1, TEST_MANIFEST)
      print(doc)
      flattenResponse(t.data, t.tree, t.rootTypeName, TEST_MANIFEST)
    })

    bench(`${t.name}: client decode pipeline`, () => {
      rebuildResponse(t.flat, t.tree, t.rootTypeName, TEST_MANIFEST)
    })
  }
})
