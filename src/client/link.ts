import {
  ApolloLink,
  Observable,
  type Operation,
  type FetchResult
} from '@apollo/client/core'
import { type DocumentNode, type FieldNode, Kind } from 'graphql'
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack'
import type { BinaryTransferManifest } from '../shared/manifest.js'
import { encodeSelection } from '../shared/selection-encoder.js'
import { rebuildResponse, type AliasMap } from '../shared/response-decoder.js'
import {
  MIME_BINARY,
  HEADER_SCHEMA_HASH,
  HEADER_ERRORS
} from '../shared/constants.js'

export interface BinaryTransferLinkOptions {
  uri: string
  manifest: BinaryTransferManifest
  fetch?: typeof globalThis.fetch
  headers?: Record<string, string> | (() => Record<string, string>)
  credentials?: RequestCredentials
  onDecodingFailure?: 'error' | 'warn'
}

export class BinaryTransferLink extends ApolloLink {
  private uri: string
  private manifest: BinaryTransferManifest
  private fetchFn: typeof globalThis.fetch
  private headersFn: () => Record<string, string>
  private credentials: RequestCredentials
  private onFailure: 'error' | 'warn'

  constructor(options: BinaryTransferLinkOptions) {
    super()
    this.uri = options.uri
    this.manifest = options.manifest
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.credentials = options.credentials ?? 'same-origin'
    this.onFailure = options.onDecodingFailure ?? 'error'

    if (typeof options.headers === 'function') {
      this.headersFn = options.headers
    } else {
      const h = options.headers ?? {}
      this.headersFn = () => h
    }
  }

  request(operation: Operation): Observable<FetchResult> {
    return new Observable<FetchResult>(observer => {
      this.execute(operation)
        .then(result => { observer.next(result); observer.complete() })
        .catch(err => observer.error(err))
    })
  }

  private async execute(operation: Operation): Promise<FetchResult> {
    const { tree, operationType } = encodeSelection(
      operation.query,
      this.manifest
    )

    const aliases = this.extractAliases(operation.query)

    const requestBody: any = {
      s: tree,
      o: operationType
    }

    if (operation.variables && Object.keys(operation.variables).length > 0) {
      requestBody.v = operation.variables
    }

    const binaryBody = msgpackEncode(requestBody)

    const headers: Record<string, string> = {
      'content-type': MIME_BINARY,
      'accept': `${MIME_BINARY}, application/graphql-response+json`,
      ...this.headersFn()
    }

    const res = await this.fetchFn(this.uri, {
      method: 'POST',
      headers,
      credentials: this.credentials,
      body: binaryBody
    })

    // Schema drift detection
    const serverSchemaHash = res.headers.get(HEADER_SCHEMA_HASH)
    if (serverSchemaHash && serverSchemaHash !== this.manifest.schemaHash) {
      console.warn(
        `[apollo-binary-transfer] Schema drift detected.\n` +
        `  Client: ${this.manifest.schemaHash}\n` +
        `  Server: ${serverSchemaHash}\n` +
        `  Regenerate the manifest.`
      )
    }

    const contentType = res.headers.get('content-type') ?? ''

    if (contentType.includes(MIME_BINARY)) {
      try {
        const buffer = new Uint8Array(await res.arrayBuffer())
        const rootTypeName = operationType === 1
          ? this.manifest.roots.mutation!
          : this.manifest.roots.query

        const data = rebuildResponse(
          msgpackDecode(buffer) as any[],
          tree,
          rootTypeName,
          this.manifest,
          aliases
        )

        const errHeader = res.headers.get(HEADER_ERRORS)
        const errors = errHeader ? JSON.parse(errHeader) : undefined

        return { data, errors }
      } catch (err) {
        if (this.onFailure === 'warn') {
          console.warn('[apollo-binary-transfer] Decode failed:', err)
        }
        throw new Error(
          `[apollo-binary-transfer] Failed to decode response: ${err}`
        )
      }
    }

    if (contentType.includes('json')) {
      return await res.json() as FetchResult
    }

    throw new Error(
      `[apollo-binary-transfer] Unexpected content-type: ${contentType}`
    )
  }

  /**
   * Walks the DocumentNode and builds a map of aliases.
   * Key: "TypeName" → Map<fieldIndex, aliasName>
   * If no aliases exist, returns undefined (skip the overhead).
   */
  private extractAliases(document: DocumentNode): AliasMap | undefined {
    let hasAliases = false
    const map: AliasMap = new Map()
    const fragments = new Map<string, any>()

    for (const def of document.definitions) {
      if (def.kind === Kind.FRAGMENT_DEFINITION) {
        fragments.set(def.name.value, def)
      }
    }

    const operation = document.definitions.find(
      d => d.kind === Kind.OPERATION_DEFINITION
    )
    if (!operation || operation.kind !== Kind.OPERATION_DEFINITION) return undefined

    const operationType = operation.operation === 'mutation' ? 1 : 0
    const rootTypeName = operationType === 1
      ? this.manifest.roots.mutation!
      : this.manifest.roots.query

    const walkSelections = (
      selections: readonly any[],
      parentTypeName: string
    ) => {
      const parentType = this.manifest.types[parentTypeName]
      if (!parentType) return

      const fieldIndex = new Map<string, number>()
      parentType.fields.forEach((f, i) => fieldIndex.set(f.name, i))

      for (const sel of selections) {
        if (sel.kind === Kind.FIELD) {
          const field = sel as FieldNode
          const name = field.name.value
          if (name === '__typename') continue

          const idx = fieldIndex.get(name)
          if (idx === undefined) continue

          if (field.alias) {
            hasAliases = true
            if (!map.has(parentTypeName)) {
              map.set(parentTypeName, new Map())
            }
            map.get(parentTypeName)!.set(idx, field.alias.value)
          }

          const fieldDef = parentType.fields[idx]
          if (fieldDef.isComposite && field.selectionSet) {
            if (fieldDef.isUnion) {
              for (const subSel of field.selectionSet.selections) {
                if (subSel.kind === Kind.INLINE_FRAGMENT && subSel.typeCondition) {
                  walkSelections(subSel.selectionSet.selections, subSel.typeCondition.name.value)
                }
                if (subSel.kind === Kind.FRAGMENT_SPREAD) {
                  const frag = fragments.get(subSel.name.value)
                  if (frag?.typeCondition) {
                    walkSelections(frag.selectionSet.selections, frag.typeCondition.name.value)
                  }
                }
              }
            } else {
              walkSelections(field.selectionSet.selections, fieldDef.type)
            }
          }
        } else if (sel.kind === Kind.INLINE_FRAGMENT) {
          walkSelections(
            sel.selectionSet.selections,
            sel.typeCondition?.name.value ?? parentTypeName
          )
        } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
          const frag = fragments.get(sel.name.value)
          if (frag) {
            walkSelections(frag.selectionSet.selections, frag.typeCondition.name.value)
          }
        }
      }
    }

    walkSelections(operation.selectionSet.selections, rootTypeName)

    return hasAliases ? map : undefined
  }
}
