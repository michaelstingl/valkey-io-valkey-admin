import { filter, ignoreElements, tap } from "rxjs/operators"
import { DISCONNECTED, NOT_CONNECTED } from "@common/src/constants"
import { action$, select } from "../middleware/rxjsMiddleware/rxjsMiddleware"
import { catalogApplied, connectPending } from "../valkey-features/connection/connectionSlice"
import type { Store } from "@reduxjs/toolkit"
import type { RootState } from "@/store"

/** Resume eligible connections through the existing session authorization checks. */
export const catalogResumeEpic = (store: Store<Pick<RootState, "valkeyConnection">>) => action$.pipe(
  select(catalogApplied),
  filter(({ payload }) => payload.connections.some((connection) => connection.resumeAvailable)),
  tap(({ payload }) => {
    for (const { connectionId, resumeAvailable } of payload.connections) {
      const connection = store.getState().valkeyConnection.connections[connectionId]
      if (!resumeAvailable || !connection?.preconfigured || connection.userDisconnected) continue
      if (connection.status !== NOT_CONNECTED && connection.status !== DISCONNECTED) continue
      store.dispatch(connectPending({
        connectionId,
        connectionDetails: connection.connectionDetails,
        isResume: true,
        autoConnect: true,
      }))
    }
  }),
  ignoreElements(),
)
