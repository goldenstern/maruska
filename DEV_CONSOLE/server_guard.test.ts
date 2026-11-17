import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ServerGuard, SERVER_REGISTRY_FILE, SERVER_QUEUE_FILE } from "./server_guard.ts"

test("ServerGuard: registry persists within a project and is isolated between roots", () => {
  const rootA = mkdtempSync(join(tmpdir(), "server-guard-a-"))
  const rootB = mkdtempSync(join(tmpdir(), "server-guard-b-"))
  try {
    const first = new ServerGuard(rootA)
    first.register("C:/repo-a", "test", 1234, 43001, "A1")

    const restored = new ServerGuard(rootA)
    const entry = restored.get("C:/repo-a", "test")
    assert.equal(entry?.pid, 1234)
    assert.equal(entry?.port, 43001)
    assert.equal(entry?.owner, "A1")
    assert.equal(new ServerGuard(rootB).get("C:/repo-a", "test"), null, "другой root не видит чужой реестр")

    const registry = JSON.parse(readFileSync(join(rootA, "DEVATA", SERVER_REGISTRY_FILE), "utf8"))
    assert.deepEqual(Object.keys(registry), ["C:/repo-a::test"])
  } finally {
    rmSync(rootA, { recursive: true, force: true })
    rmSync(rootB, { recursive: true, force: true })
  }
})

test("ServerGuard: queue hands off a slot in FIFO order and persists the reservation", () => {
  const root = mkdtempSync(join(tmpdir(), "server-guard-queue-"))
  try {
    const guard = new ServerGuard(root)
    assert.equal(guard.enqueue("C:/repo", "test", "A1"), 1)
    assert.equal(guard.enqueue("C:/repo", "test", "A1"), 1, "повторная заявка идемпотентна")
    assert.equal(guard.enqueue("C:/repo", "test", "A2"), 2)
    assert.equal(guard.enqueue("C:/other", "test", "A3"), 1, "другой репозиторий имеет отдельную очередь")

    const released = guard.release("C:/repo", "test")
    assert.deepEqual(released, { handoff: "A1", waiting: 1 })
    assert.equal(guard.reservedIn("C:/repo", "test"), "A1")
    assert.deepEqual(guard.waitersFor("C:/repo", "test").map((item) => item.owner), ["A2"])
    assert.deepEqual(guard.waitersFor("C:/other", "test").map((item) => item.owner), ["A3"])

    const queue = JSON.parse(readFileSync(join(root, "DEVATA", SERVER_QUEUE_FILE), "utf8"))
    assert.equal(queue.length, 2, "в очереди остались A2 и независимый A3")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
