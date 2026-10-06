import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { buildConnectionId, isValidDatabaseIndex, type CatalogConnection } from "valkey-common"
import { isConnectionAuthorized, getCatalogNode } from "./session"

export function getSessionConnectionCatalog(
  catalog: CatalogConnection[], sessionId: string | undefined, activeConnectionIds: ReadonlySet<string>,
): CatalogConnection[] {
  return catalog.map((connection) => {
    const catalogId = connection.catalogId ?? connection.connectionId
    const node = getCatalogNode(sessionId, catalogId)
    const nodeConnectionId = node && buildConnectionId(node.host, node.port, connection.connectionDetails.db)
    if (node && nodeConnectionId && node.revision === connection.revision
      && isConnectionAuthorized(sessionId, nodeConnectionId) && activeConnectionIds.has(nodeConnectionId)) {
      return {
        ...connection,
        catalogId,
        connectionId: nodeConnectionId,
        sourceConnectionDetails: connection.connectionDetails,
        connectionDetails: { ...connection.connectionDetails, host: node.host, port: node.port,
          username: node.username ?? connection.connectionDetails.username, endpointType: "node" as const },
        resumeAvailable: true,
      }
    }
    return {
      ...connection,
      // Endpoint authorization alone cannot prove this catalog revision was authenticated.
      resumeAvailable: false,
    }
  })
}

/** Parse connection metadata without credentials; catalog IDs distinguish replaced entries. */
export function parseConnectionCatalog(input: unknown): CatalogConnection[] {
  if (!Array.isArray(input)) throw new Error("Connection catalog must be an array")
  const connectionIds = new Set<string>()
  const catalogIds = new Set<string>()
  return input.map((value: unknown) => {
    if (!value || typeof value !== "object") throw new Error("Invalid connection catalog entry")
    const entry = value as Record<string, unknown>
    if (entry.id !== undefined && (typeof entry.id !== "string" || !entry.id.trim())) throw new Error("Invalid catalog ID")
    const { host, port, alias, username, tls = false, verifyTlsCertificate = true, endpointType = "node", db = 0 } = entry
    if (typeof host !== "string" || !host.trim() || host !== host.trim()
      || typeof port !== "string" || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535
      || !isValidDatabaseIndex(db)
      || (alias !== undefined && typeof alias !== "string")
      || (username !== undefined && typeof username !== "string")
      || typeof tls !== "boolean" || typeof verifyTlsCertificate !== "boolean"
      || (endpointType !== "node" && endpointType !== "cluster-endpoint")) {
      throw new Error("Invalid connection catalog metadata")
    }
    const canonicalPort = String(Number(port))
    const connectionId = buildConnectionId(host, canonicalPort, db)
    const catalogId = entry.id as string | undefined
    const sourceId = catalogId ?? connectionId
    if (catalogIds.has(sourceId)) throw new Error("Duplicate catalog ID")
    catalogIds.add(sourceId)
    if (connectionIds.has(connectionId)) throw new Error("Duplicate connection ID in catalog")
    connectionIds.add(connectionId)
    // Positive allowlist: never spread input, even when it contains credential fields.
    return {
      connectionId,
      ...(catalogId && { catalogId }),
      revision: createHash("sha256")
        .update(JSON.stringify([host, canonicalPort, username, tls, verifyTlsCertificate, endpointType, db])).digest("hex"),
      connectionDetails: {
        host, port: canonicalPort, alias, username, tls, verifyTlsCertificate, endpointType, db,
        authType: "password",
      },
    }
  })
}

export function loadConnectionCatalog(file: string | undefined, mode: string | undefined): CatalogConnection[] {
  if (!file || mode !== "Web") return []
  return parseConnectionCatalog(JSON.parse(readFileSync(file, "utf8")))
}

/** Share a snapshot across requests, refreshing at most once per second and retaining it on read errors. */
export function createConnectionCatalogReader(file: string | undefined, mode: string | undefined) {
  let catalog = loadConnectionCatalog(file, mode)
  let nextReadAt = performance.now() + 1000
  let failed = false
  return () => {
    const now = performance.now()
    if (now < nextReadAt) return catalog
    nextReadAt = now + 1000
    try {
      catalog = loadConnectionCatalog(file, mode)
      failed = false
    } catch {
      if (!failed) console.warn("Catalog refresh failed; retaining the last good snapshot")
      failed = true
    }
    return catalog
  }
}
