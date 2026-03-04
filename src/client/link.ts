import {
  ApolloLink,
  Observable,
  type Operation,
  type FetchResult
} from '@apollo/client/core'
import { type DocumentNode, type FieldNode, type FragmentDefinitionNode, Kind } from 'graphql'
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack'
import type { BinaryTransferManifest } from '../shared/manifest.js'
import { encodeSelection } from '../shared/selection-encoder.js'
import { rebuildResponse, type AliasMap } from '../shared/response-decoder.js'
import {
  MIME_BINARY,
  HEADER_SCHEMA_HASH,
  HEADER_ERRORS
} from '../shared/constants.js'

/**
 * Extract a JS value from a GraphQL AST literal value node.
 */
function extractLiteralValue(node: any): any {
  switch (node.kind) {
    case Kind.STRING: return node.value
    case Kind.INT: return parseInt(node.value, 10)
    case Kind.FLOAT: return parseFloat(node.value)
    case Kind.BOOLEAN: return node.value
    case Kind.NULL: return null
    case Kind.ENUM: return node.value
    case Kind.LIST: return node.values.map(extractLiteralValue)
    case Kind.OBJECT: {
      const obj: Record<string, any> = {}
      for (const field of node.fields) {
        obj[field.name.value] = extractLiteralValue(field.value)
      }
      return obj
    }
    default: return null
  }
}

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

    const remapped = this.remapVariables(operation.query, operation.variables ?? {})
    if (Object.keys(remapped).length > 0) {
      requestBody.v = remapped
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
   * Remap operation variables to counter-based names (v0, v1, ...) that match
   * the server decoder's variable naming. Both sides walk the selection tree
   * in the same deterministic order, so the counter values align.
   */
  private remapVariables(
    document: DocumentNode,
    variables: Record<string, any>
  ): Record<string, any> {
    const remapped: Record<string, any> = {}
    const fragments = new Map<string, FragmentDefinitionNode>()

    for (const def of document.definitions) {
      if (def.kind === Kind.FRAGMENT_DEFINITION) {
        fragments.set(def.name.value, def)
      }
    }

    const operation = document.definitions.find(
      d => d.kind === Kind.OPERATION_DEFINITION
    )
    if (!operation || operation.kind !== Kind.OPERATION_DEFINITION) return variables

    const operationType = operation.operation === 'mutation' ? 1 : 0
    const rootTypeName = operationType === 1
      ? this.manifest.roots.mutation!
      : this.manifest.roots.query

    const counter = { value: 0 }
    this.collectArgValues(
      operation.selectionSet.selections,
      rootTypeName,
      variables,
      remapped,
      fragments,
      counter
    )

    return remapped
  }

  private collectArgValues(
    selections: readonly any[],
    parentTypeName: string,
    originalVars: Record<string, any>,
    remapped: Record<string, any>,
    fragments: Map<string, FragmentDefinitionNode>,
    counter: { value: number }
  ): void {
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
        const fieldDef = parentType.fields[idx]

        // Build AST arg lookup for this field
        const astArgMap = new Map<string, any>()
        if (field.arguments) {
          for (const astArg of field.arguments) {
            astArgMap.set(astArg.name.value, astArg)
          }
        }

        // Iterate ALL manifest args in order (matching the decoder's counter)
        if (fieldDef.args?.length) {
          for (const manifestArg of fieldDef.args) {
            const varName = `v${counter.value++}`
            const astArg = astArgMap.get(manifestArg.name)
            if (astArg) {
              if (astArg.value.kind === Kind.VARIABLE) {
                const originalVarName = (astArg.value as any).name.value
                if (originalVarName in originalVars) {
                  remapped[varName] = originalVars[originalVarName]
                }
              } else {
                remapped[varName] = extractLiteralValue(astArg.value)
              }
            }
          }
        }

        // Recurse into sub-selections
        if (fieldDef.isComposite && field.selectionSet) {
          if (fieldDef.isUnion) {
            // Sort union type conditions by type index to match decoder's
            // Object.entries order (numeric keys in ascending order)
            const unionMembers = this.manifest.unions[fieldDef.type]
            const typeConditions: Array<{
              typeIdx: number
              typeName: string
              selections: readonly any[]
            }> = []

            for (const subSel of field.selectionSet.selections) {
              if (subSel.kind === Kind.INLINE_FRAGMENT && subSel.typeCondition) {
                const typeName = subSel.typeCondition.name.value
                const typeIdx = unionMembers.indexOf(typeName)
                if (typeIdx !== -1) {
                  typeConditions.push({
                    typeIdx,
                    typeName,
                    selections: subSel.selectionSet.selections
                  })
                }
              }
              if (subSel.kind === Kind.FRAGMENT_SPREAD) {
                const frag = fragments.get(subSel.name.value)
                if (frag?.typeCondition) {
                  const typeName = frag.typeCondition.name.value
                  const typeIdx = unionMembers.indexOf(typeName)
                  if (typeIdx !== -1) {
                    typeConditions.push({
                      typeIdx,
                      typeName,
                      selections: frag.selectionSet.selections
                    })
                  }
                }
              }
            }

            typeConditions.sort((a, b) => a.typeIdx - b.typeIdx)

            for (const { typeName, selections: sels } of typeConditions) {
              this.collectArgValues(
                sels,
                typeName,
                originalVars,
                remapped,
                fragments,
                counter
              )
            }
          } else {
            this.collectArgValues(
              field.selectionSet.selections,
              fieldDef.type,
              originalVars,
              remapped,
              fragments,
              counter
            )
          }
        }
      } else if (sel.kind === Kind.INLINE_FRAGMENT) {
        this.collectArgValues(
          sel.selectionSet.selections,
          sel.typeCondition?.name.value ?? parentTypeName,
          originalVars,
          remapped,
          fragments,
          counter
        )
      } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
        const frag = fragments.get(sel.name.value)
        if (frag) {
          this.collectArgValues(
            frag.selectionSet.selections,
            frag.typeCondition.name.value,
            originalVars,
            remapped,
            fragments,
            counter
          )
        }
      }
    }
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
