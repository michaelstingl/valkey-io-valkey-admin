import { createAction, type Store } from "@reduxjs/toolkit"
import { ignoreElements, tap } from "rxjs/operators"
import { action$, select } from "../middleware/rxjsMiddleware/rxjsMiddleware"
import { connectPending } from "../valkey-features/connection/connectionSlice"
import { selectPromptedConnection, type ConnectionPrompt } from "../valkey-features/connection/connectionSelectors"
import { clearEndpointDiscovery, discoveryEndpointPending } from "../valkey-features/topology/topologySlice"
import type { RootState } from "@/store"

export const passwordConnectionRequested = createAction<{
  prompt: ConnectionPrompt; discoveryId: string; username?: string; password: string; isPasswordEncrypted: boolean
}>("valkeyConnection/passwordConnectionRequested")

/** Resolve stable catalog identity and choose discovery or direct connect outside the component. */
export const passwordConnectionEpic = (store: Store<Pick<RootState, "valkeyConnection" | "valkeyTopology">>) => action$.pipe(
  select(passwordConnectionRequested),
  tap(({ payload: { prompt, discoveryId, username, password, isPasswordEncrypted } }) => {
    const connection = selectPromptedConnection(prompt)(store.getState())
    if (!connection) return
    const source = connection.sourceConnectionDetails ?? connection.connectionDetails
    const connectionDetails = { ...source, username: username ?? source.username, password }
    if (connection.preconfigured && connectionDetails.endpointType === "cluster-endpoint") {
      for (const [previousId, discovery] of Object.entries(store.getState().valkeyTopology.discoveries)) {
        if (discovery.catalogId === connection.catalogId) store.dispatch(clearEndpointDiscovery({ discoveryId: previousId }))
      }
      store.dispatch(discoveryEndpointPending({
        discoveryId, catalogId: connection.catalogId,
        connectionDetails, isPasswordEncrypted,
      }))
      return
    }
    const connectionId = Object.keys(store.getState().valkeyConnection.connections)
      .find((id) => store.getState().valkeyConnection.connections[id] === connection)
    if (!connectionId) return
    store.dispatch(connectPending({
      connectionId, catalogId: connection.catalogId, connectionDetails, isPasswordEncrypted,
      preservedHistory: connection.connectionHistory,
    }))
  }),
  ignoreElements(),
)
