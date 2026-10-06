import { describe, it, expect } from "vitest"
import reducer, { connectPending, isAutoResumeEligible } from "./connectionSlice"

const id = "blue-example-6379-db0"
const connectionDetails = {
  host: "blue.example", port: "6379", username: "default", alias: "Blue",
  tls: false, verifyTlsCertificate: true, endpointType: "cluster-endpoint" as const,
  authType: "password" as const, db: 0,
}
const reply = { type: "valkeyConnection/catalogApplied", payload: {
  connections: [{ connectionId: id, connectionDetails }],
} }

describe("server connection catalog", () => {
  it("moves the catalog entry to the discovered node without duplicating or persisting credentials", () => {
    let state = reducer({ connections: {} }, reply)
    const nodeConnectionId = "pod-blue-example-6379-db0"
    state = reducer(state, { type: "valkeyConnection/catalogNodeResolved", payload: {
      catalogId: id, connectionId: nodeConnectionId,
      connectionDetails: { ...connectionDetails, host: "pod.blue.example", endpointType: "node" },
    } })
    expect(Object.keys(state.connections)).toEqual([nodeConnectionId])
    state = reducer(state, connectPending({ connectionId: nodeConnectionId, catalogId: id,
      connectionDetails: { ...connectionDetails, host: "pod.blue.example", password: "private-input" } }))
    state = reducer(state, reply)
    expect(Object.keys(state.connections)).toEqual([nodeConnectionId])
    expect(state.connections[nodeConnectionId]).toMatchObject({ preconfigured: true, catalogId: id })
    expect(state.connections[nodeConnectionId].connectionDetails.password).toBeUndefined()
  })

  it("lists a never-connected entry without history or password and does not auto-resume it", () => {
    const state = reducer({ connections: {} }, reply)
    const entry = state.connections[id]
    expect(entry).toMatchObject({ preconfigured: true, status: "Not Connected", connectionHistory: [] })
    expect(entry.connectionDetails.password).toBeUndefined()
    expect(isAutoResumeEligible(entry)).toBe(false)
  })

  it("preserves the preconfigured flag through connect and repeated catalog replies", () => {
    let state = reducer({ connections: {} }, reply)
    state = reducer(state, connectPending({ connectionId: id, catalogId: id,
      connectionDetails: { ...connectionDetails, password: "private-input" } }))
    state = reducer(state, reply)
    expect(Object.keys(state.connections)).toEqual([id])
    expect(state.connections[id]).toMatchObject({ preconfigured: true, status: "Connecting" })
    expect(state.connections[id].connectionDetails.password).toBeUndefined()
  })

  it("does not take over a manually created connection at the same endpoint", () => {
    const manual = reducer({ connections: {} }, connectPending({
      connectionId: id, connectionDetails: { ...connectionDetails, alias: "My own label" },
    }))
    expect(reducer(manual, reply)).toEqual(manual)
  })
})
