import { configureStore } from "@reduxjs/toolkit"
import { describe, expect, it, vi } from "vitest"
import { buildConnectionId } from "@common/src/connection-id"
import reducer, { catalogApplied, connectPending } from "../valkey-features/connection/connectionSlice"
import topology, { discoveryEndpointPending, discoveryEndpointFulfilled } from "../valkey-features/topology/topologySlice"
import { action$, rxjsMiddleware } from "../middleware/rxjsMiddleware/rxjsMiddleware"
import { connectionEpic } from "./valkeyEpics"

vi.mock("./wsEpics", () => ({ getSocket: () => ({ next: vi.fn() }) }))

const details = { host: "seed", port: "6379", db: 0, tls: false, verifyTlsCertificate: true,
  endpointType: "cluster-endpoint" as const, authType: "password" as const, username: "reader", password: "private-input" }

describe("catalog discovery result", () => {
  it("ignores a discovery result after Add Connection replaces its catalog entry", () => {
    const store = configureStore({ reducer: { valkeyConnection: reducer, valkeyTopology: topology },
      middleware: (defaults) => defaults().concat(rxjsMiddleware) })
    const subscription = connectionEpic(store).subscribe()
    try {
      store.dispatch(catalogApplied({ connections: [{ connectionId: "seed-id", catalogId: "resource", connectionDetails: details }] }))
      store.dispatch(discoveryEndpointPending({ discoveryId: "attempt", catalogId: "resource", connectionDetails: details }))
      store.dispatch(connectPending({ connectionId: "seed-id", connectionDetails: { ...details, alias: "Manual" } }))
      store.dispatch(discoveryEndpointFulfilled({ discoveryId: "attempt", clusterNodes: { node: { host: "node", port: 6379 } } }))
      expect(Object.keys(store.getState().valkeyConnection.connections)).toEqual(["seed-id"])
      expect(store.getState().valkeyConnection.connections["seed-id"].preconfigured).toBeUndefined()
    } finally { subscription.unsubscribe() }
  })

  it("connects using canonical public settings and carries the catalog attempt identity", () => {
    const store = configureStore({ reducer: { valkeyConnection: reducer, valkeyTopology: topology },
      middleware: (defaults) => defaults().concat(rxjsMiddleware) })
    const subscription = connectionEpic(store).subscribe()
    const connects: ReturnType<typeof connectPending>[] = []
    const observer = action$.subscribe((action) => { if (connectPending.match(action)) connects.push(action) })
    try {
      store.dispatch(catalogApplied({ connections: [{ connectionId: "seed-id", catalogId: "resource", connectionDetails: details }] }))
      store.dispatch(discoveryEndpointPending({ discoveryId: "attempt", catalogId: "resource", connectionDetails: details }))
      const canonical = { ...details, tls: true, db: 3, password: undefined }
      store.dispatch({ type: discoveryEndpointFulfilled.type, payload: {
        discoveryId: "attempt", clusterNodes: { node: { host: "node", port: 6379 } }, connectionDetails: canonical, catalogRevision: "current",
      } })
      expect(connects).toHaveLength(1)
      expect(connects[0].payload).toMatchObject({
        connectionId: buildConnectionId("node", "6379", 3), catalogId: "resource", discoveryId: "attempt",
        connectionDetails: { host: "node", tls: true, db: 3, username: "reader", password: "private-input", endpointType: "node" },
      })
      const entry = store.getState().valkeyConnection.connections[connects[0].payload.connectionId]
      expect(entry.preconfigured).toBe(true)
      expect(entry.catalogRevision).toBe("current")
      expect(entry.sourceConnectionDetails).toMatchObject({ tls: true, db: 3 })
      expect(entry.sourceConnectionDetails).not.toHaveProperty("password")
      expect(entry.connectionDetails.password).toBeUndefined()
      expect(store.getState().valkeyTopology.discoveries.attempt).toBeUndefined()
    } finally { subscription.unsubscribe(); observer.unsubscribe() }
  })
})
