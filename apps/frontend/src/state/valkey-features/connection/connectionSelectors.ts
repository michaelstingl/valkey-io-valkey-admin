import * as R from "ramda"
import { VALKEY, CONNECTED, CONNECTING } from "@common/src/constants.ts"
import { MAX_CONNECTIONS } from "@common/src/constants.ts"
import type { RootState } from "@/store.ts"

export const atId = R.curry((id: string, state: RootState) => R.path([VALKEY.CONNECTION.name, "connections", id], state))

export const selectStatus = (id: string) => (state: RootState) => atId(id, state)?.status
export const selectConnectionDetails = (id: string) => (state: RootState) => atId(id, state)?.connectionDetails
export const selectConnections = (state: RootState) => state[VALKEY.CONNECTION.name].connections
export type ConnectionPrompt = { kind: "catalog" | "connection"; id: string }
export const selectPromptedConnection = (prompt: ConnectionPrompt | undefined) => (state: Pick<RootState, "valkeyConnection">) => {
  if (!prompt) return undefined
  const connections = state.valkeyConnection.connections
  return prompt.kind === "connection" ? connections[prompt.id]
    : Object.values(connections).find((connection) => connection.preconfigured && connection.catalogId === prompt.id)
}
export const selectPromptDiscovery = (discoveryId: string | undefined) => (state: Pick<RootState, "valkeyTopology">) =>
  discoveryId ? state.valkeyTopology.discoveries[discoveryId] : undefined
export const selectConnectionCount = (state: RootState) =>
  Object.values(selectConnections(state)).filter(
    (connection) => connection.status === CONNECTED,
  ).length

export const selectIsAtConnectionLimit = (state: RootState) => selectConnectionCount(state) >= MAX_CONNECTIONS
export const selectIsAnyConnecting = (state: RootState) =>
  Object.values(selectConnections(state)).some((c) => c.status === CONNECTING)
export const selectJsonModuleAvailable = (id: string) => (state: RootState) =>
  atId(id, state)?.connectionDetails?.jsonModuleAvailable ?? false
export const selectClusterPassword = (clusterId: string) => (state: RootState) => {
  const source = Object.values(state.valkeyConnection?.connections ?? {}).find(
    (c) => c.connectionDetails?.clusterId === clusterId && R.isNotNil(c.connectionDetails?.password),
  )
  if (!source) return undefined
  // Conservative default: an absent marker (e.g. a connection restored from
  // localStorage) is treated as unencrypted so reuse can never persist plaintext.
  return { password: source.connectionDetails.password, isPasswordEncrypted: source.isPasswordEncrypted ?? false }
}

export const selectClusterDb = (clusterId: string) => (state: RootState) =>
  Object.values(state.valkeyConnection?.connections ?? {}).find(
    (c) => c.connectionDetails?.clusterId === clusterId,
  )?.connectionDetails?.db ?? 0

export const selectClusterAlias = (id: string) => (state: RootState) =>
  atId(id, state)?.connectionDetails?.alias
