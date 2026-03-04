import { type DocumentNode, type FieldNode, type FragmentDefinitionNode, Kind } from 'graphql'
import type { BinaryTransferManifest, ManifestType } from './manifest.js'

export type SelectionNode =
  | number
  | [number, SelectionNode[]]
  | [number, Record<number, SelectionNode[]>]

export type SelectionTree = SelectionNode[]

export function encodeSelection(
  document: DocumentNode,
  manifest: BinaryTransferManifest
): { tree: SelectionTree; operationType: 0 | 1 } {
  const fragments = new Map<string, FragmentDefinitionNode>()

  for (const def of document.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(def.name.value, def)
    }
  }

  const operation = document.definitions.find(
    d => d.kind === Kind.OPERATION_DEFINITION
  )
  if (!operation || operation.kind !== Kind.OPERATION_DEFINITION) {
    throw new Error('No operation definition found')
  }

  const operationType = operation.operation === 'mutation' ? 1 as const : 0 as const
  const rootTypeName = operationType === 1
    ? manifest.roots.mutation!
    : manifest.roots.query

  const tree = encodeSelectionSet(
    operation.selectionSet.selections,
    rootTypeName,
    manifest,
    fragments
  )

  return { tree, operationType }
}

function encodeSelectionSet(
  selections: readonly any[],
  parentTypeName: string,
  manifest: BinaryTransferManifest,
  fragments: Map<string, FragmentDefinitionNode>
): SelectionTree {
  const parentType = manifest.types[parentTypeName]
  if (!parentType) throw new Error(`Unknown type: ${parentTypeName}`)

  const fieldIndex = new Map<string, number>()
  parentType.fields.forEach((f, i) => fieldIndex.set(f.name, i))

  const result: SelectionTree = []

  for (const sel of selections) {
    switch (sel.kind) {
      case Kind.FIELD: {
        const field = sel as FieldNode
        const name = field.name.value
        if (name === '__typename') continue

        const idx = fieldIndex.get(name)
        if (idx === undefined) throw new Error(`Unknown field: ${name} on ${parentTypeName}`)

        const fieldDef = parentType.fields[idx]

        if (!fieldDef.isComposite || !field.selectionSet) {
          result.push(idx)
        } else if (fieldDef.isUnion) {
          const typeSelections: Record<number, SelectionTree> = {}
          const unionMembers = manifest.unions[fieldDef.type]

          for (const subSel of field.selectionSet.selections) {
            if (subSel.kind === Kind.INLINE_FRAGMENT && subSel.typeCondition) {
              const typeName = subSel.typeCondition.name.value
              const typeIdx = unionMembers.indexOf(typeName)
              if (typeIdx === -1) throw new Error(`Unknown union member: ${typeName}`)

              typeSelections[typeIdx] = encodeSelectionSet(
                subSel.selectionSet.selections,
                typeName,
                manifest,
                fragments
              )
            }
            if (subSel.kind === Kind.FRAGMENT_SPREAD) {
              const frag = fragments.get(subSel.name.value)
              if (frag?.typeCondition) {
                const typeName = frag.typeCondition.name.value
                const typeIdx = unionMembers.indexOf(typeName)
                if (typeIdx !== -1) {
                  typeSelections[typeIdx] = encodeSelectionSet(
                    frag.selectionSet.selections,
                    typeName,
                    manifest,
                    fragments
                  )
                }
              }
            }
          }

          result.push([idx, typeSelections])
        } else {
          const subTree = encodeSelectionSet(
            field.selectionSet.selections,
            fieldDef.type,
            manifest,
            fragments
          )
          result.push([idx, subTree])
        }
        break
      }

      case Kind.INLINE_FRAGMENT: {
        const subNodes = encodeSelectionSet(
          sel.selectionSet.selections,
          sel.typeCondition?.name.value ?? parentTypeName,
          manifest,
          fragments
        )
        result.push(...subNodes)
        break
      }

      case Kind.FRAGMENT_SPREAD: {
        const frag = fragments.get(sel.name.value)
        if (frag) {
          const subNodes = encodeSelectionSet(
            frag.selectionSet.selections,
            frag.typeCondition.name.value,
            manifest,
            fragments
          )
          result.push(...subNodes)
        }
        break
      }
    }
  }

  return result
}
