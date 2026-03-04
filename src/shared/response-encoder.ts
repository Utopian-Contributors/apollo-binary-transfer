import { encode as msgpackEncode } from '@msgpack/msgpack'
import type { BinaryTransferManifest } from './manifest.js'
import type { SelectionTree, SelectionNode } from './selection-encoder.js'

export const NULL_OBJECT = 0xC1

export function flattenResponse(
  data: Record<string, any>,
  tree: SelectionTree,
  rootTypeName: string,
  manifest: BinaryTransferManifest
): any[] {
  const values: any[] = []

  function walk(
    obj: any,
    selection: SelectionTree,
    typeName: string
  ): void {
    const type = manifest.types[typeName]

    for (const node of selection) {
      if (typeof node === 'number') {
        // Leaf
        const field = type.fields[node]
        values.push(obj?.[field.name] ?? null)
      } else if (Array.isArray(node)) {
        const [fieldIdx, sub] = node
        const field = type.fields[fieldIdx]
        const val = obj?.[field.name]

        if (val === null || val === undefined) {
          values.push(NULL_OBJECT)
        } else if (field.isList && Array.isArray(val)) {
          values.push(val.length)

          if (field.isUnion) {
            const unionMembers = manifest.unions[field.type]
            for (const item of val) {
              const itemTypeName = item.__typename
              const typeIdx = unionMembers.indexOf(itemTypeName)
              values.push(typeIdx)
              const typeSub = (sub as Record<number, SelectionTree>)[typeIdx]
              if (typeSub) walk(item, typeSub, itemTypeName)
            }
          } else {
            walkColumnar(val, sub as SelectionTree, field.type)
          }
        } else if (field.isUnion) {
          // Single union value (non-list)
          const unionMembers = manifest.unions[field.type]
          const itemTypeName = val.__typename
          const typeIdx = unionMembers.indexOf(itemTypeName)
          values.push(typeIdx)
          const typeSub = (sub as Record<number, SelectionTree>)[typeIdx]
          if (typeSub) walk(val, typeSub, itemTypeName)
        } else {
          // Composite object
          walk(val, sub as SelectionTree, field.type)
        }
      }
    }
  }

  function walkColumnar(
    items: any[],
    selection: SelectionTree,
    typeName: string
  ): void {
    const type = manifest.types[typeName]

    for (const node of selection) {
      if (typeof node === 'number') {
        // Leaf column: push all items' values for this field
        const field = type.fields[node]
        for (const item of items) {
          values.push(item?.[field.name] ?? null)
        }
      } else if (Array.isArray(node)) {
        const [fieldIdx, sub] = node
        const field = type.fields[fieldIdx]

        // Composite column: process per-item
        for (const item of items) {
          const val = item?.[field.name]

          if (val === null || val === undefined) {
            values.push(NULL_OBJECT)
          } else if (field.isList && Array.isArray(val)) {
            values.push(val.length)

            if (field.isUnion) {
              const unionMembers = manifest.unions[field.type]
              for (const unionItem of val) {
                const itemTypeName = unionItem.__typename
                const typeIdx = unionMembers.indexOf(itemTypeName)
                values.push(typeIdx)
                const typeSub = (sub as Record<number, SelectionTree>)[typeIdx]
                if (typeSub) walk(unionItem, typeSub, itemTypeName)
              }
            } else {
              walkColumnar(val, sub as SelectionTree, field.type)
            }
          } else if (field.isUnion) {
            const unionMembers = manifest.unions[field.type]
            const itemTypeName = val.__typename
            const typeIdx = unionMembers.indexOf(itemTypeName)
            values.push(typeIdx)
            const typeSub = (sub as Record<number, SelectionTree>)[typeIdx]
            if (typeSub) walk(val, typeSub, itemTypeName)
          } else {
            walk(val, sub as SelectionTree, field.type)
          }
        }
      }
    }
  }

  walk(data, tree, rootTypeName)
  return values
}

export function encodeResponse(
  data: Record<string, any>,
  tree: SelectionTree,
  rootTypeName: string,
  manifest: BinaryTransferManifest
): Uint8Array {
  return msgpackEncode(flattenResponse(data, tree, rootTypeName, manifest))
}
