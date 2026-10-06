import { GlideClusterClient } from "@valkey/valkey-glide"
import { EndpointType, toNodeId, buildConnectionId } from "valkey-common"
import { VALKEY } from "valkey-common"
import { connectToValkey, getExistingConnection, teardownConnection  } from "../connection"
import { unsubscribe, getWatcherCount } from "../node-watchers"
import { type Deps, withDeps } from "./utils"
import { setClusterDashboardData } from "../set-dashboard-data"
import {
  authorizeConnection, isConnectionAuthorized, revokeConnection, hasAuthorizedSession, rememberCatalogNode, getCatalogNode, getCatalogDiscovery
} from "../session"

export interface ConnectionDetails {
  host: string;
  port: string;
  username?: string;
  password?: string;
  tls: boolean;
  verifyTlsCertificate: boolean;
  //TODO: Add handling and UI for uploading cert
  caCertPath?: string;
  endpointType: EndpointType;
  authType?: "password" | "iam" | "gcp-iam";
  awsRegion?: string;
  awsReplicationGroupId?: string;
  /**
   * Logical Valkey database index.
   */
  db: number;
}

type ConnectPayload = {
  catalogId?: string,
  discoveryId?: string,
  connectionDetails: ConnectionDetails,
  connectionId: string,
  isRetry?: boolean,
  isResume?: boolean,
}

export const connectPending = withDeps<Deps, void>(
  async ({ ws, clients, action, connectedNodesByCluster, metricsServerMap, clusterNodesRegistry, sessionId, catalog }) => {
    const payload = action.payload as ConnectPayload
    const { connectionId } = payload

    // ws.sessionId is assigned for every upgrade (ensureSession), so this is a defensive
    // invariant, not the expiry path (expiry is handled by isConnectionAuthorized returning
    // false because the session record is gone). Fail closed rather than connect without a
    // session to scope client reuse to.
    if (!sessionId) {
      ws.send(JSON.stringify({
        type: VALKEY.CONNECTION.connectRejected,
        payload: { connectionId, errorMessage: "Unable to establish a session. Please reload and try again.", requiresAuth: true },
      }))
      return
    }

    // if connection is being resumed, check if the session is still valid and if the connection exists
    if (payload.isResume && (!isConnectionAuthorized(sessionId, connectionId) || !clients.has(connectionId))) {
      ws.send(JSON.stringify({
        type: VALKEY.CONNECTION.connectRejected,
        payload: { connectionId, errorMessage: "Session expired. Please sign in again.", requiresAuth: true },
      }))
      return
    }

    // A retry reconnects an existing connection and (for clusters) closes + repoints the shared
    // client, so require ownership — same rule as resume. The frontend only retries connections it
    // previously established, so this never rejects a legitimate retry; it prevents one session's
    // retry from closing or repointing a connection another session owns (e.g. a same-endpoint
    // collision on a shared instance).
    if (payload.isRetry && !isConnectionAuthorized(sessionId, connectionId)) {
      ws.send(JSON.stringify({
        type: VALKEY.CONNECTION.connectRejected,
        payload: { connectionId, errorMessage: "Session expired. Please sign in again.", requiresAuth: true },
      }))
      return
    }

    const candidate = !payload.isResume && payload.catalogId !== undefined
      ? catalog?.find((entry) => (entry.catalogId ?? entry.connectionId) === payload.catalogId,
      )
      : undefined
    const discovery = candidate?.connectionDetails.endpointType === "cluster-endpoint"
      ? getCatalogDiscovery(sessionId, payload.catalogId!) : undefined
    const source = candidate && (candidate.connectionDetails.endpointType === "node"
      ? candidate.connectionId === connectionId
      : discovery?.node && discovery.discoveryId === payload.discoveryId && discovery.revision === candidate.revision
        && buildConnectionId(discovery.node.host, discovery.node.port, candidate.connectionDetails.db) === connectionId)
      ? candidate : undefined
    if (!payload.isResume && payload.catalogId !== undefined && !source) {
      ws.send(JSON.stringify({
        type: VALKEY.CONNECTION.connectRejected,
        payload: { connectionId, errorMessage: "Preconfigured connection changed or was removed. Please select it again." },
      }))
      return
    }
    const connectionPayload = source
      ? { ...payload, connectionDetails: {
        ...source.connectionDetails,
        ...(discovery?.node && { ...discovery.node, endpointType: "node" as const }),
        username: discovery?.node ? discovery.node.username : payload.connectionDetails.username ?? source.connectionDetails.username,
        password: payload.connectionDetails.password,
      } }
      : payload
    if (source && !payload.isRetry) {
      // Canonical settings must not label a previously authenticated client with a new revision.
      // Include DNS aliases in this check, matching connectToValkey's reuse rules.
      try {
        const existing = await getExistingConnection({ ...connectionPayload, sessionId }, clients)
        if (existing && getCatalogNode(sessionId, payload.catalogId!)?.revision !== source.revision) {
          ws.send(JSON.stringify({
            type: VALKEY.CONNECTION.connectRejected,
            payload: { connectionId, errorMessage: "Preconfigured connection changed. Disconnect the existing connection and try again." },
          }))
          return
        }
      } catch {
        ws.send(JSON.stringify({
          type: VALKEY.CONNECTION.connectRejected,
          payload: { connectionId, errorMessage: "Unable to resolve the preconfigured connection. Please try again." },
        }))
        return
      }
    }

    const client = await connectToValkey(
      { clients, connectedNodesByCluster, clusterNodesRegistry, metricsServerMap },
      ws,
      { ...connectionPayload, sessionId },
      source ? () => {
        if (discovery && getCatalogDiscovery(sessionId, payload.catalogId!) !== discovery) {
          throw new Error("Preconfigured connection attempt was superseded. Please select it again.")
        }
        authorizeConnection(sessionId, connectionId)
        authorizeConnection(sessionId, toNodeId(connectionId))
        rememberCatalogNode(sessionId, source.catalogId ?? source.connectionId, connectionPayload.connectionDetails, source.revision)
      } : undefined,
    )

    if (client) {
      if (discovery && getCatalogDiscovery(sessionId, payload.catalogId!) !== discovery) return
      authorizeConnection(sessionId, connectionId)
      authorizeConnection(sessionId, toNodeId(connectionId))
    }
  },
)

