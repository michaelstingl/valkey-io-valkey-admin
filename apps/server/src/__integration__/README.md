# Integration tests

End-to-end tests that drive the server's WebSocket API against a live Valkey stack containing a 6-node cluster, a standalone instance for database-aware connections, and a separate ACL-protected instance for connection catalog tests. All come up from a single docker-compose file.

## Quick run

```bash
docker compose -f docker/docker-compose.test.yml up -d --build --wait
npm run test:integration
docker compose -f docker/docker-compose.test.yml down -v
```

## Stack

- **Cluster:** `valkey-7001..7006` on ports `7001..7006`. Initialized by the `cluster-init` service and seeded by `populate`. Used by `cluster-topology`, `connection`, `key-browser`, `monitoring`, and `send-command` integration tests via `defaultConnectionDetails()`.
- **Standalone:** `valkey-standalone` on port `6379`. No ACL, no cluster mode. Used by the "two databases" test in `connection.integration.test.ts` via `defaultStandaloneConnectionDetails(db)` to verify that `(host, port, db)` triples produce isolated clients.

## Connection catalog

`valkey-catalog` has a disabled default user and a password-protected read-only `reader` user, configured in `docker/test-catalog/users.acl`. These are disposable test credentials. The suite covers catalog updates, authentication, username overrides, session resume and cluster discovery.

Both the server and ACL fixture mount `docker/test-catalog/` read-only. The test process atomically replaces `connections.json` on the host and restores the original bytes after each test. It polls for the expected catalog snapshot because Docker Desktop file sharing can propagate updates asynchronously. Run only one catalog suite against a given checkout and server. If a run is forcibly killed, reset `docker/test-catalog/connections.json` to `[]` before restarting the stack.

The WebSocket helper accepts an optional cookie and exposes the cookie returned by the upgrade response. New clients use fresh sessions by default. The reload test opens a new socket with the original cookie and sends no password for resume.

## Note

Cases within each suite run serially. The catalog suite uses a dedicated standalone host and cluster database 9 to avoid the existing suites' connection IDs. Each `connectionId` is `buildConnectionId(host, port, db)`, so tests targeting the same `host:port` with the default `db: 0` share an id. The two-database test intentionally uses two distinct `connectionId`s to exercise per-`db` keying.
