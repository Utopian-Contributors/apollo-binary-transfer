import type {
  ApolloServerPlugin,
  GraphQLRequestListener,
  BaseContext
} from '@apollo/server'
import { print, Kind } from 'graphql'
import { decode as msgpackDecode } from '@msgpack/msgpack'
import type { BinaryTransferManifest } from '../shared/manifest.js'
import type { SelectionTree } from '../shared/selection-encoder.js'
import { decodeSelection } from '../shared/selection-decoder.js'
import { encodeResponse } from '../shared/response-encoder.js'
import { computeSchemaHash } from '../shared/schema-hash.js'
import {
  MIME_BINARY,
  HEADER_SCHEMA_HASH,
  HEADER_ERRORS,
  HEADER_BT_VERSION,
  BT_VERSION
} from '../shared/constants.js'

export interface BinaryTransferPluginOptions {
  manifest: BinaryTransferManifest

  /**
   * Max size (bytes) for the X-GraphQL-Errors header.
   * If errors exceed this, the response falls back to JSON.
   * Default: 8192.
   */
  maxErrorHeaderSize?: number
}

export function BinaryTransferPlugin(
  options: BinaryTransferPluginOptions
): ApolloServerPlugin<BaseContext> {
  const { manifest } = options
  const maxErrSize = options.maxErrorHeaderSize ?? 8192
  let liveSchemaHash = ''

  return {
    async serverWillStart({ schema }) {
      liveSchemaHash = computeSchemaHash(schema)

      if (liveSchemaHash !== manifest.schemaHash) {
        console.warn(
          `[apollo-binary-transfer] Schema hash mismatch.\n` +
          `  Manifest: ${manifest.schemaHash}\n` +
          `  Live:     ${liveSchemaHash}\n` +
          `  Positional encoding may be incorrect. Regenerate the manifest.`
        )
      }

      return {
        schemaDidLoadOrUpdate({ apiSchema }: any) {
          liveSchemaHash = computeSchemaHash(apiSchema)
        },
        async serverWillStop() {}
      }
    },

    async requestDidStart({ request }) {
      const httpBody = (request.http as any)?.body ?? {}
      const isBinaryRequest = request.http?.headers
        .get('content-type')
        ?.includes(MIME_BINARY) ?? false
      const wantsBinaryResponse = request.http?.headers
        .get('accept')
        ?.includes(MIME_BINARY) ?? false

      let selectionTree: SelectionTree | undefined
      let rootTypeName: string | undefined

      if (isBinaryRequest) {
        try {
          // Access raw body: set by expressBinaryMiddleware on req.body.__rawBody,
          // then threaded to request.http.body.__rawBody by Apollo Server
          const rawBody = httpBody.__rawBody as Uint8Array
          const decoded = msgpackDecode(rawBody) as any

          selectionTree = decoded.s as SelectionTree
          const operationType = (decoded.o ?? 0) as 0 | 1
          rootTypeName = operationType === 1
            ? manifest.roots.mutation
            : manifest.roots.query

          // Reconstruct the DocumentNode and inject it
          const doc = decodeSelection(selectionTree, operationType, manifest)

          // Prune variable definitions and field arguments that the client
          // didn't provide values for. The decoder creates variables for ALL
          // manifest args, but the client only sends values for args it uses.
          const providedVars = new Set(Object.keys(decoded.v ?? {}))
          pruneUnprovidedVars(doc, providedVars)

          request.query = print(doc)

          // Pass through variables
          if (decoded.v) {
            request.variables = decoded.v
          }
        } catch (err) {
          console.warn('[apollo-binary-transfer] Failed to decode binary request:', err)
        }
      }

      return {
        async willSendResponse({ response }) {
          const httpRes = response.http!
          httpRes.headers.set(HEADER_BT_VERSION, BT_VERSION)
          httpRes.headers.set(HEADER_SCHEMA_HASH, liveSchemaHash)

          if (
            !wantsBinaryResponse ||
            !selectionTree ||
            !rootTypeName ||
            response.body.kind !== 'single'
          ) return

          const { data, errors } = response.body.singleResult
          if (!data) return

          try {
            const binary = encodeResponse(data, selectionTree, rootTypeName, manifest)

            if (errors?.length) {
              const errJson = JSON.stringify(errors)
              if (Buffer.byteLength(errJson) > maxErrSize) return  // JSON fallback
              httpRes.headers.set(HEADER_ERRORS, errJson)
            }

            httpRes.headers.set('content-type', MIME_BINARY)
            // Stash on the request body (which is req.body in Express) so
            // expressBinaryMiddleware can intercept and send binary bytes
            httpBody.__binaryResponseBody = binary
          } catch (err) {
            console.warn('[apollo-binary-transfer] Encoding failed, JSON fallback:', err)
          }
        }
      } satisfies GraphQLRequestListener<BaseContext>
    }
  }
}

/**
 * Remove variable definitions and field arguments from the reconstructed
 * DocumentNode that don't have corresponding values in the provided variables.
 * This prevents GraphQL validation errors for optional args with defaults
 * that the client didn't explicitly provide.
 */
function pruneUnprovidedVars(doc: any, provided: Set<string>): void {
  const opDef = doc.definitions[0]
  if (opDef.variableDefinitions) {
    opDef.variableDefinitions = opDef.variableDefinitions.filter(
      (vd: any) => provided.has(vd.variable.name.value)
    )
  }
  if (opDef.selectionSet) {
    pruneFieldArgs(opDef.selectionSet, provided)
  }
}

function pruneFieldArgs(selectionSet: any, provided: Set<string>): void {
  for (const sel of selectionSet.selections) {
    if (sel.kind === Kind.FIELD) {
      if (sel.arguments) {
        sel.arguments = sel.arguments.filter(
          (arg: any) => arg.value.kind !== Kind.VARIABLE || provided.has(arg.value.name.value)
        )
        if (sel.arguments.length === 0) sel.arguments = undefined
      }
      if (sel.selectionSet) pruneFieldArgs(sel.selectionSet, provided)
    } else if (sel.kind === Kind.INLINE_FRAGMENT) {
      if (sel.selectionSet) pruneFieldArgs(sel.selectionSet, provided)
    }
  }
}

export function expressBinaryMiddleware() {
  return (req: any, res: any, next: any) => {
    // Intercept outgoing response: if the plugin stashed binary data on
    // req.body.__binaryResponseBody, send it as raw bytes instead of JSON.
    const originalSend = res.send
    res.send = function (body: any) {
      const binaryBody = req.body?.__binaryResponseBody as Uint8Array | undefined
      if (binaryBody) {
        delete req.body.__binaryResponseBody
        res.set('content-type', MIME_BINARY)
        return originalSend.call(this, Buffer.from(binaryBody))
      }
      return originalSend.call(this, body)
    }

    // Handle incoming binary request
    const ct = req.headers['content-type'] ?? ''
    if (ct.includes(MIME_BINARY)) {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks)
        // Store raw body for the plugin and set empty body for Apollo
        req.body = { __rawBody: rawBody }
        next()
      })
    } else {
      next()
    }
  }
}
