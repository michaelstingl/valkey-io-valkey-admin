import { configureStore } from "@reduxjs/toolkit"
import { describe, it, expect } from "vitest"
import reducer, { catalogApplied, catalogNodeResolved, connectPending } from "../valkey-features/connection/connectionSlice"
import topology, { discoveryEndpointFulfilled, discoveryEndpointRejected } from "../valkey-features/topology/topologySlice"
import { rxjsMiddleware } from "../middleware/rxjsMiddleware/rxjsMiddleware"
import { selectPromptedConnection } from "../valkey-features/connection/connectionSelectors"
import { passwordConnectionEpic, passwordConnectionRequested } from "./passwordConnectionEpic"

const details = { host: "service", port: "6379", db: 0, tls: false, verifyTlsCertificate: true,
  endpointType: "cluster-endpoint" as const, authType: "password" as const }

describe("password connection intent", () => {
  const setup = () => {
    const store = configureStore({ reducer: { valkeyConnection: reducer, valkeyTopology: topology },
      middleware: (defaults) => defaults().concat(rxjsMiddleware) })
    const subscription = passwordConnectionEpic(store).subscribe()
    return { store, subscription }
  }

  it.each(["catalog", "connection"] as const)("selects and submits the intended %s when IDs collide", (kind) => {
    const { store, subscription } = setup()
    try {
      store.dispatch(connectPending({ connectionId: "collision", connectionDetails: { ...details, host: "manual", endpointType: "node" } }))
      store.dispatch(catalogApplied({ connections: [{ catalogId: "collision", connectionId: "configured",
        connectionDetails: { ...details, host: "catalog" } }] }))
      const prompt = { kind, id: "collision" }
      const selected = selectPromptedConnection(prompt)(store.getState())
      expect(selected?.connectionDetails.host).toBe(kind === "catalog" ? "catalog" : "manual")
      store.dispatch(passwordConnectionRequested({ prompt, discoveryId: "attempt", password: "", isPasswordEncrypted: false }))
      if (kind === "catalog") expect(store.getState().valkeyTopology.discoveries.attempt.connectionDetails.host).toBe("catalog")
      else expect(store.getState().valkeyConnection.connections.collision.connectionDetails.password).toBe("")
    } finally { subscription.unsubscribe() }
  })

  it.each(["node", "cluster-endpoint"] as const)("uses the chosen username for %s", (endpointType) => {
    const { store, subscription } = setup()
    try {
      const connectionDetails = { ...details, endpointType, username: "default" }
      store.dispatch(catalogApplied({ connections: [{ catalogId: "uid", connectionId: "service-id", connectionDetails }] }))
      store.dispatch(passwordConnectionRequested({
        prompt: { kind: "catalog", id: "uid" }, discoveryId: "reader-attempt", username: "reader",
        password: "reader-password", isPasswordEncrypted: false,
      }))
      const state = store.getState()
      const requestDetails = endpointType === "node"
        ? state.valkeyConnection.connections["service-id"].connectionDetails
        : state.valkeyTopology.discoveries["reader-attempt"].connectionDetails
      expect(requestDetails).toMatchObject({ host: "service", username: "reader" })
      expect(requestDetails.password).toBe(endpointType === "node" ? undefined : "reader-password")
      expect(state.valkeyConnection.connections["service-id"].sourceConnectionDetails?.username).toBe("default")
    } finally { subscription.unsubscribe() }
  })

  it("discovers a preconfigured endpoint before connecting to its first node", () => {
    const { store, subscription } = setup()
    try {
      store.dispatch(catalogApplied({ connections: [{ catalogId: "uid", connectionId: "service-id", connectionDetails: details }] }))
      store.dispatch(passwordConnectionRequested({
        prompt: { kind: "catalog", id: "uid" }, discoveryId: "attempt-1", password: "test-password", isPasswordEncrypted: false,
      }))
      expect(store.getState().valkeyTopology.discoveries["attempt-1"]).toMatchObject({
        catalogId: "uid", status: "pending", connectionDetails: { host: "service", password: "test-password" },
      })
      expect(store.getState().valkeyConnection.connections["service-id"].status).toBe("Not Connected")
    } finally { subscription.unsubscribe() }
  })

  it("rediscovers the source endpoint when reconnecting after a node replacement", () => {
    const { store, subscription } = setup()
    try {
      store.dispatch(catalogApplied({ connections: [{ catalogId: "uid", connectionId: "service-id", connectionDetails: details }] }))
      store.dispatch(catalogNodeResolved({ catalogId: "uid", connectionId: "node-id", connectionDetails: { ...details, host: "node" } }))
      store.dispatch(passwordConnectionRequested({
        prompt: { kind: "catalog", id: "uid" }, discoveryId: "attempt-1", password: "test-password", isPasswordEncrypted: false,
      }))
      expect(store.getState().valkeyTopology.discoveries["attempt-1"]).toMatchObject({
        catalogId: "uid", status: "pending", connectionDetails: { host: "service", endpointType: "cluster-endpoint" },
      })
    } finally { subscription.unsubscribe() }
  })

  it("preserves manual connections and ignores a removed catalog entry", () => {
    const { store, subscription } = setup()
    try {
      store.dispatch(connectPending({ connectionId: "manual", connectionDetails: { ...details, endpointType: "node" } }))
      store.dispatch(passwordConnectionRequested({
        prompt: { kind: "connection", id: "manual" }, discoveryId: "manual-attempt", password: "", isPasswordEncrypted: false,
      }))
      expect(store.getState().valkeyConnection.connections.manual.connectionDetails.password).toBe("")
      const before = store.getState()
      store.dispatch(passwordConnectionRequested({
        prompt: { kind: "catalog", id: "gone" }, discoveryId: "gone-attempt", password: "test-password", isPasswordEncrypted: false,
      }))
      expect(store.getState()).toBe(before)
    } finally { subscription.unsubscribe() }
  })

  it("ignores an old discovery reply after the user starts another attempt", () => {
    const { store, subscription } = setup()
    try {
      store.dispatch(catalogApplied({ connections: [{ catalogId: "uid", connectionId: "service-id", connectionDetails: details }] }))
      store.dispatch(passwordConnectionRequested({
        prompt: { kind: "catalog", id: "uid" }, discoveryId: "old", password: "old-password", isPasswordEncrypted: false,
      }))
      store.dispatch(passwordConnectionRequested({
        prompt: { kind: "catalog", id: "uid" }, discoveryId: "current", password: "new-password", isPasswordEncrypted: false,
      }))
      const before = store.getState().valkeyTopology
      store.dispatch(discoveryEndpointFulfilled({ discoveryId: "old", clusterNodes: { old: { host: "stale-node", port: 6379 } } }))
      store.dispatch(discoveryEndpointRejected({ discoveryId: "old", errorMessage: "late rejection" }))
      expect(store.getState().valkeyTopology).toBe(before)
      expect(Object.keys(before.discoveries)).toEqual(["current"])
      expect(before.discoveries.current.connectionDetails.password).toBe("new-password")
    } finally { subscription.unsubscribe() }
  })
})
