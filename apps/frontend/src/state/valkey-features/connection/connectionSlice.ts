import { createAction, createSlice, type PayloadAction } from "@reduxjs/toolkit"
import {
  CONNECTED,
  CONNECTING,
  DISCONNECTING,
  DISCONNECTED,
  ERROR,
  LOCAL_STORAGE,
  NOT_CONNECTED,
  RECONNECTING,
  VALKEY,
  type KeyEvictionPolicy,
  type EndpointType
} from "@common/src/constants"
import * as R from "ramda"
import type { CatalogConnection } from "@common/src/connection-catalog"
import type { NodeRole } from "@/state/valkey-features/cluster/clusterSlice"
import { secureStorage } from "@/utils/secureStorage"

type ConnectionStatus =
  | typeof NOT_CONNECTED | typeof CONNECTED | typeof CONNECTING | typeof RECONNECTING
  | typeof ERROR | typeof DISCONNECTED | typeof DISCONNECTING

export interface ConnectionDetails {
  host: string;
  port: string;
  username?: string;
  password?: string;
  tls: boolean;
  verifyTlsCertificate: boolean
  //TODO: Add handling and UI for uploading cert
  caCertPath?: string
  alias?: string;
  role?: NodeRole;
  clusterId?: string;
  // Eviction policy required for getting hot keys using hot slots
  keyEvictionPolicy?: KeyEvictionPolicy;
  clusterSlotStatsEnabled?: boolean
  // JSON module availability check
  jsonModuleAvailable?: boolean;
  endpointType: EndpointType
  authType?: "password" | "iam" | "gcp-iam"
  awsRegion?: string
  awsReplicationGroupId?: string
  /**
   * Logical Valkey database index.
   */
  db: number
  /**
   * Server-configured database count learned from the server on connect.
   */
  databasesCount?: number
}

interface ReconnectState {
  isRetrying: boolean;
  currentAttempt: number;
  maxRetries: number;
  nextRetryDelay?: number;
}

interface ConnectionHistoryEntry {
  timestamp: number;
  event: "Connected";
}

export interface ConnectionState {
  /** Metadata supplied by the server catalog; does not grant session authorization. */
  preconfigured?: true;
  catalogId?: string;
  catalogRevision?: string;
  sourceConnectionDetails?: CatalogConnection["connectionDetails"];
  status: ConnectionStatus;
  errorMessage: string | null;
  connectionDetails: ConnectionDetails;
  searchableText: string;
  reconnect?: ReconnectState;
  connectionHistory?: ConnectionHistoryEntry[];
  wasEdit?: boolean;
  userDisconnected?: boolean;
  isPasswordEncrypted?: boolean;
  // Set when a connect is automatic (refresh resume / socket-drop reconnect)
  autoConnect?: boolean;
}

export interface ValkeyConnectionsState {
  [connectionId: string]: ConnectionState
}

// determine a connections eligibility for auto-resume
export const isAutoResumeEligible = (connection: ConnectionState): boolean => {
  if (connection.preconfigured) return false
  const { status, connectionHistory, userDisconnected, connectionDetails } = connection
  if (status === CONNECTED || status === CONNECTING) return false
  if ((connectionHistory?.length ?? 0) === 0) return false
  if (userDisconnected) return false

  const { password, authType } = connectionDetails
  if (authType === "iam" || authType === "gcp-iam" || (R.isNotNil(password) && R.isEmpty(password)))
    return status !== DISCONNECTED
  return R.isNil(password)
}

const buildSearchableText = (connectionId: string, details: ConnectionDetails) =>
  [connectionId, details.host, details.port, details.username, details.alias]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()

const currentConnections = R.pipe(
  (v: string) => localStorage.getItem(v),
  // Older payloads written before `db` existed deserialize without it. Parse
  // through a "persisted" shape that allows `db?: number`, then normalize once
  // here so every downstream consumer can rely on `connectionDetails.db` being
  // a number.
  (s) => (s === null
    ? {}
    : JSON.parse(s) as Record<string, ConnectionState & {
      connectionDetails: Omit<ConnectionDetails, "db"> & { db?: number };
    }>),
  R.mapObjIndexed((conn): ConnectionState => {
    const normalized: ConnectionState = {
      ...conn,
      connectionDetails: {
        ...conn.connectionDetails,
        db: conn.connectionDetails.db ?? 0,
      },
    }
    return isAutoResumeEligible(normalized)
      ? { ...normalized, status: RECONNECTING }
      : normalized
  }),
)(LOCAL_STORAGE.VALKEY_CONNECTIONS)

