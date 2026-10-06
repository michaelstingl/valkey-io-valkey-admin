/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, it, mock } from "node:test"
import assert from "node:assert/strict"
import { GlideClient } from "@valkey/valkey-glide"
import { buildConnectionId, VALKEY, toNodeId } from "valkey-common"
import { connectPending } from "../actions/connection"
import { topologyDiscoveryEndpointPending } from "../actions/topology"
import { parseConnectionCatalog, getSessionConnectionCatalog } from "../connection-catalog"
import { ensureSession, getCatalogNode, _resetSessions } from "../session"
import { _resetConnectInFlight } from "../connection"
import { _reset as resetWatchers } from "../node-watchers"
import { dns } from "../utils"
import type { IncomingMessage } from "node:http"

const slots = (host: string) => [[0, 16383, [host, 6379, "node"]]]
const client = (result: unknown = slots("127.0.0.2")) => ({
  customCommand: async (args: string[]) => args[0] === "CLUSTER" ? await result : [],
  info: async () => "cluster_enabled:0\r\nmaxmemory_policy:noeviction",
  configGet: async () => ({ databases: "16" }),
  close() {},
})
const setup = () => {
  const catalog = parseConnectionCatalog([{
    id: "resource", host: "127.0.0.1", port: "6379", endpointType: "cluster-endpoint", tls: true, db: 3,
  }])
  const messages: any[] = []
  const deps = { catalog, connectionId: "", sessionId: ensureSession({ headers: {}, socket: {} } as IncomingMessage).sessionId,
    ws: { send: (message: string) => messages.push(JSON.parse(message)) } as any,
    clients: new Map<string, any>(), connectedNodesByCluster: new Map(), metricsServerMap: new Map(), clusterNodesRegistry: new Map() }
  deps.metricsServerMap.set(toNodeId(buildConnectionId("127.0.0.2", "6379", 3)), {
    metricsURI: "http://localhost:1234", pid: 12345, lastSeen: Date.now() })
  const discovery = (discoveryId = "attempt") => ({ type: VALKEY.TOPOLOGY.discoveryEndpointPending, meta: undefined,
    payload: { connectionId: "", catalogId: "resource", discoveryId,
      connectionDetails: { ...catalog[0].connectionDetails, tls: false, db: 0, username: "reader", password: "test-password" } } })
  const connect = (discoveryId = "attempt", host = "127.0.0.2") => ({ type: VALKEY.CONNECTION.connectPending, meta: undefined,
    payload: { connectionId: buildConnectionId(host, "6379", 3), catalogId: "resource", discoveryId,
      connectionDetails: { ...catalog[0].connectionDetails, host, endpointType: "node" as const,
        tls: false, db: 0, username: "reader", password: "test-password" } } })
  return { deps, messages, discovery, connect }
}