export const resetConnection = withDeps<Deps, void>(
  async ({ ws, connectionId, clients, action, clusterNodesRegistry }) => {
    const entry = clients.get(connectionId)

    if (!entry) {
      throw new Error("Client not found")
    }

    const { client } = entry

    const { clusterId } = action.payload as unknown as { clusterId: string }

    if (client instanceof GlideClusterClient) {
      await setClusterDashboardData(clusterId, client, ws, connectionId, clusterNodesRegistry)
    }
  },
)

export const closeConnection = withDeps<Deps, void>(
  async ({ ws, clients, action, metricsServerMap, connectedNodesByCluster, clusterNodesRegistry, sessionId }) => {
    const { connectionId } = action.payload
    const connection = clients.get(connectionId)
    const clusterId = connection?.clusterId

    revokeConnection(sessionId, connectionId)
    unsubscribe(connectionId, ws)

    // Always ack the requesting client — UI needs confirmation
    ws.send(JSON.stringify({
      type: VALKEY.CONNECTION.closeConnectionFulfilled,
      payload: { connectionId },
    }))

    // Don't tear down a shared connection another session still owns
    if (getWatcherCount(connectionId) > 0 || hasAuthorizedSession(connectionId)) {
      return
    }
    const nodes = connectedNodesByCluster.get(clusterId!)

    // Remove node from cluster map accordingly
    if (clusterId && nodes) {
      if (nodes.length === 1) {
        connectedNodesByCluster.delete(clusterId)
      } else {
        const index = nodes.indexOf(connectionId)
        if (index !== -1) {
          nodes.splice(index, 1)
        }
      }
    }
    teardownConnection(
      { clients, clusterNodesRegistry, metricsServerMap },
      connectionId,
    )
  },
)
