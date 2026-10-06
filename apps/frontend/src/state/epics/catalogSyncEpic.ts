import { ignoreElements, tap } from "rxjs/operators"
import { CONNECTED, CONNECTING, DISCONNECTED, ERROR, RECONNECTING } from "@common/src/constants"
import { action$, select } from "../middleware/rxjsMiddleware/rxjsMiddleware"
import { catalogApplied, catalogEntryRemoved, catalogFulfilled, closeConnection } from "../valkey-features/connection/connectionSlice"
import { clearEndpointDiscovery } from "../valkey-features/topology/topologySlice"
import type { Store } from "@reduxjs/toolkit"
import type { RootState } from "@/store"
import history from "@/history"

/** Reconcile a complete snapshot, keeping unchanged sessions and all manual connections. */
export const catalogSyncEpic = (store: Store<Pick<RootState, "valkeyConnection" | "valkeyTopology">>) => action$.pipe(
  select(catalogFulfilled),
  tap(({ payload }) => {
    const incoming = new Map(payload.connections.map((entry) => [entry.catalogId ?? entry.connectionId, entry]))
    for (const [connectionId, entry] of Object.entries(store.getState().valkeyConnection.connections)) {
      if (!entry.preconfigured) continue
      const next = incoming.get(entry.catalogId ?? connectionId)
      if (next && next.revision === entry.catalogRevision) continue
      // Allow an in-flight connect to settle before closing it; the next poll reconciles it.
      if (entry.status === CONNECTING || entry.status === RECONNECTING) continue
      for (const [discoveryId, discovery] of Object.entries(store.getState().valkeyTopology.discoveries)) {
        if (discovery.catalogId === entry.catalogId) store.dispatch(clearEndpointDiscovery({ discoveryId }))
      }
      if (entry.status === CONNECTED || entry.status === DISCONNECTED || entry.status === ERROR) {
        store.dispatch(closeConnection({ connectionId, silent: true }))
      }
      store.dispatch(catalogEntryRemoved({ connectionId }))
      const clusterId = entry.connectionDetails.clusterId
      const remaining = Object.values(store.getState().valkeyConnection.connections)
      const path = history.location?.pathname ?? ""
      if (path.includes(connectionId)
        || (clusterId && path.includes(clusterId)
          && !remaining.some((connection) => connection.connectionDetails.clusterId === clusterId))) {
        history.navigate("/connect", { replace: true })
      }
    }
    store.dispatch(catalogApplied(payload))
  }),
  ignoreElements(),
)
