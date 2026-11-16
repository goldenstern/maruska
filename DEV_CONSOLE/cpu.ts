// DEV CONSOLE — CPU monitor (T95, async rework T98).
// Delta CPU-time across processes: short sample (2-5s) ΔTotalProcessorTime
// / (cores × Δt) → % load. Avoids WMI LoadPercentage lies (0% at peak).
// Two thresholds: ~70% warning (defer non-urgent dispatches), ~90% hard stop
// (block new heavy ops, kill runaway processes, inject alarm to panel).
//
// T98 (event-loop safety): the probe never blocks anymore —
//   * no busy-wait: the sample window is `await sleep(dtMs)`;
//   * no execFileSync: promisified execFile (powershell) for both snapshots;
//   * hot-path (dispatch / execute.before → cpuGate()) is synchronous on the
//     cached `lastSample` and only *kicks* a background refresh (fire&forget);
//   * the background sampler (30-60s) is async.
// Thresholds (70/90), hysteresis (-5%) and 🟡/🔴 semantics are unchanged.

import { execFile, execFileSync, spawnSync } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const PS_SNAPSHOT_CMD =
  "(Get-Process | ForEach-Object {$_.TotalProcessorTime.TotalMilliseconds} | Measure-Object -Sum).Sum"
const PS_COUNTER_CMD =
  "Get-Counter -Counter '\\Process(*)\\% Processor Time' -SampleInterval 1 -MaxSamples 1 | Select-Object -ExpandProperty CounterSamples | Where-Object {$_.InstanceName -ne '_total'} | Measure-Object -Property CookedValue -Sum | Select-Object -ExpandProperty Sum"

export interface CpuSample {
  pct: number           // % load (0..100+)
  cores: number         // logical cores
  dtMs: number          // sample window (ms)
  ts: number            // timestamp (Date.now())
  raw: number           // raw delta CPU time (ms across all processes)
}

export interface CpuState {
  lastSample: CpuSample | null
  peakPct: number       // highest pct seen this session
  warningActive: boolean
  hardStopActive: boolean
  backgroundTimer: ReturnType<typeof setInterval> | null
  lastBackgroundAt: number
  lastProbeAt: number
  sampleCount: number
}

const CPU_WARNING_PCT = 70    // ~70% — предупреждение, откладывание неторопливых диспатчей
const CPU_HARD_STOP_PCT = 90  // ~90% — ЖЁСТКИЙ СТОП: новые тяжёлые не стартуют, runaway убиваются
const CPU_PROBE_INTERVAL_MS = 30_000  // фоновый сэмпл 30-60с (только когда живы агенты)
const CPU_PROBE_MAX_INTERVAL_MS = 60_000
const CPU_SAMPLE_DURATION_MS = 3000 // 3с сэмпл (компромисс: точность vs накладные расходы)
const CPU_HOT_REFRESH_GAP_MS = 5000  // hot-path не плодит пробы чаще раза в 5с (T98)

let cpuState: CpuState = {
  lastSample: null,
  peakPct: 0,
  warningActive: false,
  hardStopActive: false,
  backgroundTimer: null,
  lastBackgroundAt: 0,
  lastProbeAt: 0,
  sampleCount: 0,
}

/** One probe at a time: concurrent callers share the same promise/result. */
let probeInFlight: Promise<CpuSample | null> | null = null
/** Identity guard — a shared sample must not be applied to the state twice. */
let appliedSample: CpuSample | null = null
/** When the background refresh was last *started* (throttle for cpuGate()). */
let lastRefreshAt = 0

/** Run powershell asynchronously — never blocks the event loop (T98). */
async function runPowerShell(command: string, timeoutMs = 5000): Promise<string> {
  const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  })
  return String(stdout).trim()
}

/** Get logical core count (cached, async — T98). */
let coreCountCache: number | null = null
async function getCoreCount(): Promise<number> {
  if (coreCountCache !== null) return coreCountCache
  try {
    const out = await runPowerShell("(Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors")
    const n = parseInt(out, 10)
    if (Number.isFinite(n) && n > 0) {
      coreCountCache = n
      return n
    }
  } catch { /* fall through */ }
  // Fallback: try env
  const env = parseInt(process.env.NUMBER_OF_PROCESSORS ?? "", 10)
  if (Number.isFinite(env) && env > 0) {
    coreCountCache = env
    return env
  }
  coreCountCache = 4 // safe default
  return coreCountCache
}

/** One Δt snapshot of the summed TotalProcessorTime (null = failed). */
async function snapshotTotalCpuMs(): Promise<number | null> {
  try {
    const out = await runPowerShell(PS_SNAPSHOT_CMD)
    const t = parseFloat(out)
    if (Number.isFinite(t) && t >= 0) return t
    return null
  } catch {
    return null
  }
}