const connectionSlice = createSlice({
  name: VALKEY.CONNECTION.name,
  initialState: {
    connections: currentConnections as ValkeyConnectionsState,
  },
  reducers: {
    /**
     * catalogSyncEpic removes changed entries before applying the snapshot,
     * except in-flight attempts. Preserve the state of entries still present.
     */
    catalogApplied: (state, action: PayloadAction<{ connections: CatalogConnection[] }>) => {
      for (const entry of action.payload.connections) {
        const { connectionId, connectionDetails, sourceConnectionDetails = connectionDetails, catalogId = connectionId, revision } = entry
        const existing = Object.values(state.connections).find((entry) => entry.preconfigured && entry.catalogId === catalogId)
        if (existing) {
          // Display changes must not overwrite the resolved node or its live session state.
          if (existing.connectionDetails.alias !== connectionDetails.alias) {
            existing.connectionDetails.alias = connectionDetails.alias
            if (existing.sourceConnectionDetails) existing.sourceConnectionDetails.alias = connectionDetails.alias
            existing.searchableText = buildSearchableText(connectionId, existing.connectionDetails)
          }
          continue
        }
        // Preserve existing connections and pending connection attempts.
        if (state.connections[connectionId] || Object.values(state.connections).some((entry) => entry.catalogId === catalogId)) continue
        state.connections[connectionId] = {
          preconfigured: true,
          catalogId,
          catalogRevision: revision,
          sourceConnectionDetails,
          status: NOT_CONNECTED,
          errorMessage: null,
          connectionDetails,
          searchableText: buildSearchableText(connectionId, connectionDetails),
          connectionHistory: [],
        }
      }
    },
    catalogEntryRemoved: (state, action: PayloadAction<{ connectionId: string }>) => {
      delete state.connections[action.payload.connectionId]
    },
    catalogNodeResolved: (state, action: PayloadAction<{
      catalogId: string; connectionId: string; connectionDetails: ConnectionDetails;
      sourceConnectionDetails?: CatalogConnection["connectionDetails"]; revision?: string
    }>) => {
      const { catalogId, connectionId, connectionDetails } = action.payload
      const source = Object.entries(state.connections).find(([, entry]) => entry.preconfigured && entry.catalogId === catalogId)
      if (!source || (state.connections[connectionId] && source[0] !== connectionId)) return
      const [sourceId, entry] = source
      delete state.connections[sourceId]
      state.connections[connectionId] = {
        ...entry,
        ...(action.payload.revision !== undefined && { catalogRevision: action.payload.revision }),
        ...(action.payload.sourceConnectionDetails && { sourceConnectionDetails: action.payload.sourceConnectionDetails }),
        connectionDetails: { ...entry.connectionDetails, host: connectionDetails.host, port: connectionDetails.port, endpointType: "node" },
        searchableText: buildSearchableText(connectionId, connectionDetails),
      }
    },
    connectPending: (
      state,
      action: PayloadAction<{
        connectionId: string;
        catalogId?: string;
        discoveryId?: string;
        connectionDetails: ConnectionDetails;
        isRetry?: boolean;
        isResume?: boolean;
        isEdit?: boolean;
        isPasswordEncrypted?: boolean;
        autoConnect?: boolean;
        preservedHistory?: ConnectionHistoryEntry[];
      }>,
    ) => {
      const {
        connectionId,
        connectionDetails,
        isRetry = false,
        isEdit = false,
        isPasswordEncrypted,
        autoConnect = false,
        preservedHistory,
      } = action.payload
      const existingConnection = state.connections[connectionId]

      state.connections[connectionId] = {
        ...(existingConnection?.preconfigured && (action.payload.catalogId === existingConnection.catalogId
          || action.payload.isResume || isRetry || autoConnect) && {
          preconfigured: true, catalogId: existingConnection.catalogId, catalogRevision: existingConnection.catalogRevision,
          sourceConnectionDetails: existingConnection.sourceConnectionDetails,
        }),
        status: CONNECTING,
        errorMessage: isRetry && existingConnection?.errorMessage ? existingConnection.errorMessage : null,
        connectionDetails: {
          ...connectionDetails,
          // Preserve "" (no-password connections) but strip real passwords if secure storage is unavailable
          password: (R.isNotNil(connectionDetails.password) && secureStorage.isElectron()) || R.isEmpty(connectionDetails.password)
            ? connectionDetails.password
            : undefined,
          clusterSlotStatsEnabled: false,
          jsonModuleAvailable: false,
        },
        searchableText: buildSearchableText(connectionId, connectionDetails),
        wasEdit: isEdit,
        // Re-dispatches (retry/resume/auto-reconnect) omit the flag but carry the
        // same in-memory password, so keep the existing marking.
        isPasswordEncrypted: isPasswordEncrypted ?? existingConnection?.isPasswordEncrypted,
        autoConnect,
        ...(isRetry && existingConnection?.reconnect && {
          reconnect: existingConnection.reconnect,
        }),
        // for preserving connection history - use preserved history if provided, otherwise existing
        connectionHistory: preservedHistory || existingConnection?.connectionHistory,
      }
    },
    standaloneConnectFulfilled: (
      state,
      action: PayloadAction<{
        connectionId: string;
        connectionDetails: ConnectionDetails;
      }>,
    ) => {
      const { connectionId, connectionDetails } = action.payload
      const connectionState = state.connections[connectionId]
      if (connectionState) {
        connectionState.status = CONNECTED
        connectionState.errorMessage = null

        if (connectionDetails) {
          connectionState.connectionDetails.keyEvictionPolicy = connectionDetails.keyEvictionPolicy
          connectionState.connectionDetails.jsonModuleAvailable = connectionDetails.jsonModuleAvailable ??
          connectionState.connectionDetails.jsonModuleAvailable
          connectionState.connectionDetails.databasesCount = connectionDetails.databasesCount ??
          connectionState.connectionDetails.databasesCount
        }

        connectionState.connectionHistory ??= []
        connectionState.connectionHistory.push({
          timestamp: Date.now(),
          event: CONNECTED,
        })
        delete connectionState.wasEdit
      }
    },
    clusterConnectFulfilled: (state, action) => {
      const { connectionId, connectionDetails } = action.payload
      const { clusterId, keyEvictionPolicy, clusterSlotStatsEnabled, jsonModuleAvailable, databasesCount } = connectionDetails

      const connectionState = state.connections[connectionId]
      connectionState.status = CONNECTED
      connectionState.errorMessage = null
      connectionState.connectionDetails.clusterId = clusterId
      connectionState.connectionDetails.keyEvictionPolicy = keyEvictionPolicy
      connectionState.connectionDetails.clusterSlotStatsEnabled = clusterSlotStatsEnabled
      connectionState.connectionDetails.jsonModuleAvailable = jsonModuleAvailable
      connectionState.connectionDetails.databasesCount = databasesCount ??
      connectionState.connectionDetails.databasesCount
      delete connectionState.reconnect
      connectionState.connectionHistory ??= []
      connectionState.connectionHistory.push({ timestamp: Date.now(), event: CONNECTED })
      delete connectionState.wasEdit
    },
    connectRejected: (state, action) => {
      const { connectionId, errorMessage, requiresAuth } = action.payload
      const existingConnection = state.connections[connectionId]
      if (!existingConnection) return
      if (requiresAuth) {
        existingConnection.status = NOT_CONNECTED
        existingConnection.errorMessage = null
        return
      }

      const isRetrying = existingConnection.reconnect?.isRetrying
      existingConnection.status = ERROR
      // Preserve original error message during retry attempts
      if (!(isRetrying && existingConnection.errorMessage)) {
        existingConnection.errorMessage = errorMessage || "Valkey error: Unable to connect."
      }
    },
    startRetry: (state, action) => {
      const { connectionId, attempt, maxRetries, nextRetryDelay } = action.payload
      if (state.connections[connectionId]) {
        state.connections[connectionId].reconnect = {
          isRetrying: true,
          currentAttempt: attempt,
          maxRetries,
          nextRetryDelay,
        }
      }
    },
    stopRetry: (state, action) => {
      const { connectionId } = action.payload
      if (state.connections[connectionId]?.reconnect) {
        state.connections[connectionId].reconnect!.isRetrying = false
      }
    },
    connectionBroken: (state, action) => {
      const { connectionId } = action.payload
      if (state.connections[connectionId]) {
        state.connections[connectionId].status = DISCONNECTED
        state.connections[connectionId].errorMessage = "Connection lost"
      }
    },
    closeConnection: (state, action) => {
      const { connectionId } = action.payload
      state.connections[connectionId].status = DISCONNECTING
      state.connections[connectionId].errorMessage = null
      state.connections[connectionId].userDisconnected = true
    },
    closeConnectionFulfilled: (state, action) => {
      const { connectionId } = action.payload
      if (state.connections[connectionId]) {
        state.connections[connectionId].status = NOT_CONNECTED
      }

    },
    closeConnectionFailed: (state, action) => {
      const { connectionId, errorMessage } = action.payload
      state.connections[connectionId].status = ERROR
      state.connections[connectionId].errorMessage = errorMessage
    },
    updateConnectionDetails: (state, action) => {
      const { connectionId, ...details } = action.payload
      const merged = {
        ...state.connections[connectionId].connectionDetails,
        ...details,
      }
      state.connections[connectionId].connectionDetails = merged
      state.connections[connectionId].searchableText = buildSearchableText(connectionId, merged)
    },
    deleteConnection: (state, { payload: { connectionId } }) => {
      return R.dissocPath(["connections", connectionId], state)
    },
  },
})

export default connectionSlice.reducer
export const catalogFulfilled = createAction<{ connections: CatalogConnection[] }>(VALKEY.CONNECTION.catalogFulfilled)
export const {
  catalogApplied,
  catalogEntryRemoved,
  catalogNodeResolved,
  connectPending,
  standaloneConnectFulfilled,
  clusterConnectFulfilled,
  connectRejected,
  connectionBroken,
  closeConnection,
  updateConnectionDetails,
  deleteConnection,
  closeConnectionFulfilled,
  closeConnectionFailed,
  startRetry,
  stopRetry,
} = connectionSlice.actions
