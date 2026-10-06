import { configureStore } from "@reduxjs/toolkit"
import { describe, it, expect } from "vitest"
import reducer, { catalogApplied, closeConnection, connectPending } from "../valkey-features/connection/connectionSlice"
import { rxjsMiddleware } from "../middleware/rxjsMiddleware/rxjsMiddleware"
import { catalogResumeEpic } from "./catalogResumeEpic"

const blue = {
  connectionId: "blue-6379-db0",
  connectionDetails: { host: "blue", port: "6379", db: 0, tls: false, verifyTlsCertificate: true,
    endpointType: "cluster-endpoint" as const, authType: "password" as const },
}
const green = { ...blue, connectionId: "green-6379-db0", connectionDetails: { ...blue.connectionDetails, host: "green" } }

describe("catalog session resume", () => {
  const setup = () => {
    const store = configureStore({ reducer: { valkeyConnection: reducer },
      middleware: (defaults) => defaults().concat(rxjsMiddleware) })
    const subscription = catalogResumeEpic(store).subscribe()
    return { store, subscription }
  }

  it("resumes each authorized preconfigured connection without a password or fabricated history", () => {
    const { store, subscription } = setup()
    try {
      store.dispatch(catalogApplied({ connections: [blue, green].map((entry) => ({ ...entry, resumeAvailable: true })) }))
      for (const entry of Object.values(store.getState().valkeyConnection.connections)) {
        expect(entry).toMatchObject({ preconfigured: true, status: "Connecting", autoConnect: true, connectionHistory: [] })
        expect(entry.connectionDetails.password).toBeUndefined()
      }
    } finally { subscription.unsubscribe() }
  })

  it("leaves fresh sessions disconnected and does not resume manual collisions", () => {
    const { store, subscription } = setup()
    try {
      store.dispatch(connectPending({ ...green }))
      const manual = store.getState().valkeyConnection.connections[green.connectionId]
      store.dispatch(catalogApplied({ connections: [blue, { ...green, resumeAvailable: true }] }))
      expect(store.getState().valkeyConnection.connections[blue.connectionId].status).toBe("Not Connected")
      expect(store.getState().valkeyConnection.connections[green.connectionId]).toEqual(manual)
    } finally { subscription.unsubscribe() }
  })

  it("does not interrupt an in-flight resume or undo an explicit disconnect", () => {
    const { store, subscription } = setup()
    try {
      const reply = catalogApplied({ connections: [{ ...blue, resumeAvailable: true }] })
      store.dispatch(reply)
      const connecting = store.getState().valkeyConnection.connections[blue.connectionId]
      store.dispatch(reply)
      expect(store.getState().valkeyConnection.connections[blue.connectionId]).toBe(connecting)
      store.dispatch(closeConnection({ connectionId: blue.connectionId }))
      store.dispatch(reply)
      expect(store.getState().valkeyConnection.connections[blue.connectionId]).toMatchObject({
        status: "Disconnecting", userDisconnected: true,
      })
    } finally { subscription.unsubscribe() }
  })
})