/** The actual sampling worker — always async, no busy-wait (T98). */
async function probeCpuOnce(): Promise<CpuSample | null> {
  const cores = await getCoreCount()
  const dtMs = CPU_SAMPLE_DURATION_MS

  // Snapshot 1: Get-Process *.TotalProcessorTime (sum across all processes)
  // TotalProcessorTime is a TimeSpan, so we convert each to TotalMilliseconds then sum
  const t1 = await snapshotTotalCpuMs()

  if (t1 === null) {
    // Fallback: Win32_PerfRawData_PerfProc_Process raw counters (Get-Counter is
    // unreliable per T95 — use only as last resort)
    try {
      const out = await runPowerShell(PS_COUNTER_CMD)
      const v = parseFloat(out)
      if (Number.isFinite(v) && v >= 0) {
        // This is already a % (per core), sum across processes = total % across all cores
        return {
          pct: Math.min(v, cores * 100),
          cores,
          dtMs: 1000,
          ts: Date.now(),
          raw: v * cores * 10, // approximate
        }
      }
    } catch { /* both failed */ }
    return null
  }

  // Wait Δt — event loop stays free (T98: sleep, not busy-wait)
  const startWait = Date.now()
  await sleep(dtMs)

  // Snapshot 2
  const t2 = await snapshotTotalCpuMs()
  if (t2 === null) return null

  const actualDtMs = Math.max(1, Date.now() - startWait)
  const deltaMs = t2 - t1
  if (deltaMs < 0) return null // time went backwards (unlikely)

  // % load = (delta CPU ms across all processes) / (cores × actual Δt ms) × 100
  const pct = (deltaMs / (cores * actualDtMs)) * 100

  const sample: CpuSample = {
    pct: Math.round(pct * 10) / 10, // one decimal
    cores,
    dtMs: actualDtMs,
    ts: Date.now(),
    raw: deltaMs,
  }

  return sample
}

/** One short probe: two Get-Process snapshots Δt apart, returns % load. */
export function probeCpu(): Promise<CpuSample | null> {
  if (probeInFlight) return probeInFlight // шерим пробу, не плодим параллельные
  const run = probeCpuOnce().then(
    (sample) => {
      probeInFlight = null
      return sample
    },
    () => {
      probeInFlight = null
      return null
    },
  )
  probeInFlight = run
  return run
}

/** True while a probe is running — hot-path never waits on it (T98). */
export function isCpuProbeRunning(): boolean {
  return probeInFlight !== null
}

/** Update state with a new sample, return threshold status. */
export function updateCpuState(sample: CpuSample): { warning: boolean; hardStop: boolean; peak: number } {
  cpuState.lastSample = sample
  cpuState.sampleCount += 1
  cpuState.lastProbeAt = sample.ts

  if (sample.pct > cpuState.peakPct) {
    cpuState.peakPct = sample.pct
  }

  const wasWarning = cpuState.warningActive
  const wasHardStop = cpuState.hardStopActive

  cpuState.warningActive = sample.pct >= CPU_WARNING_PCT
  cpuState.hardStopActive = sample.pct >= CPU_HARD_STOP_PCT

  // Hysteresis: don't flicker at boundary — require drop below threshold - 5%
  if (wasWarning && !cpuState.warningActive && sample.pct > CPU_WARNING_PCT - 5) {
    cpuState.warningActive = true
  }
  if (wasHardStop && !cpuState.hardStopActive && sample.pct > CPU_HARD_STOP_PCT - 5) {
    cpuState.hardStopActive = true
  }

  return {
    warning: cpuState.warningActive,
    hardStop: cpuState.hardStopActive,
    peak: cpuState.peakPct,
  }
}

export interface CpuStatus {
  warning: boolean
  hardStop: boolean
  sample: CpuSample | null
  peak: number
}

function cachedStatus(sample: CpuSample | null = cpuState.lastSample): CpuStatus {
  return {
    warning: cpuState.warningActive,
    hardStop: cpuState.hardStopActive,
    sample,
    peak: cpuState.peakPct,
  }
}

/** Probe CPU and update state. Returns current status. Async (T98). */
export async function probeAndUpdate(): Promise<CpuStatus> {
  try {
    const sample = await probeCpu()
    if (!sample) return cachedStatus()
    if (sample === appliedSample) return { ...cachedStatus(sample) } // уже применён (шеренный промис)
    appliedSample = sample
    const status = updateCpuState(sample)
    return { ...status, sample }
  } catch (e) {
    console.error("[dev-console] cpu probe:", e)
    return cachedStatus()
  }
}

/**
 * Фоновое обновление пробы: запускается из hot-path и НЕ ждётся (T98).
 * Один инстанс за раз + троттлинг CPU_HOT_REFRESH_GAP_MS.
 */
