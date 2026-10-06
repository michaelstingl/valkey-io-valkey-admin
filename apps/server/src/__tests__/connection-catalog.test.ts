import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { buildConnectionId } from "valkey-common"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureSession, authorizeConnection, revokeConnection, rememberCatalogNode } from "../session"
import { loadConnectionCatalog, parseConnectionCatalog, getSessionConnectionCatalog } from "../connection-catalog"
import { createConnectionCatalogReader } from "../connection-catalog"
import type { IncomingMessage } from "node:http"

describe("connection catalog metadata", () => {
  it("returns the authenticated username only to its session, leaving the shared source unchanged", () => {
    const catalog = parseConnectionCatalog([{ host: "valkey", port: "6379", username: "default" }])
    const source = catalog[0]
    const owner = ensureSession({ headers: {}, socket: {} } as IncomingMessage).sessionId
    const stranger = ensureSession({ headers: {}, socket: {} } as IncomingMessage).sessionId
    rememberCatalogNode(owner, source.connectionId, { host: "valkey", port: "6379", username: "reader" }, source.revision)
    authorizeConnection(owner, source.connectionId)
    const active = new Set([source.connectionId])
    const resumed = getSessionConnectionCatalog(catalog, owner, active)[0]
    assert.equal(resumed.connectionDetails.username, "reader")
    assert.equal(resumed.sourceConnectionDetails?.username, "default")
    assert.equal(getSessionConnectionCatalog(catalog, stranger, active)[0].connectionDetails.username, "default")
    assert.equal(source.connectionDetails.username, "default")
  })
  const entry = { host: "blue.example", port: "6379", alias: "Blue", username: "default", endpointType: "cluster-endpoint", db: 0 }

  it("keeps source identity across renames and invalidates endpoint revisions on target changes", () => {
    const [first] = parseConnectionCatalog([{ ...entry, id: "kubernetes-uid" }])
    const [renamed] = parseConnectionCatalog([{ ...entry, id: "kubernetes-uid", alias: "Renamed" }])
    const [moved] = parseConnectionCatalog([{ ...entry, id: "kubernetes-uid", host: "other.example" }])
    assert.equal(first.catalogId, "kubernetes-uid")
    assert.equal(first.revision, renamed.revision)
    assert.notEqual(first.revision, moved.revision)
    assert.throws(() => parseConnectionCatalog([{ ...entry, id: "same" }, { ...entry, id: "same", host: "other" }]), /Duplicate/)
  })

  it("resumes the discovered node only after this session authenticates it, retaining the source catalog identity", () => {
    const catalog = parseConnectionCatalog([entry])
    const sourceId = catalog[0].connectionId
    const node = { host: "pod.blue.example", port: "6379" }
    const nodeConnectionId = buildConnectionId(node.host, node.port, 0)
    const owner = ensureSession({ headers: {}, socket: {} } as IncomingMessage).sessionId
    const stranger = ensureSession({ headers: {}, socket: {} } as IncomingMessage).sessionId
    const active = new Set([nodeConnectionId])
    rememberCatalogNode(owner, sourceId, node, catalog[0].revision)
    assert.equal(getSessionConnectionCatalog(catalog, owner, active)[0].resumeAvailable, false)
    authorizeConnection(owner, nodeConnectionId)
    assert.deepEqual(getSessionConnectionCatalog(catalog, owner, active), [{
      ...catalog[0],
      catalogId: sourceId, connectionId: nodeConnectionId, resumeAvailable: true,
      sourceConnectionDetails: catalog[0].connectionDetails,
      connectionDetails: { ...catalog[0].connectionDetails, ...node, endpointType: "node" },
    }])
    assert.equal(getSessionConnectionCatalog(catalog, stranger, active)[0].connectionId, sourceId)
    assert.equal(getSessionConnectionCatalog(catalog, owner, new Set())[0].resumeAvailable, false)
    revokeConnection(owner, nodeConnectionId)
    assert.equal(getSessionConnectionCatalog(catalog, owner, active)[0].connectionId, sourceId)
    assert.equal(getSessionConnectionCatalog(catalog, owner, active)[0].resumeAvailable, false)
  })

  it("retains only discovery endpoint metadata without credentials alongside a discovered node", () => {
    const catalog = parseConnectionCatalog([{ ...entry, id: "source-id", password: "not-public", secretRef: "private" }])
    const owner = ensureSession({ headers: {}, socket: {} } as IncomingMessage).sessionId
    const node = { host: "pod.blue.example", port: "6379" }
    const nodeConnectionId = buildConnectionId(node.host, node.port, 0)
    authorizeConnection(owner, nodeConnectionId)
    rememberCatalogNode(owner, "source-id", node, catalog[0].revision)
    const reply = getSessionConnectionCatalog(catalog, owner, new Set([nodeConnectionId]))[0]
    assert.equal(reply.connectionDetails.host, "pod.blue.example")
    assert.deepEqual(reply.sourceConnectionDetails, {
      host: "blue.example", port: "6379", alias: "Blue", username: "default", endpointType: "cluster-endpoint",
      db: 0, tls: false, verifyTlsCertificate: true, authType: "password",
    })
    assert.equal(JSON.stringify(reply).includes("not-public"), false)
    assert.equal(JSON.stringify(reply).includes("secretRef"), false)
  })

  it("offers resume only for this session's authorized and still-active connections", () => {
    const catalog = parseConnectionCatalog([entry, { ...entry, host: "green.example" }])
    const [blue, green] = catalog.map((connection) => connection.connectionId)
    const request = { headers: {}, socket: {} } as IncomingMessage
    const owner = ensureSession(request).sessionId
    const stranger = ensureSession(request).sessionId
    const active = new Set([blue, green])
    authorizeConnection(owner, blue)
    assert.deepEqual(getSessionConnectionCatalog(catalog, owner, active).map((c) => c.resumeAvailable), [false, false])
    rememberCatalogNode(owner, blue, catalog[0].connectionDetails, catalog[0].revision)
    assert.deepEqual(getSessionConnectionCatalog(catalog, owner, active).map((c) => c.resumeAvailable), [true, false])
    assert.deepEqual(getSessionConnectionCatalog(catalog, stranger, active).map((c) => c.resumeAvailable), [false, false])
    authorizeConnection(owner, green)
    rememberCatalogNode(owner, green, catalog[1].connectionDetails, catalog[1].revision)
    assert.deepEqual(getSessionConnectionCatalog(catalog, owner, active).map((c) => c.resumeAvailable), [true, true])
    active.delete(blue)
    revokeConnection(owner, green)
    assert.deepEqual(getSessionConnectionCatalog(catalog, owner, active).map((c) => c.resumeAvailable), [false, false])
    assert.deepEqual(getSessionConnectionCatalog(catalog, undefined, active).map((c) => c.resumeAvailable), [false, false])
  })

  it("does not resume a changed revision without an explicit source ID", () => {
    const catalog = parseConnectionCatalog([{ ...entry, endpointType: "node" }])
    const original = catalog[0]
    const owner = ensureSession({ headers: {}, socket: {} } as IncomingMessage).sessionId
    const active = new Set([original.connectionId])
    authorizeConnection(owner, original.connectionId)
    rememberCatalogNode(owner, original.connectionId, original.connectionDetails, original.revision)
    assert.equal(getSessionConnectionCatalog(catalog, owner, active)[0].resumeAvailable, true)

    for (const changes of [{ username: "other-user" }, { tls: true }, { verifyTlsCertificate: false }]) {
      const updated = parseConnectionCatalog([{ ...entry, endpointType: "node", ...changes }])
      assert.equal(updated[0].connectionId, original.connectionId)
      assert.notEqual(updated[0].revision, original.revision)
      assert.equal(getSessionConnectionCatalog(updated, owner, active)[0].resumeAvailable, false)
    }
  })

  it("exports only connection metadata, with no password (including no empty password)", () => {
    const connections = parseConnectionCatalog([{ ...entry, password: "private", caCertPath: "/private/ca", secretRef: "blue" }])
    assert.match(connections[0].revision!, /^[a-f0-9]{64}$/)
    assert.deepEqual(connections, [{
      revision: connections[0].revision,
      connectionId: buildConnectionId("blue.example", "6379", 0),
      connectionDetails: { ...entry, tls: false, verifyTlsCertificate: true, authType: "password" },
    }])
  })

  it("rejects malformed metadata and duplicate connection IDs", () => {
    const invalidCatalogs = [
      null, {}, [{}], [{ ...entry, port: "oops" }], [{ ...entry, db: -1 }],
      [{ ...entry, tls: "false" }], [{ ...entry, endpointType: "other" }], [entry, entry],
    ]
    for (const invalid of invalidCatalogs) {
      assert.throws(() => parseConnectionCatalog(invalid), /catalog/i)
    }
  })

  it("returns an empty catalog when unconfigured and does not read files outside Web mode", () => {
    assert.deepEqual(loadConnectionCatalog(undefined, "Web"), [])
    assert.deepEqual(loadConnectionCatalog("/missing-catalog", "Electron"), [])
    assert.throws(() => loadConnectionCatalog("/missing-catalog", "Web"), /ENOENT/)
  })

  it("shares a cached snapshot across requests and refreshes at most once per second", (t) => {
    let now = 0
    t.mock.method(performance, "now", () => now)
    const directory = mkdtempSync(join(tmpdir(), "valkey-catalog-"))
    const file = join(directory, "connections.json")
    try {
      writeFileSync(file, JSON.stringify([entry]))
      const read = createConnectionCatalogReader(file, "Web")
      const original = read()
      writeFileSync(file, JSON.stringify([{ ...entry, alias: "Updated" }]))
      for (now = 0; now < 1000; now += 100) assert.equal(read(), original)
      const updated = read()
      assert.equal(updated[0].connectionDetails.alias, "Updated")
      writeFileSync(file, "[]")
      now = 1999
      assert.equal(read(), updated)
      now = 2000
      assert.deepEqual(read(), [])
    } finally { rmSync(directory, { recursive: true }) }
  })

  it("reloads valid catalogs and preserves the last good snapshot on a malformed update", (t) => {
    let now = 0
    t.mock.method(performance, "now", () => now)
    const warning = t.mock.method(console, "warn", () => {})
    const directory = mkdtempSync(join(tmpdir(), "valkey-catalog-"))
    const file = join(directory, "connections.json")
    try {
      writeFileSync(file, JSON.stringify([entry]))
      const read = createConnectionCatalogReader(file, "Web")
      writeFileSync(file, "invalid")
      now = 1000
      assert.equal(read()[0].connectionDetails.alias, "Blue")
      assert.equal(warning.mock.callCount(), 1)
      now = 2000
      assert.equal(read()[0].connectionDetails.alias, "Blue")
      assert.equal(warning.mock.callCount(), 1)
      writeFileSync(file, JSON.stringify([{ ...entry, alias: "Updated" }]))
      now = 2999
      assert.equal(read()[0].connectionDetails.alias, "Blue")
      now = 3000
      assert.equal(read()[0].connectionDetails.alias, "Updated")
      writeFileSync(file, "[]")
      now = 4000
      assert.deepEqual(read(), [])
    } finally { rmSync(directory, { recursive: true }) }
  })
})
