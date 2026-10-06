import { createSlice, type PayloadAction } from "@reduxjs/toolkit"
import { VALKEY } from "@common/src/constants"
import type { ConnectionDetails } from "@/state/valkey-features/connection/connectionSlice"

export interface DiscoveredNode {
  host: string
  port: number
}

export type DiscoveryStatus = "pending" | "fulfilled" | "node_connecting" | "rejected"

export interface DiscoveryState {
  catalogId?: string
  catalogRevision?: string
  status: DiscoveryStatus
  connectionDetails: ConnectionDetails
  isPasswordEncrypted?: boolean
  clusterNodes?: Record<string, DiscoveredNode>
  errorMessage?: string
  nodeConnectionId?: string
}

export interface TopologyState {
  discoveries: Record<string, DiscoveryState>
}

const initialState: TopologyState = {
  discoveries: {},
}

const topologySlice = createSlice({
  name: VALKEY.TOPOLOGY.name,
  initialState,
  reducers: {
    discoveryEndpointPending: (
      state,
      action: PayloadAction<{ discoveryId: string; connectionDetails: ConnectionDetails; isPasswordEncrypted?: boolean; catalogId?: string }>,
    ) => {
      const { discoveryId, connectionDetails, isPasswordEncrypted } = action.payload
      state.discoveries[discoveryId] = {
        status: "pending",
        connectionDetails,
        isPasswordEncrypted,
        catalogId: action.payload.catalogId,
      }
    },
    discoveryEndpointFulfilled: (
      state,
      action: PayloadAction<{ discoveryId: string; clusterNodes: Record<string, DiscoveredNode>;
        connectionDetails?: ConnectionDetails; catalogRevision?: string }>,
    ) => {
      const { discoveryId, clusterNodes } = action.payload
      const entry = state.discoveries[discoveryId]
      if (!entry) return
      entry.status = "fulfilled"
      entry.clusterNodes = clusterNodes
      if (entry.catalogId && action.payload.connectionDetails) {
        entry.connectionDetails = { ...action.payload.connectionDetails, password: entry.connectionDetails.password }
        entry.catalogRevision = action.payload.catalogRevision
      }
      entry.errorMessage = undefined
    },
    discoveryEndpointRejected: (
      state,
      action: PayloadAction<{ discoveryId: string; errorMessage: string }>,
    ) => {
      const { discoveryId, errorMessage } = action.payload
      const entry = state.discoveries[discoveryId]
      if (!entry) return
      entry.status = "rejected"
      entry.errorMessage = errorMessage
      if (entry.catalogId) delete entry.connectionDetails.password
    },
    discoveryNodeConnecting: (
      state,
      action: PayloadAction<{ discoveryId: string; connectionId: string }>,
    ) => {
      const { discoveryId, connectionId } = action.payload
      const entry = state.discoveries[discoveryId]
      if (!entry) return
      entry.status = "node_connecting"
      entry.nodeConnectionId = connectionId
    },
    clearEndpointDiscovery: (state, action: PayloadAction<{ discoveryId: string }>) => {
      delete state.discoveries[action.payload.discoveryId]
    },
  },
})

export const {
  discoveryEndpointPending,
  discoveryEndpointFulfilled,
  discoveryEndpointRejected,
  discoveryNodeConnecting,
  clearEndpointDiscovery,
} = topologySlice.actions

export default topologySlice.reducer