export function refreshCpuInBackground(): void {
  if (probeInFlight) return
  const now = Date.now()
  if (now - lastRefreshAt < CPU_HOT_REFRESH_GAP_MS) return
  lastRefreshAt = now
  void probeAndUpdate()
}

/** Probe before spawn/dispatch — returns whether to allow/block/defer. */
export interface CpuGateResult {
  allow: boolean        // false = hard stop (block entirely)
  defer: boolean        // true = warning zone (defer non-urgent)
  sample: CpuSample | null
  peak: number
  reason: string
}

/**
 * HOT-PATH (dispatch / execute.before) — синхронно и без блокировки (T98):
 * читает кэш cpuState.lastSample и запускает фоновое обновление пробы,
 * НЕ дожидаясь его. Пороги/гистерезис считает updateCpuState (не меняются).
 */
export function cpuGate(): CpuGateResult {
  refreshCpuInBackground()
  const { warning: warningActive, hardStop: hardStopActive, sample, peak } = cachedStatus()
  if (hardStopActive) {
    return { allow: false, defer: false, sample, peak, reason: `CPU ${sample?.pct ?? "?"}% ≥ ${CPU_HARD_STOP_PCT}% — HARD STOP` }
  }
  if (warningActive) {
    return { allow: true, defer: true, sample, peak, reason: `CPU ${sample?.pct ?? "?"}% ≥ ${CPU_WARNING_PCT}% — WARNING` }
  }
  return { allow: true, defer: false, sample, peak, reason: `CPU ${sample?.pct ?? "?"}% OK` }
}

/** Start background sampling (only when agents are alive). Async (T98). */
export function startCpuBackground(hasLiveAgents: () => boolean): void {
  if (cpuState.backgroundTimer) return // already running
  cpuState.backgroundTimer = setInterval(() => {
    if (!hasLiveAgents()) {
      // No live agents — stop background sampling to save resources
      stopCpuBackground()
      return
    }
    const now = Date.now()
    // Adaptive interval: 30s if load > 50%, 60s otherwise
    const interval = cpuState.lastSample && cpuState.lastSample.pct > 50 ? CPU_PROBE_INTERVAL_MS : CPU_PROBE_MAX_INTERVAL_MS
    if (now - cpuState.lastBackgroundAt >= interval) {
      cpuState.lastBackgroundAt = now
      void probeAndUpdate() // не блокируем тик таймера (T98)
    }
  }, 5000) // check every 5s whether to sample
}

/** Stop background sampling. */
export function stopCpuBackground(): void {
  if (cpuState.backgroundTimer) {
    clearInterval(cpuState.backgroundTimer)
    cpuState.backgroundTimer = null
  }
}

/** Get current CPU state for panel/diag. */
export function getCpuState(): { warning: boolean; hardStop: boolean; lastSample: CpuSample | null; peak: number; sampleCount: number } {
  return {
    warning: cpuState.warningActive,
    hardStop: cpuState.hardStopActive,
    lastSample: cpuState.lastSample,
    peak: cpuState.peakPct,
    sampleCount: cpuState.sampleCount,
  }
}

/** Kill runaway processes (top CPU consumers) — Windows taskkill by PID. */
export function killRunawayProcesses(topN: number = 3): { killed: number; pids: number[] } {
  try {
    // Get top CPU processes (excluding system/idle)
    const out = execFileSync("powershell", [
      "-NoProfile", "-Command",
      `Get-Process | Where-Object {$_.Id -ne $pid -and $_.Id -ne 4 -and $_.CPU -gt 0} | Sort-Object CPU -Descending | Select-Object -First ${topN} Id, ProcessName, CPU | ConvertTo-Json -Compress`
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, windowsHide: true }).trim()

    const procs = JSON.parse(out)
    const list = Array.isArray(procs) ? procs : [procs]
    const pids: number[] = []
    for (const p of list) {
      if (p.Id && typeof p.Id === "number") {
        try {
          spawnSync("taskkill", ["/F", "/PID", String(p.Id)], { stdio: "ignore", windowsHide: true })
          pids.push(p.Id)
        } catch { /* ignore */ }
      }
    }
    return { killed: pids.length, pids }
  } catch {
    return { killed: 0, pids: [] }
  }
}

/** Reset CPU state (for testing). */
export function resetCpuState(): void {
  cpuState = {
    lastSample: null,
    peakPct: 0,
    warningActive: false,
    hardStopActive: false,
    backgroundTimer: null,
    lastBackgroundAt: 0,
    lastProbeAt: 0,
    sampleCount: 0,
  }
  lastRefreshAt = 0 // тесты: следующий cpuGate() снова запускает фоновую пробу
}
