import { afterEach, beforeEach, describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { buildConnectionId, VALKEY, type CatalogConnection } from "valkey-common"
import { WsClient } from "./harness/wsClient"
import { WS_URL } from "./harness/fixture"

// The Compose server mounts the directory read-only; this process replaces the file atomically.
const catalogFile = fileURLToPath(new URL("../../../../docker/test-catalog/connections.json", import.meta.url))
const readerPassword = "catalog-reader-password"
const sourceId = "integration-node"

describe("integration / connection catalog", { concurrency: false }, () => {
  let original: string
  let database = 0
  let fixture: Record<string, unknown>[]
  let owner: WsClient
  let entry: CatalogConnection
  let sockets: WsClient[]
  let connections: Array<{ socket: WsClient; connectionId: string }>

  function replaceCatalog(value: unknown) {
    const temporary = `${catalogFile}.tmp`
    writeFileSync(temporary, typeof value === "string" ? value : JSON.stringify(value))
    renameSync(temporary, catalogFile)
  }
  async function open(cookie?: string) {
    const socket = await WsClient.connect(WS_URL, 10000, { cookie })
    sockets.push(socket)
    return socket
  }
  async function requestCatalog(socket = owner): Promise<CatalogConnection[]> {
    socket.send({ type: VALKEY.CONNECTION.catalogRequested })
    return (await socket.waitFor(VALKEY.CONNECTION.catalogFulfilled)).payload.connections
  }
  // Docker Desktop bind mounts may expose a host-side atomic replacement asynchronously.
  async function refreshedCatalog(matches: (catalog: CatalogConnection[]) => boolean) {
    const deadline = Date.now() + 10000
    while (true) {
      const catalog = await requestCatalog()
      if (matches(catalog)) return catalog
      assert.ok(Date.now() < deadline, "Server did not observe the catalog replacement")
      await delay(100)
    }
  }
  async function connect(socket = owner, resume = false) {
    socket.send({ type: VALKEY.CONNECTION.connectPending, payload: {
      catalogId: entry.catalogId, connectionId: entry.connectionId,
      connectionDetails: { ...entry.connectionDetails, username: "reader", ...(!resume && { password: readerPassword }) },
      ...(resume && { isResume: true }),
    } })
    const reply = await socket.waitFor(VALKEY.CONNECTION.standaloneConnectFulfilled)
    assert.equal(reply.payload.connectionId, entry.connectionId)
    connections.push({ socket, connectionId: entry.connectionId })
  }
  async function command(socket: WsClient, value: string, type = VALKEY.COMMAND.sendFulfilled as string) {
    socket.send({ type: VALKEY.COMMAND.sendRequested, payload: { connectionId: entry.connectionId, command: value } })
    return socket.waitFor(type)
  }
  beforeEach(async () => {
    original = readFileSync(catalogFile, "utf8")
    sockets = []; connections = []
    fixture = [{ id: sourceId, host: "valkey-catalog", port: "6379", username: "default", alias: "Catalog node", db: ++database }]
    replaceCatalog(fixture)
    owner = await open()
    ;[entry] = await refreshedCatalog((catalog) => catalog[0]?.connectionDetails.db === database)
    assert.equal(entry.catalogId, sourceId)
  })
  afterEach(async () => {
    try {
      for (const { socket, connectionId } of connections) {
        try {
          socket.send({ type: VALKEY.CONNECTION.closeConnection, payload: { connectionId } })
          await socket.waitFor(VALKEY.CONNECTION.closeConnectionFulfilled)
        } catch (error) {
          if ((error as Error).message !== "WsClient is closed") throw error
        }
      }
    } finally {
      replaceCatalog(original)
      try { if (owner) await requestCatalog() } catch { /* The reload test deliberately closes the original socket. */ }
      await Promise.all(sockets.map((socket) => socket.close()))
    }
  })

  it("publishes live metadata without credential fields or resume authorization", async () => {
    replaceCatalog([{ ...fixture[0], alias: "No credentials", password: "catalog-password-canary", token: "catalog-token-canary" }])
    const catalog = await refreshedCatalog((entries) => entries[0]?.connectionDetails.alias === "No credentials")
    assert.equal(catalog.length, 1)
    assert.equal(catalog[0].connectionDetails.alias, "No credentials")
    assert.equal(catalog[0].connectionDetails.username, "default")
    assert.equal(catalog[0].resumeAvailable, false)
    assert.ok(catalog[0].revision)
    assert.equal("password" in catalog[0].connectionDetails, false)
    assert.equal("token" in catalog[0].connectionDetails, false)
    assert.doesNotMatch(JSON.stringify(catalog), /catalog-password-canary|catalog-token-canary/)
  })

  it("authenticates a username override, allows reads and denies writes", async () => {
    // The configured default user is disabled; connecting requires the user's override.
    await connect()
    assert.equal((await command(owner, "ACL WHOAMI")).payload, "reader")
    assert.equal((await command(owner, "GET catalog-integration-missing")).payload, null)
    const denied = await command(owner, "SET catalog-integration-missing forbidden", VALKEY.COMMAND.sendFailed)
    assert.equal(denied.meta?.command, "SET catalog-integration-missing forbidden")
    assert.equal((await command(owner, "GET catalog-integration-missing")).payload, null)
    const [bound] = await requestCatalog()
    assert.equal(bound.connectionDetails.username, "reader")
    assert.equal(bound.resumeAvailable, true)
    assert.equal("password" in bound.connectionDetails, false)
    assert.equal((await requestCatalog(await open()))[0].connectionDetails.username, "default")
  })

  it("resumes on a new WebSocket with the session cookie but rejects a fresh session", async () => {
    await connect()
    assert.ok(owner.sessionCookie)
    const cookie = owner.sessionCookie
    await owner.close()
    const resumed = await open(cookie)
    const [bound] = await requestCatalog(resumed)
    assert.equal(bound.resumeAvailable, true)
    assert.equal(bound.connectionDetails.username, "reader")
    await connect(resumed, true)
    assert.equal((await command(resumed, "PING")).payload, "PONG")
    assert.equal((await command(resumed, "GET catalog-integration-missing")).payload, null)
    await command(resumed, "SET catalog-integration-missing forbidden", VALKEY.COMMAND.sendFailed)
    const stranger = await open()
    assert.equal((await requestCatalog(stranger))[0].resumeAvailable, false)
    stranger.send({ type: VALKEY.CONNECTION.connectPending, payload: {
      catalogId: sourceId, connectionId: entry.connectionId, connectionDetails: entry.connectionDetails, isResume: true,
    } })
    assert.equal((await stranger.waitFor(VALKEY.CONNECTION.connectRejected)).payload.requiresAuth, true)
    resumed.send({ type: VALKEY.CONNECTION.closeConnection, payload: { connectionId: entry.connectionId } })
    await resumed.waitFor(VALKEY.CONNECTION.closeConnectionFulfilled)
    connections = connections.filter(({ socket }) => socket !== resumed)
    assert.equal((await requestCatalog(resumed))[0].resumeAvailable, false)
  })

  it("preserves resume on alias changes but invalidates it when the target changes", async () => {
    await connect()
    replaceCatalog([{ ...fixture[0], alias: "Renamed node" }])
    let [updated] = await refreshedCatalog((catalog) => catalog[0]?.connectionDetails.alias === "Renamed node")
    assert.equal(updated.connectionDetails.alias, "Renamed node")
    assert.equal(updated.revision, entry.revision)
    assert.equal(updated.resumeAvailable, true)
    replaceCatalog([{ ...fixture[0], db: 15 }])
    ;[updated] = await refreshedCatalog((catalog) => catalog[0]?.connectionDetails.db === 15)
    assert.notEqual(updated.revision, entry.revision)
    assert.equal(updated.connectionDetails.db, 15)
    assert.equal(updated.resumeAvailable, false)
    owner.send({ type: VALKEY.CONNECTION.connectPending, payload: {
      catalogId: sourceId, connectionId: entry.connectionId,
      connectionDetails: { ...entry.connectionDetails, username: "reader", password: readerPassword },
    } })
    assert.match((await owner.waitFor(VALKEY.CONNECTION.connectRejected)).payload.errorMessage, /changed or was removed/)
  })

  it("removes deleted entries and rejects a connect using their former catalog ID", async () => {
    await connect()
    replaceCatalog([])
    assert.deepEqual(await refreshedCatalog((catalog) => catalog.length === 0), [])
    owner.send({ type: VALKEY.CONNECTION.connectPending, payload: {
      catalogId: sourceId, connectionId: entry.connectionId,
      connectionDetails: { ...entry.connectionDetails, username: "reader", password: readerPassword },
    } })
    assert.match((await owner.waitFor(VALKEY.CONNECTION.connectRejected)).payload.errorMessage, /changed or was removed/)
  })

  it("keeps a failed authentication ineligible for resume", async () => {
    owner.send({ type: VALKEY.CONNECTION.connectPending, payload: {
      catalogId: sourceId, connectionId: entry.connectionId,
      connectionDetails: { ...entry.connectionDetails, username: "reader", password: "incorrect-test-password" },
    } })
    await owner.waitFor(VALKEY.CONNECTION.connectRejected, 20000)
    assert.equal((await requestCatalog())[0].resumeAvailable, false)
    await connect()
    assert.equal((await command(owner, "PING")).payload, "PONG")
  })

  it("binds cluster discovery to its source revision and authorizes resume only after node connect", async () => {
    replaceCatalog([{ id: "integration-cluster", host: "valkey-7001", port: "7001", username: "appuser",
      endpointType: "cluster-endpoint", db: 9 }])
    ;[entry] = await refreshedCatalog((catalog) => catalog[0]?.catalogId === "integration-cluster")
    const discoveryId = "catalog-integration-discovery"
    owner.send({ type: VALKEY.TOPOLOGY.discoveryEndpointPending, payload: {
      catalogId: entry.catalogId, discoveryId,
      connectionDetails: { ...entry.connectionDetails, db: 0, password: "admin" },
    } })
    const discovery = (await owner.waitFor(VALKEY.TOPOLOGY.discoveryEndpointFulfilled)).payload
    assert.equal(discovery.discoveryId, discoveryId)
    assert.equal(discovery.catalogRevision, entry.revision)
    assert.equal(discovery.connectionDetails.db, 9)
    assert.equal("password" in discovery.connectionDetails, false)
    assert.equal((await requestCatalog())[0].resumeAvailable, false)
    const node = Object.values(discovery.clusterNodes)[0] as { host: string; port: number }
    const connectionId = buildConnectionId(node.host, String(node.port), 9)
    owner.send({ type: VALKEY.CONNECTION.connectPending, payload: {
      catalogId: entry.catalogId, discoveryId, connectionId,
      connectionDetails: { ...discovery.connectionDetails, host: node.host, port: String(node.port),
        endpointType: "node", db: 0, password: "admin" },
    } })
    const connected = await owner.waitFor(VALKEY.CONNECTION.clusterConnectFulfilled, 30000)
    assert.equal(connected.payload.connectionId, connectionId)
    connections.push({ socket: owner, connectionId })
    const [bound] = await requestCatalog()
    assert.equal(bound.connectionId, connectionId)
    assert.equal(bound.connectionDetails.db, 9)
    assert.equal(bound.sourceConnectionDetails?.host, "valkey-7001")
    assert.equal(bound.resumeAvailable, true)
  })
})
