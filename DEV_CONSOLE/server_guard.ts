// DEV CONSOLE — project-scoped server registry and deterministic server queue.
// Extracted from the plugin entrypoint; no OpenCode runtime dependency.

import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { serverQueueAdd, serverQueueTake, serverReservationActive, type ServerWaiter } from "./state.ts"

// ------------------------------------------------ Server Guard (T94) -----
// ≤1 dev server per repo/folder: probe registry (DEVATA/servers.json) by
// canonical path + kind. Live PID → reuse; dead/orphaned → kill + cleanup;
// none → spawn via factory, record entry. Survives plugin reloads.
export interface ServerEntry {
  pid: number
  port: number
  startedAt: string
  kind: string
  canonicalPath: string
  owner?: string // кто держит (panel = сама консоль)
  reserved_for?: string // T94: бронь голове очереди после release (pid=0)
  reserved_at?: string // T94: время брони — живёт SERVER_RESERVE_TTL_MS
}

export interface ServerRegistry {
  // КЛЮЧ = путь + вид (canonicalPath::kind). До 11.11 ключ был только путём:
  // панель-канал и тест-сервер одного репо затирали друг друга (а заодно
  // ломалась бронь очереди). Теперь вид — часть ключа: ≤1 сервер на (репо, вид).
  [slot: string]: ServerEntry
}

export const SERVER_REGISTRY_FILE = "servers.json"
// T94-очередь ожидающих сервер репо (детерминированно, без ИИ-логики)
export const SERVER_QUEUE_FILE = "servers.queue.json"

// T94: фоновой запуск команды задачи (dev/test-сервер). detached + тихий вывод:
// консоль не должна мигать окном и не должна держать процесс за собой.
// Возвращает pid — он же попадает в реестр (потом сервер можно переиспользовать).
export function spawnDetached(cmd: string, cwd: string): { pid: number } | null {
  try {
    const child = spawn(cmd, {
      cwd: existsSync(cwd) ? cwd : undefined,
      shell: true,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    })
    child.unref()
    if (typeof child.pid !== "number" || child.pid <= 0) return null
    return { pid: child.pid }
  } catch (e) {
    console.error("[dev-console] spawnDetached:", e)
    return null
  }
}

export class ServerGuard {
  private registry: ServerRegistry = {}
  private root: string
  private loaded = false

  constructor(root: string) {
    this.root = root
  }

  private registryPath(): string {
    return join(this.root, "DEVATA", SERVER_REGISTRY_FILE)
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    const path = this.registryPath()
    if (!existsSync(path)) return
    try {
      const raw = readFileSync(path, "utf8").trim()
      if (raw) this.registry = JSON.parse(raw) as ServerRegistry
    } catch (e) {
      console.error("[dev-console] ServerGuard: failed to load registry:", e)
      this.registry = {}
    }
  }

  private save(): void {
    try {
      const path = this.registryPath()
      const dir = join(this.root, "DEVATA")
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(path, JSON.stringify(this.registry, null, 2), "utf8")
    } catch (e) {
      console.error("[dev-console] ServerGuard: failed to save registry:", e)
    }
  }

