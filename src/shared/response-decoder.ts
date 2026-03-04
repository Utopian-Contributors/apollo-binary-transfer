import { decode as msgpackDecode } from '@msgpack/msgpack'
import type { BinaryTransferManifest } from './manifest.js'
import type { SelectionTree, SelectionNode } from './selection-encoder.js'
import { NULL_OBJECT } from './response-encoder.js'

/**
 * Alias map: maps [parentTypeName, fieldIndex] → alias string.
 * Built by the client link from the original DocumentNode.
 * If a field has no alias, it uses the schema field name.
 */
export type AliasMap = Map<string, Map<number, string>>

export function rebuildResponse(
  values: any[],
  tree: SelectionTree,
  rootTypeName: string,
  manifest: BinaryTransferManifest,
  aliases?: AliasMap
): Record<string, any> {
  let cursor = 0
  function read(): any { return values[cursor++] }

  function build(
    selection: SelectionTree,
    typeName: string
  ): Record<string, any> {
    const type = manifest.types[typeName]
    const obj: Record<string, any> = {}

    // Inject __typename for Apollo Client cache normalization
    obj.__typename = typeName

    for (const node of selection) {
      if (typeof node === 'number') {
        const field = type.fields[node]
        const key = aliases?.get(typeName)?.get(node) ?? field.name
        obj[key] = read()
      } else if (Array.isArray(node)) {
        const [fieldIdx, sub] = node
        const field = type.fields[fieldIdx]
        const key = aliases?.get(typeName)?.get(fieldIdx) ?? field.name
        const val = read()

        if (val === NULL_OBJECT) {
          obj[key] = null
        } else if (field.isList && typeof val === 'number') {
          const length = val

          if (field.isUnion) {
            const arr: any[] = []
            const unionMembers = manifest.unions[field.type]
            for (let i = 0; i < length; i++) {
              const typeIdx = read() as number
              const memberTypeName = unionMembers[typeIdx]
              const typeSub = (sub as Record<number, SelectionTree>)[typeIdx]
              const item = typeSub
                ? build(typeSub, memberTypeName)
                : {}
              item.__typename = memberTypeName
              arr.push(item)
            }
            obj[key] = arr
          } else {
            obj[key] = buildList(length, sub as SelectionTree, field.type)
          }
        } else if (field.isUnion) {
          const unionMembers = manifest.unions[field.type]
          const typeIdx = val as number
          const memberTypeName = unionMembers[typeIdx]
          const typeSub = (sub as Record<number, SelectionTree>)[typeIdx]
          const item = typeSub
            ? build(typeSub, memberTypeName)
            : {}
          item.__typename = memberTypeName
          obj[key] = item
        } else {
          // Non-list, non-union composite: val was the first value of the nested object
          // Put it back and recurse
          cursor--
          obj[key] = build(sub as SelectionTree, field.type)
        }
      }
    }

    return obj
  }

  function buildList(
    length: number,
    selection: SelectionTree,
    typeName: string
  ): Record<string, any>[] {
    const type = manifest.types[typeName]
    const items: Record<string, any>[] = Array.from({ length }, () => ({ __typename: typeName }))

    for (const node of selection) {
      if (typeof node === 'number') {
        // Leaf column: read N values
        const field = type.fields[node]
        const key = aliases?.get(typeName)?.get(node) ?? field.name
        for (let i = 0; i < length; i++) {
          items[i][key] = read()
        }
      } else if (Array.isArray(node)) {
        const [fieldIdx, sub] = node
        const field = type.fields[fieldIdx]
        const key = aliases?.get(typeName)?.get(fieldIdx) ?? field.name

        // Composite column: process per-item
        for (let i = 0; i < length; i++) {
          const val = read()

          if (val === NULL_OBJECT) {
            items[i][key] = null
          } else if (field.isList && typeof val === 'number') {
            const nestedLength = val

            if (field.isUnion) {
              const arr: any[] = []
              const unionMembers = manifest.unions[field.type]
              for (let j = 0; j < nestedLength; j++) {
                const typeIdx = read() as number
                const memberTypeName = unionMembers[typeIdx]
                const typeSub = (sub as Record<number, SelectionTree>)[typeIdx]
                const item = typeSub
                  ? build(typeSub, memberTypeName)
                  : {}
                item.__typename = memberTypeName
                arr.push(item)
              }
              items[i][key] = arr
            } else {
              items[i][key] = buildList(nestedLength, sub as SelectionTree, field.type)
            }
          } else if (field.isUnion) {
            const unionMembers = manifest.unions[field.type]
            const typeIdx = val as number
            const memberTypeName = unionMembers[typeIdx]
            const typeSub = (sub as Record<number, SelectionTree>)[typeIdx]
            const item = typeSub
              ? build(typeSub, memberTypeName)
              : {}
            item.__typename = memberTypeName
            items[i][key] = item
          } else {
            // Non-list, non-union composite: put value back and recurse
            cursor--
            items[i][key] = build(sub as SelectionTree, field.type)
          }
        }
      }
    }

    return items
  }

  return build(tree, rootTypeName)
}

export function decodeResponse(
  buffer: Uint8Array,
  tree: SelectionTree,
  rootTypeName: string,
  manifest: BinaryTransferManifest,
  aliases?: AliasMap
): Record<string, any> {
  const values = msgpackDecode(buffer) as any[]
  return rebuildResponse(values, tree, rootTypeName, manifest, aliases)
}
