import {
  type GraphQLSchema,
  type GraphQLField,
  isObjectType,
  isUnionType,
  isInterfaceType,
  isCompositeType,
  isListType,
  isNonNullType,
  getNamedType,
  isUnionType as isUnionTypeCheck
} from 'graphql'
import { MANIFEST_VERSION } from './constants.js'
import { computeSchemaHash } from './schema-hash.js'

export interface BinaryTransferManifest {
  /** Protocol version. Must be 1. */
  version: 1

  /** Truncated SHA-256 of the sorted schema SDL. */
  schemaHash: string

  /**
   * Every object type and interface in the schema.
   * Keys are type names. Fields within each type are alphabetically sorted.
   * The array index IS the positional index used on the wire.
   */
  types: Record<string, ManifestType>

  /**
   * Union types: map of union name → alphabetically sorted member type names.
   * The array index IS the type discriminator used on the wire.
   */
  unions: Record<string, string[]>

  /**
   * The root operation type names.
   */
  roots: {
    query: string
    mutation?: string
  }
}

export interface ManifestType {
  /** Alphabetically sorted fields. Index = wire position. */
  fields: ManifestField[]
}

export interface ManifestField {
  /** Field name in the schema. */
  name: string

  /**
   * The named type (unwrapped from list/non-null).
   * For scalars: "String", "Int", "Boolean", "ID", "Float", or custom scalar name.
   * For objects: the type name (key into manifest.types).
   * For enums: the enum name.
   */
  type: string

  /** True if the unwrapped type is an object/interface type (has sub-fields). */
  isComposite: boolean

  /** True if the field's type is a list (possibly nested). */
  isList: boolean

  /** True if the field (or list) is nullable. */
  isNullable: boolean

  /** True if this field is a union type. */
  isUnion: boolean

  /** Arguments, alphabetically sorted. Only present if the field takes arguments. */
  args?: ManifestArg[]
}

export interface ManifestArg {
  name: string
  type: string
  defaultValue?: any
}

export function generateManifest(schema: GraphQLSchema): BinaryTransferManifest {
  const schemaHash = computeSchemaHash(schema)
  const manifest: BinaryTransferManifest = {
    version: MANIFEST_VERSION,
    schemaHash,
    types: {},
    unions: {},
    roots: {
      query: schema.getQueryType()?.name ?? 'Query'
    }
  }

  const mutationType = schema.getMutationType()
  if (mutationType) {
    manifest.roots.mutation = mutationType.name
  }

  const typeMap = schema.getTypeMap()

  for (const [typeName, type] of Object.entries(typeMap)) {
    if (typeName.startsWith('__')) continue

    if (isObjectType(type) || isInterfaceType(type)) {
      const fields = Object.values(type.getFields())
        .sort((a, b) => a.name.localeCompare(b.name))

      manifest.types[typeName] = {
        fields: fields.map(field => buildManifestField(field))
      }
    }

    if (isUnionType(type)) {
      manifest.unions[typeName] = type.getTypes()
        .map(t => t.name)
        .sort((a, b) => a.localeCompare(b))
    }
  }

  return manifest
}

function buildManifestField(field: GraphQLField<any, any>): ManifestField {
  const namedType = getNamedType(field.type)
  const composite = isCompositeType(namedType)
  const union = isUnionTypeCheck(namedType)

  let isList = false
  let isNullable = true
  let unwrapped = field.type

  if (isNonNullType(unwrapped)) {
    isNullable = false
    unwrapped = unwrapped.ofType
  }
  if (isListType(unwrapped)) {
    isList = true
  }

  const result: ManifestField = {
    name: field.name,
    type: namedType.name,
    isComposite: composite,
    isList,
    isNullable,
    isUnion: union
  }

  if (field.args.length > 0) {
    result.args = field.args
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(arg => ({
        name: arg.name,
        type: arg.type.toString(),
        ...(arg.defaultValue !== undefined ? { defaultValue: arg.defaultValue } : {})
      }))
  }

  return result
}

export { computeSchemaHash }