  // Check if a PID is alive on Windows (tasklist)
  private isPidAlive(pid: number): boolean {
    try {
      // windowsHide: спрятать окно консоли (жалоба Основателя 08.10: мигание cmd/PowerShell)
      const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      })
      const out = result.stdout?.toString() ?? ""
      return out.includes(`"${pid}"`)
    } catch {
      return false
    }
  }

  // Check if a port is in use (netstat)
  private isPortInUse(port: number): boolean {
    return this.portOwner(port) !== null
  }

  // Кто РЕАЛЬНО слушает порт (pid из netstat -ano). Нужно для честной живости:
  // слот «тест-сервер ARTHUR:8765» мог остаться в реестре, пока порт держал
  // уже другой процесс (питон галереи) — reuse обязан отдать ТОГО, кто слушает.
  private portOwner(port: number): number | null {
    try {
      const result = spawnSync("netstat", ["-ano", "-p", "TCP"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      })
      const out = result.stdout?.toString() ?? ""
      for (const line of out.split(/\r?\n/)) {
        if (!line.includes("LISTENING")) continue
        if (!line.includes(`:${port} `)) continue
        const m = line.trim().match(/\s(\d+)\s*$/)
        if (m) {
          const pid = Number(m[1])
          if (Number.isFinite(pid) && pid > 0) return pid
        }
      }
      return null
    } catch {
      return null
    }
  }

  // Kill a PID (taskkill /F)
  private killPid(pid: number): boolean {
    try {
      spawnSync("taskkill", ["/F", "/PID", String(pid)], {
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      })
      return true
    } catch {
      return false
    }
  }

  // Clean up orphaned entries on load
  private cleanupOrphans(): void {
    let changed = false
    for (const [slot, entry] of Object.entries(this.registry)) {
      // T94: бронь (pid=0, reserved_for) — не сирота; живёт до TTL или до спавна
      if (entry.pid === 0 && serverReservationActive(entry)) continue
      const pidAlive = this.isPidAlive(entry.pid)
      const portAlive = this.isPortInUse(entry.port)
      if (!pidAlive || !portAlive) {
        // SAFETY (оркестратор, T94 12:05): НИКОГДА не убивать хост-процесс —
        // панель-канал живёт ВНУТРИ сервиса (entry.pid === process.pid), и
        // «порт умер при живом хосте» (гонка/ошибка netstat) означал бы
        // taskkill всего opencode-сервиса = инцидент-класс (не рестартовать).
        // Хост-запись просто удаляем — listener поднимется заново.
        if (pidAlive && entry.pid !== process.pid) this.killPid(entry.pid)
        console.log(
          `[dev-console] ServerGuard: cleaned orphan ${entry.kind} for ${entry.canonicalPath} (pid=${entry.pid}, port=${entry.port}, pidAlive=${pidAlive}, portAlive=${portAlive})`,
        )
        delete this.registry[slot]
        changed = true
      }
    }
    if (changed) this.save()
  }

  private queuePath(): string {
    return join(this.root, "DEVATA", SERVER_QUEUE_FILE)
  }

  private loadQueue(): ServerWaiter[] {
    const path = this.queuePath()
    if (!existsSync(path)) return []
    try {
      const raw = readFileSync(path, "utf8").trim()
      const arr = raw ? (JSON.parse(raw) as unknown) : []
      return Array.isArray(arr) ? (arr as ServerWaiter[]) : []
    } catch (e) {
      console.error("[dev-console] ServerGuard: failed to load queue:", e)
      return []
    }
  }

  private saveQueue(q: ServerWaiter[]): void {
    try {
      const dir = join(this.root, "DEVATA")
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.queuePath(), JSON.stringify(q, null, 2), "utf8")
    } catch (e) {
      console.error("[dev-console] ServerGuard: failed to save queue:", e)
    }
  }

  // T94: встать в очередь на сервер репо. Идемпотентно; возвращает позицию (1-based).
  enqueue(canonicalPath: string, kind: string, owner: string): number {
    const q = serverQueueAdd(this.loadQueue(), { path: canonicalPath, owner, kind, since: new Date().toISOString() })
    this.saveQueue(q)
    // Queue position is scoped to one (project, server kind), not the global
    // file order: waiters in another repo must not inflate this owner's rank.
    const scoped = q.filter((x) => x.path === canonicalPath && x.kind === kind)
    const idx = scoped.findIndex((x) => x.owner === owner)
    return idx < 0 ? 0 : idx + 1
  }

  // Слот реестра: путь + вид. Панель-канал и тест-сервер одного репо — разные
  // слоты (до 11.11 ключ был только путём → затирали друг друга).
  private slotKey(canonicalPath: string, kind: string): string {
    return `${canonicalPath}::${kind}`
  }

  // Живой сервер в слоте (порт слушает) — для решения reuse/spawn/queue.
  // Владелец порта сверяется с netstat: запись реестра может устареть (сервер
  // перезапущен руками) — тогда ПРАВДА = тот, кто реально слушает порт.
  liveIn(canonicalPath: string, kind: string): { pid: number; port: number } | null {
    this.load()
    const entry = this.registry[this.slotKey(canonicalPath, kind)]
    if (!entry || entry.pid === 0) return null
    if (!this.isPortInUse(entry.port)) return null
    const owner = this.portOwner(entry.port)
    if (owner === null) return null
    if (owner !== entry.pid) {
      // Порт перехвачен другим процессом — перепривязываем запись на него
      // (сервер жив, просто не тот pid: reuse обязан отдать рабочий порт).
      entry.pid = owner
      this.save()
      console.log(
        `[dev-console] ServerGuard: ${kind} для ${canonicalPath} — порт ${entry.port} держит pid=${owner} (в реестре был ${entry.pid}) → перепривязано`,
      )
    }
    return { pid: owner, port: entry.port }
  }

  // Зарегистрировать поднятый задачей сервер (тот же путь, что и панель-канал):
  // следующий запрос по (репо, вид) получит reuse вместо второго спавна.
  register(canonicalPath: string, kind: string, pid: number, port: number, owner: string): void {
    this.load()
    this.registry[this.slotKey(canonicalPath, kind)] = {
      pid,
      port,
      startedAt: new Date().toISOString(),
      kind,
      canonicalPath,
      owner,
    }
    this.save()
  }

  // Кто держит бронь на слот (или null).
  reservedIn(canonicalPath: string, kind: string): string | null {
    this.load()
    const entry = this.registry[this.slotKey(canonicalPath, kind)]
    if (!entry || entry.pid !== 0) return null
    if (!serverReservationActive(entry)) return null
    return entry.reserved_for ?? null
  }

  // Очередь ожидающих по (репо, вид).
  waitersFor(canonicalPath: string, kind: string): ServerWaiter[] {
    return this.loadQueue().filter((q) => q.path === canonicalPath && q.kind === kind)
  }

  // Public: spawn or reuse a server for a directory + kind
  // factory = () => Promise<{ port: number; pid: number }>
  async spawn<T extends { port: number; pid: number }>(
    canonicalPath: string,
    kind: string,
    factory: () => Promise<T>,
    owner: string = "panel",
  ): Promise<T & { reused: boolean }> {
    this.load()
    this.cleanupOrphans()

    const slot = this.slotKey(canonicalPath, kind)
    const existing = this.registry[slot]
    if (existing && existing.kind === kind) {
      // T94 (заказ 11.11): бронь после release (pid=0) — владелец забирает сам,
      // остальные детерминированно встают в очередь; протухшая бронь снимается.
      const reserved = existing.pid === 0 && serverReservationActive(existing)
      if (reserved && existing.reserved_for !== owner && owner !== "panel") {
        const pos = this.enqueue(canonicalPath, kind, owner)
        throw new Error(`server busy: ${canonicalPath} зарезервирован за ${existing.reserved_for} (ты #${pos} в очереди)`)
      }
      if (reserved) {
        delete this.registry[slot]
        this.save()
        console.log(`[dev-console] ServerGuard: RESERVATION taken by ${owner} for ${canonicalPath}`)
      } else if (existing.pid !== 0) {
        const pidAlive = this.isPidAlive(existing.pid)
        const portAlive = this.isPortInUse(existing.port)
        if (pidAlive && portAlive) {
          console.log(`[dev-console] ServerGuard: REUSE ${kind} for ${canonicalPath} → pid=${existing.pid}, port=${existing.port}`)
          return { port: existing.port, pid: existing.pid, reused: true } as T & { reused: boolean }
        }
        // Dead/orphaned → remove; kill только ЧУЖОЙ процесс, не хост (SAFETY выше)
        if (pidAlive && existing.pid !== process.pid) this.killPid(existing.pid)
        console.log(`[dev-console] ServerGuard: ORPHAN cleanup ${kind} for ${canonicalPath} (pid=${existing.pid}, port=${existing.port})`)
        delete this.registry[slot]
        this.save()
      }
    }

    // Spawn new
    console.log(`[dev-console] ServerGuard: SPAWN ${kind} for ${canonicalPath}`)
    const result = await factory()
    this.registry[slot] = {
      pid: result.pid,
      port: result.port,
      startedAt: new Date().toISOString(),
      kind,
      canonicalPath,
      owner,
    }
    this.save()
    return { ...result, reused: false }
  }

  // Get existing entry without spawning
  get(canonicalPath: string, kind = "panel-channel"): ServerEntry | null {
    this.load()
    return this.registry[this.slotKey(canonicalPath, kind)] ?? null
  }

  // Remove entry (e.g., on explicit shutdown) + T94: автодерг ожидающего —
  // release передаёт бронь ГОЛОВЕ очереди детерминированно (FIFO), бронь
  // живёт SERVER_RESERVE_TTL_MS, чтобы призрак не держал сервер вечно.
  release(canonicalPath: string, kind = "panel-channel"): { handoff: string | null; waiting: number } {
    this.load()
    const slot = this.slotKey(canonicalPath, kind)
    const { next, rest } = serverQueueTake(
      this.loadQueue().filter((q) => q.path === canonicalPath && q.kind === kind),
      canonicalPath,
    )
    delete this.registry[slot]
    if (next) {
      this.registry[slot] = {
        pid: 0,
        port: 0,
        startedAt: new Date().toISOString(),
        kind: next.kind,
        canonicalPath,
        reserved_for: next.owner,
        reserved_at: new Date().toISOString(),
      }
      // Очередь фильтруем по (путь, вид) — остальные слоты не трогаем.
      const others = this.loadQueue().filter((q) => !(q.path === canonicalPath && q.kind === kind))
      // `rest` already contains only the remaining waiters for this slot;
      // preserve them after handing the reservation to the FIFO head.
      this.saveQueue([...others, ...rest])
      console.log(`[dev-console] ServerGuard: RELEASE ${canonicalPath} → бронь ${next.owner} (ждут ещё ${rest.length})`)
    } else {
      const others = this.loadQueue().filter((q) => !(q.path === canonicalPath && q.kind === kind))
      this.saveQueue(others)
    }
    this.save()
    return { handoff: next?.owner ?? null, waiting: rest.length }
  }
}

