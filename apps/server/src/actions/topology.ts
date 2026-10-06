import { VALKEY } from "valkey-common"
import { discoverTopology } from "../connection"
import { type ConnectionDetails } from "./connection"
import { type Deps, withDeps } from "./utils"
import { beginCatalogDiscovery, getCatalogDiscovery } from "../session"

type DiscoveryPayload = {
  catalogId?: string
  discoveryId: string
  connectionDetails: ConnectionDetails
}

export const topologyDiscoveryEndpointPending = withDeps<Deps, void>(
  async ({ ws, action, catalog, sessionId }) => {
    const payload = action.payload as unknown as DiscoveryPayload
    const source = catalog?.find((entry) => (entry.catalogId ?? entry.connectionId) === payload.catalogId)
    const attempt = source && beginCatalogDiscovery(sessionId, payload.catalogId!, payload.discoveryId, source.revision)
    if (payload.catalogId !== undefined && (!source || !attempt)) {
      ws.send(JSON.stringify({ type: VALKEY.TOPOLOGY.discoveryEndpointRejected, payload: {
        discoveryId: payload.discoveryId, errorMessage: "Preconfigured connection changed or was removed. Please select it again.",
      } }))
      return
    }
    // For preconfigured Discovery Endpoints, use connection details from the server catalog.
    // Only credentials come from the user. Never accept a client-supplied node binding.
    const connectionDetails = source
      ? { ...source.connectionDetails,
        username: payload.connectionDetails.username ?? source.connectionDetails.username,
        password: payload.connectionDetails.password }
      : payload.connectionDetails
    await discoverTopology(ws, { ...payload, connectionDetails, catalogRevision: source?.revision }, source ? (nodes) => {
      if (getCatalogDiscovery(sessionId, payload.catalogId!) !== attempt) return false
      const firstNode = Object.values(nodes)[0]
      attempt!.node = { host: firstNode.host, port: String(firstNode.port), username: connectionDetails.username }
      return true
    } : undefined)
  },
)
