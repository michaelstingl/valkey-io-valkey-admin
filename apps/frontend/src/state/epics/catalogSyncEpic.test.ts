import { configureStore } from "@reduxjs/toolkit"
import { describe, it, expect } from "vitest"
import reducer, {
  catalogFulfilled, catalogNodeResolved, connectPending, connectRejected, standaloneConnectFulfilled, closeConnection, catalogEntryRemoved
} from "../valkey-features/connection/connectionSlice"
import topology from "../valkey-features/topology/topologySlice"
import { action$, rxjsMiddleware } from "../middleware/rxjsMiddleware/rxjsMiddleware"
import { catalogSyncEpic } from "./catalogSyncEpic"

const blue = { catalogId: "uid-blue", connectionId: "blue-6379-db0", revision: "one", connectionDetails: {
  host: "blue", port: "6379", alias: "one/blue", db: 0, tls: false, verifyTlsCertificate: true,
  endpointType: "cluster-endpoint" as const, authType: "password" as const,
} }
const nodeConnectionId = "pod-blue-6379-db0"

describe("catalog snapshot reconciliation", () => {
  const setup = () => {
    const store = configureStore({ reducer: { valkeyConnection: reducer, valkeyTopology: topology },
      middleware: (defaults) => defaults().concat(rxjsMiddleware) })
    const subscription = catalogSyncEpic(store).subscribe()
    const closed: string[] = []
    const observer = action$.subscribe((action) => { if (closeConnection.match(action)) closed.push(action.payload.connectionId) })
    store.dispatch(catalogFulfilled({ connections: [blue] }))
    const connect = () => {
      store.dispatch(catalogNodeResolved({ catalogId: blue.catalogId, connectionId: nodeConnectionId,
        connectionDetails: { ...blue.connectionDetails, host: "pod-blue" } }))
      store.dispatch(connectPending({ connectionId: nodeConnectionId, catalogId: blue.catalogId,
        connectionDetails: { ...blue.connectionDetails, host: "pod-blue" } }))
      store.dispatch(standaloneConnectFulfilled({ connectionId: nodeConnectionId, connectionDetails: blue.connectionDetails }))
    }
    return { store, closed, connect, dispose: () => { subscription.unsubscribe(); observer.unsubscribe() } }
  }

  it("keeps a manual connection added after the catalog across updates and removal", () => {
    const { store, closed, dispose } = setup()
    try {
      const manualDetails = { ...blue.connectionDetails, alias: "My connection", username: "reader" }
      store.dispatch(connectPending({ connectionId: blue.connectionId, connectionDetails: manualDetails }))
      store.dispatch(standaloneConnectFulfilled({ connectionId: blue.connectionId, connectionDetails: manualDetails }))
      const manual = store.getState().valkeyConnection.connections[blue.connectionId]
      expect(manual.preconfigured).toBeUndefined()
      expect(manual.catalogId).toBeUndefined()
      expect(manual.sourceConnectionDetails).toBeUndefined()
      store.dispatch(catalogFulfilled({ connections: [{ ...blue, connectionDetails: { ...blue.connectionDetails, alias: "Changed" } }] }))
      expect(store.getState().valkeyConnection.connections[blue.connectionId]).toEqual(manual)
      store.dispatch(catalogFulfilled({ connections: [] }))
      expect(store.getState().valkeyConnection.connections[blue.connectionId]).toEqual(manual)
      expect(closed).toEqual([])
    } finally { dispose() }
  })

  it("updates display metadata while retaining the resolved node and its live connection", () => {
    const { store, closed, connect, dispose } = setup()
    try {
      connect()
      store.dispatch(catalogFulfilled({ connections: [{ ...blue, connectionDetails: { ...blue.connectionDetails, alias: "one/Renamed" } }] }))
      expect(Object.keys(store.getState().valkeyConnection.connections)).toEqual([nodeConnectionId])
      expect(store.getState().valkeyConnection.connections[nodeConnectionId]).toMatchObject({ status: "Connected",
        connectionDetails: { host: "pod-blue", alias: "one/Renamed" } })
      expect(closed).toEqual([])
    } finally { dispose() }
  })

  it("closes only removed preconfigured nodes, preserving unrelated manual connections", () => {
    const { store, closed, connect, dispose } = setup()
    try {
      connect()
      store.dispatch(connectPending({ connectionId: "manual", connectionDetails: blue.connectionDetails }))
      store.dispatch(catalogFulfilled({ connections: [] }))
      expect(Object.keys(store.getState().valkeyConnection.connections)).toEqual(["manual"])
      expect(closed).toEqual([nodeConnectionId])
    } finally { dispose() }
  })

  it.each(["removed", "changed"])("closes a rejected connection before its catalog entry is %s", (update) => {
    const { store, connect, dispose } = setup()
    const actions: string[] = []
    const observer = action$.subscribe((action) => {
      if (closeConnection.match(action) || catalogEntryRemoved.match(action)) actions.push(action.type)
    })
    try {
      connect()
      store.dispatch(connectRejected({ connectionId: nodeConnectionId,
        errorMessage: "Preconfigured connection changed. Disconnect the existing connection and try again." }))
      expect(store.getState().valkeyConnection.connections[nodeConnectionId].status).toBe("Error")
      store.dispatch(catalogFulfilled({ connections: update === "removed" ? [] : [{ ...blue, revision: "changed" }] }))
      expect(actions).toEqual([closeConnection.type, catalogEntryRemoved.type])
      expect(store.getState().valkeyConnection.connections[nodeConnectionId]).toBeUndefined()
      if (update === "changed") {
        expect(store.getState().valkeyConnection.connections[blue.connectionId].catalogRevision).toBe("changed")
      }
    } finally { observer.unsubscribe(); dispose() }
  })

  it("does not transfer the previous connection when a resource is recreated at the same endpoint", () => {
    const { store, closed, connect, dispose } = setup()
    try {
      connect()
      store.dispatch(catalogFulfilled({ connections: [{ ...blue, catalogId: "replacement-uid" }] }))
      expect(closed).toEqual([nodeConnectionId])
      expect(store.getState().valkeyConnection.connections[blue.connectionId]).toMatchObject({
        catalogId: "replacement-uid", status: "Not Connected", connectionHistory: [],
      })
    } finally { dispose() }
  })

  it("replaces changed connection settings while leaving a different catalog entry alone", () => {
    const { store, closed, connect, dispose } = setup()
    try {
      connect()
      const green = { ...blue, catalogId: "uid-green", connectionId: "green", connectionDetails: { ...blue.connectionDetails, host: "green" } }
      store.dispatch(catalogFulfilled({ connections: [blue, green] }))
      const unchanged = store.getState().valkeyConnection.connections.green
      store.dispatch(catalogFulfilled({ connections: [{ ...blue, revision: "changed", connectionId: "new-blue",
        connectionDetails: { ...blue.connectionDetails, host: "new-blue" } }, green] }))
      expect(closed).toEqual([nodeConnectionId])
      expect(store.getState().valkeyConnection.connections.green).toBe(unchanged)
      expect(store.getState().valkeyConnection.connections["new-blue"]).toMatchObject({ status: "Not Connected", catalogRevision: "changed" })
    } finally { dispose() }
  })
})