describe("preconfigured discovery authentication", () => {
  beforeEach(() => {
    _resetSessions(); _resetConnectInFlight(); resetWatchers()
    mock.method(dns, "reverse", async () => [])
    mock.method(GlideClient, "createClient", async () => client() as any)
  })
  afterEach(() => {
    _resetSessions(); _resetConnectInFlight(); resetWatchers(); mock.restoreAll()
  })

  it("uses canonical settings for the final node and binds only after authentication", async () => {
    const { deps, messages, discovery, connect } = setup()
    await topologyDiscoveryEndpointPending(deps)(discovery())
    assert.equal(getCatalogNode(deps.sessionId, "resource"), undefined)
    const reply = messages.find((message) => message.type === VALKEY.TOPOLOGY.discoveryEndpointFulfilled)
    assert.equal(reply.payload.connectionDetails.tls, true)
    assert.equal(reply.payload.connectionDetails.db, 3)
    assert.equal(reply.payload.connectionDetails.username, "reader")
    assert.equal(reply.payload.connectionDetails.password, undefined)
    await connectPending(deps)(connect())
    const options = (GlideClient.createClient as any).mock.calls.map((call: any) => call.arguments[0])
    assert.deepEqual(options.map((option: any) => option.useTLS), [true, true, true])
    assert.equal(options.at(-1).databaseId, 3)
    assert.equal(getCatalogNode(deps.sessionId, "resource")?.revision, deps.catalog[0].revision)
    assert.equal(getSessionConnectionCatalog(deps.catalog, deps.sessionId, new Set(deps.clients.keys()))[0].resumeAvailable, true)
  })

  it("keeps the authenticated binding when an older discovery completes late", async () => {
    const { deps, discovery, connect } = setup()
    let finishOld!: (value: unknown) => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => { started = resolve })
    const oldSlots = new Promise((resolve) => { finishOld = resolve })
    ;(GlideClient.createClient as any).mock.mockImplementationOnce(async () => ({
      ...client(), customCommand: async () => { started(); return oldSlots },
    }))
    const oldAttempt = topologyDiscoveryEndpointPending(deps)(discovery("old"))
    await entered
    await topologyDiscoveryEndpointPending(deps)(discovery("current"))
    await connectPending(deps)(connect("current"))
    assert.equal(getSessionConnectionCatalog(deps.catalog, deps.sessionId, new Set(deps.clients.keys()))[0].resumeAvailable, true)
    finishOld(slots("127.0.0.3"))
    await oldAttempt
    assert.equal(getCatalogNode(deps.sessionId, "resource")?.host, "127.0.0.2")
    assert.equal(getSessionConnectionCatalog(deps.catalog, deps.sessionId, new Set(deps.clients.keys()))[0].resumeAvailable, true)
  })

  it("rejects a node connect after its source revision changes or disappears", async () => {
    for (const removed of [false, true]) {
      const { deps, messages, discovery, connect } = setup()
      await topologyDiscoveryEndpointPending(deps)(discovery())
      deps.catalog = removed ? [] : parseConnectionCatalog([{
        ...deps.catalog[0].connectionDetails, id: "resource", tls: false,
      }])
      const calls = (GlideClient.createClient as any).mock.calls.length
      await connectPending(deps)(connect())
      assert.equal((GlideClient.createClient as any).mock.calls.length, calls)
      assert.equal(messages.at(-1).type, VALKEY.CONNECTION.connectRejected)
      assert.equal(getCatalogNode(deps.sessionId, "resource"), undefined)
    }
  })

  it("rejects forged nodes, superseded attempts and attempts owned by another session", async () => {
    const { deps, messages, discovery, connect } = setup()
    await topologyDiscoveryEndpointPending(deps)(discovery("old"))
    await topologyDiscoveryEndpointPending(deps)(discovery("current"))
    const stranger = ensureSession({ headers: {}, socket: {} } as IncomingMessage).sessionId
    for (const [sessionId, action] of [
      [deps.sessionId, connect("current", "127.0.0.99")], [deps.sessionId, connect("old")], [stranger, connect("current")],
    ] as const) {
      const calls = (GlideClient.createClient as any).mock.calls.length
      await connectPending({ ...deps, sessionId })(action)
      assert.equal((GlideClient.createClient as any).mock.calls.length, calls)
      assert.equal(messages.at(-1).type, VALKEY.CONNECTION.connectRejected)
      assert.equal(getCatalogNode(sessionId, "resource"), undefined)
    }
  })

  it("does not replace an authenticated binding when a later discovery is abandoned", async () => {
    const { deps, discovery, connect } = setup()
    await topologyDiscoveryEndpointPending(deps)(discovery())
    await connectPending(deps)(connect())
    const binding = getCatalogNode(deps.sessionId, "resource")
    assert.ok(binding)
    ;(GlideClient.createClient as any).mock.mockImplementationOnce(async () => client(slots("127.0.0.3")))
    await topologyDiscoveryEndpointPending(deps)(discovery("abandoned"))
    assert.deepEqual(getCatalogNode(deps.sessionId, "resource"), binding)
  })

  it("rejects an in-flight node connect superseded by a new discovery before acknowledging it", async () => {
    const { deps, discovery, connect, messages } = setup()
    await topologyDiscoveryEndpointPending(deps)(discovery("old"))
    let finish!: (value: unknown) => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => { started = resolve })
    const waiting = new Promise((resolve) => { finish = resolve })
    ;(GlideClient.createClient as any).mock.mockImplementationOnce(async () => { started(); return waiting })
    const pending = connectPending(deps)(connect("old"))
    await entered
    await topologyDiscoveryEndpointPending(deps)(discovery("new"))
    finish(client())
    await pending
    assert.equal(messages.some((message) => message.type === VALKEY.CONNECTION.standaloneConnectFulfilled), false)
    assert.equal(getCatalogNode(deps.sessionId, "resource"), undefined)
    assert.equal(deps.clients.size, 0)
  })

  it("does not bind a node whose authentication failed", async () => {
    const { deps, discovery, connect, messages } = setup()
    await topologyDiscoveryEndpointPending(deps)(discovery())
    ;(GlideClient.createClient as any).mock.mockImplementationOnce(async () => { throw new Error("WRONGPASS") })
    await connectPending(deps)(connect())
    assert.equal(messages.at(-1).type, VALKEY.CONNECTION.connectRejected)
    assert.equal(getCatalogNode(deps.sessionId, "resource"), undefined)
  })
})
