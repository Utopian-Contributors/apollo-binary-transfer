import {
  type DocumentNode,
  type SelectionSetNode,
  type FieldNode,
  type InlineFragmentNode,
  type VariableDefinitionNode,
  type ArgumentNode,
  Kind,
  OperationTypeNode
} from 'graphql'
import type { BinaryTransferManifest } from './manifest.js'
import type { SelectionTree, SelectionNode } from './selection-encoder.js'

export function decodeSelection(
  tree: SelectionTree,
  operationType: 0 | 1,
  manifest: BinaryTransferManifest
): DocumentNode {
  const rootTypeName = operationType === 1
    ? manifest.roots.mutation!
    : manifest.roots.query

  const collectedVars = new Map<string, string>()
  const selectionSet = decodeSelectionSet(tree, rootTypeName, manifest, collectedVars)

  const variableDefinitions: VariableDefinitionNode[] = []
  for (const [varName, typeName] of collectedVars) {
    variableDefinitions.push({
      kind: Kind.VARIABLE_DEFINITION,
      variable: { kind: Kind.VARIABLE, name: { kind: Kind.NAME, value: varName } },
      type: parseTypeNode(typeName)
    })
  }

  return {
    kind: Kind.DOCUMENT,
    definitions: [{
      kind: Kind.OPERATION_DEFINITION,
      operation: operationType === 1
        ? OperationTypeNode.MUTATION
        : OperationTypeNode.QUERY,
      selectionSet,
      variableDefinitions
    }]
  }
}

function decodeSelectionSet(
  tree: SelectionTree,
  parentTypeName: string,
  manifest: BinaryTransferManifest,
  collectedVars: Map<string, string>
): SelectionSetNode {
  const parentType = manifest.types[parentTypeName]
  const selections: (FieldNode | InlineFragmentNode)[] = []

  for (const node of tree) {
    if (typeof node === 'number') {
      const field = parentType.fields[node]
      selections.push(makeFieldNode(field.name, field, collectedVars))
    } else if (Array.isArray(node)) {
      const [fieldIdx, sub] = node
      const field = parentType.fields[fieldIdx]

      if (field.isUnion && !Array.isArray(sub)) {
        const unionMembers = manifest.unions[field.type]
        const typeConditions: InlineFragmentNode[] = []

        // __typename FieldNode — needed so the server includes __typename in
        // the response, which the encoder uses to determine union type indices
        const typenameField: FieldNode = {
          kind: Kind.FIELD,
          name: { kind: Kind.NAME, value: '__typename' }
        } as FieldNode

        for (const [typeIdxStr, typeSub] of Object.entries(sub)) {
          const typeIdx = Number(typeIdxStr)
          const typeName = unionMembers[typeIdx]

          const innerSet = decodeSelectionSet(
            typeSub as SelectionTree,
            typeName,
            manifest,
            collectedVars
          )

          typeConditions.push({
            kind: Kind.INLINE_FRAGMENT,
            typeCondition: {
              kind: Kind.NAMED_TYPE,
              name: { kind: Kind.NAME, value: typeName }
            },
            selectionSet: {
              kind: Kind.SELECTION_SET,
              selections: [typenameField, ...innerSet.selections]
            }
          } as InlineFragmentNode)
        }

        selections.push({
          ...makeFieldNode(field.name, field, collectedVars),
          selectionSet: {
            kind: Kind.SELECTION_SET,
            selections: typeConditions
          }
        } as FieldNode)
      } else {
        selections.push({
          ...makeFieldNode(field.name, field, collectedVars),
          selectionSet: decodeSelectionSet(
            sub as SelectionTree,
            field.type,
            manifest,
            collectedVars
          )
        } as FieldNode)
      }
    }
  }

  return { kind: Kind.SELECTION_SET, selections }
}

function makeFieldNode(
  fieldName: string,
  field: { args?: Array<{ name: string; type: string }> },
  collectedVars: Map<string, string>
): FieldNode {
  const args: ArgumentNode[] = []

  if (field.args?.length) {
    for (const arg of field.args) {
      collectedVars.set(arg.name, arg.type)
      args.push({
        kind: Kind.ARGUMENT,
        name: { kind: Kind.NAME, value: arg.name },
        value: { kind: Kind.VARIABLE, name: { kind: Kind.NAME, value: arg.name } }
      })
    }
  }

  return {
    kind: Kind.FIELD,
    name: { kind: Kind.NAME, value: fieldName },
    arguments: args.length > 0 ? args : undefined
  } as FieldNode
}

/** Parse a GraphQL type string like "ID!", "[String]!", "[Int!]!" into a TypeNode. */
function parseTypeNode(typeStr: string): any {
  if (typeStr.endsWith('!')) {
    return {
      kind: Kind.NON_NULL_TYPE,
      type: parseTypeNode(typeStr.slice(0, -1))
    }
  }
  if (typeStr.startsWith('[') && typeStr.endsWith(']')) {
    return {
      kind: Kind.LIST_TYPE,
      type: parseTypeNode(typeStr.slice(1, -1))
    }
  }
  return {
    kind: Kind.NAMED_TYPE,
    name: { kind: Kind.NAME, value: typeStr }
  }
}
