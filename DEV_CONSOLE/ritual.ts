// T119 · РИТУАЛ САМОРЕФЛЕКСИИ «ПАПА, А МЫ…» — прототип (ночной фикс +
// внеочередной после крупной/аварийной волны). Канон: DEVATA/RITUAL_PAPA_A_MY.md.
//
// Чистый модуль (как state.ts): без импортов OpenCode, только читает леджер.
// ВХОДЫ (из канона T119): T84 modelStats.byClass, T66/T109 кулдауны и отказы,
// исходы волн (tasks/agents в окне), T97/T118 качество (пустые прогоны,
// самоотчёты, orientation-hell, plan_acc). МЕЖПРОЕКТНЫЙ СОВЕТ: ключ = имя
// инстанса (T103/T116 EXPERIENCE_CORE — после его F1 instanceNameOf должен
// переимпортироваться из experience.ts, здесь — локальная копия канона §3).
//
// ВЫХОДЫ: (1) самоотчёт по вкладкам проекта, (2) сводимый пост «папа, а мы…»
// в ленту (человекочитаемый — T120), (3) РЕШЕНИЯ по моделям, которые ложатся
// в выбор моделей через НАСТОЯЩИЙ chooseModelByClass(state.ts) с правилом
// доступности T121: здоровая база = health-check + free-линия; недоступная
// модель (инцидент 28.10: офф-подписка при оплаченном Go) никогда не
// выбирается — ни warmup, ни argmax, ни фолбэком.

import {
  type Ledger,
  type TaskClass,
  INSTANCE_PERSONA,
  INSTANCE_EMOJI,
  DAEMON_EMOJI,
  POLICY_MODELS,
  CHILD_KEYS,
  CHILD_KEY_TO_MODEL,
  modelForKey,
  shortModelKey,
  modelStats,
  chooseModelByClass,
} from "./state.ts"
import { resolvePersona } from "./personas.ts"

export const RITUAL_ID = "T119"

// ------------------------------------------------------------ окна ритуала --
export interface RitualWindow {
  kind: "nightly" | "post-wave"
  from: number // ms, включительно
  to: number // ms, включительно
}

export const NIGHTLY_MS = 24 * 3600_000
export function nightlyWindow(at: number): RitualWindow {
  return { kind: "nightly", from: at - NIGHTLY_MS, to: at }
}
export function waveWindow(at: number, waveStart: number): RitualWindow {
  return { kind: "post-wave", from: waveStart, to: at }
}

// ------------------------------------------------- имя инстанса (T116 §3) --
// Локальная копия канона EXPERIENCE_CORE §3: хвост титула «<тема> · <имя>»;
// локальное имя вне каталога — местное и неприкосновенное (НЕ склеивается с
// INSTANCE_PERSONA, чтобы чужой проект не открывал presence-гейт).
// TODO(T116 F1): переименовать в re-export из experience.ts — один канон.
// T116 F1 ВЫПОЛНЕН: канон = experience.ts instanceNameOf (§3: хвост после
// последнего «·», каталог решает; локальное имя не склеивается с базовой).
// ritual.ts импортирует его — второго источника нет (доктрина «один канон»).
import { instanceNameOf } from "./experience.ts"

// ------------------------------------------------------- самоотчёт вкладки --
export interface InstanceReport {
  instance: string // имя инстанса (ключ межпроектного совета)
  spawned: number // демоны в окне
  done: number
  failed: number
  running: number
  emptyRuns: number // completed без эдитов (T41)
  noSelfReports: number // completed без текста самоотчёта (T97)
  orientationHells: number // пометки orientation-hell (T97)
  avgPlanAcc: number | null // средняя точность эстимейта (T41), null = нет данных
  overrunMin: number // T128: Σ переработки в окне (минут сверх плана у settle'нутых)
  models: Record<string, number> // short-key модели → прогонов в окне
  failures: Array<{ model: string | null; error: string | null; task: string | null }>
}

const inWindow = (iso: string, w: RitualWindow): boolean => {
  const t = Date.parse(iso)
  return Number.isFinite(t) && t >= w.from && t <= w.to
}

function tabTitleOf(ledger: Ledger, agent: Ledger["agents"][number]): string {
  const byHome = ledger.tabs.find((t) => t.session_id === agent.home)
  if (byHome) return byHome.title
  const task = agent.task_id ? ledger.tasks.find((x) => x.id === agent.task_id) : null
  return ledger.tabs.find((t) => t.session_id === task?.session_ref)?.title ?? ""
}

// Самоотчёт по вкладкам проекта в окне: считает исходы, качество (T97/T118)
// и распределение моделей; instance — имя инстанса большинства вкладок.
export function collectInstanceReport(ledger: Ledger, w: RitualWindow): InstanceReport {
  const names = new Map<string, number>()
  for (const tab of ledger.tabs) {
    const n = instanceNameOf(tab.title)
    names.set(n, (names.get(n) ?? 0) + 1)
  }
  let instance = INSTANCE_PERSONA
  for (const [n, c] of names) if (c > (names.get(instance) ?? 0)) instance = n

  const rep: InstanceReport = {
    instance,
    spawned: 0,
    done: 0,
    failed: 0,
    running: 0,
    emptyRuns: 0,
    noSelfReports: 0,
    orientationHells: 0,
    avgPlanAcc: null,
    overrunMin: 0, // T128: переработка — обратная сторона эффективности (T118)
    models: {},
    failures: [],
  }
  let accSum = 0
  let accN = 0
  for (const a of ledger.agents) {
    if (!inWindow(a.updated_at, w)) continue
    rep.spawned += 1
    const key = a.model ? shortModelKey(a.model) : "—"
    rep.models[key] = (rep.models[key] ?? 0) + 1
    if (a.orientation === "hell") rep.orientationHells += 1
    if (a.state === "completed") {
      rep.done += 1
      if (a.counters?.empty_run) rep.emptyRuns += 1
      if (!(a.self_report ?? "").trim()) rep.noSelfReports += 1
    } else if (a.state === "failed") {
      rep.failed += 1
      const task = a.task_id ? ledger.tasks.find((t) => t.id === a.task_id) : null
      if (rep.failures.length < 5) {
        rep.failures.push({ model: a.model, error: task?.agent_error ?? null, task: a.task_id })
      }
    } else {
      rep.running += 1
    }
    if (typeof a.counters?.plan_acc === "number" && Number.isFinite(a.counters.plan_acc)) {
      accSum += a.counters.plan_acc
      accN += 1
    }
    // T128: переработка в окне — минуты сверх плана у settle'нутых записей.
    // Это обратная сторона эффективности (T118): «столько хуярит» ≠ «столько
    // ваты жрёт» — ритуал обсуждает обе величины вместе.
    if (typeof a.counters?.overrun_min === "number" && a.counters.overrun_min > 0) {
      rep.overrunMin += a.counters.overrun_min
    }
  }
  rep.avgPlanAcc = accN > 0 ? accSum / accN : null
  return rep
}

// --------------------------------------------------- доска моделей (T84) ---
export const ALL_CLASSES: readonly TaskClass[] = [
  "qc",
  "dev:small",
  "dev:large",
  "research:small",
  "research:large",
]

export interface BoardRow {
  model: string // полный id
  key: string // short-key (как в Agent.model)
  ok: number
  fail: number
  score: number // Laplace: (ok+1)/(ok+fail+2)
  healthy: boolean // от health-check T121 (база = free-линия)
  quarantine: string | null // карантин ритуала: почему выбывает из базы
  cooldownUntil: string | null
  byClass: Array<{ cls: TaskClass; ok: number; fail: number; runs: number; avgEditsPerSec: number }>
}

export const QUARANTINE_FAIL_RATE = 0.5 // ≥50% отказов при ≥3 прогонах → карантин
export const QUARANTINE_MIN_RUNS = 3

function quarantineOf(stat: { ok: number; fail: number; cooldown_until: string | null } | undefined, at: number): string | null {
  if (!stat) return null
  const until = stat.cooldown_until ? Date.parse(stat.cooldown_until) : NaN
  if (Number.isFinite(until) && until > at) {
    return `кулдаун до ${new Date(until).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`
  }
  const total = stat.ok + stat.fail
  if (total >= QUARANTINE_MIN_RUNS && stat.fail / total >= QUARANTINE_FAIL_RATE) {
    return `отказы ${stat.fail}/${total}`
  }
  return null
}

export function collectBoard(ledger: Ledger, at: number, healthyModels: readonly string[]): BoardRow[] {
  const stats = modelStats(ledger)
  const healthy = new Set(healthyModels)
  // T142: доска = ДЕТСКИЙ пул (free-цепочка + free-пояс). Премиум-канал вкладки
  // и luna на доске не живут — субагент не может быть премиумом НИКОГДА.
  return CHILD_KEYS.map((key) => {
    const model = CHILD_KEY_TO_MODEL[key] ?? modelForKey(key) ?? key
    const stat = stats.find((s) => shortModelKey(s.model) === key)
    const rows: BoardRow["byClass"] = []
    for (const cls of ALL_CLASSES) {
      const c = stat?.byClass?.[cls]
      if (!c) continue
      rows.push({
        cls,
        ok: c.ok,
        fail: c.fail,
        runs: c.runs,
        avgEditsPerSec: c.runs > 0 ? c.editsPerSecSum / c.runs : 0,
      })
    }
    rows.sort((x, y) => y.runs - x.runs)
    const ok = stat?.ok ?? 0
    const fail = stat?.fail ?? 0
    return {
      model,
      key,
      ok,
      fail,
      score: (ok + 1) / (ok + fail + 2),
      healthy: healthy.has(model),
      quarantine: quarantineOf(stat, at),
      cooldownUntil: stat?.cooldown_until ?? null,
      byClass: rows,
    }
  })
}

// ------------------------------------------------ решения: выбор моделей ----
export interface RitualDecision {
  perClass: Array<{ cls: TaskClass; model: string; key: string; reason: string }>
  base: string[] // здоровая база, которой разрешён выбор (полные id)
  quarantined: Array<{ model: string; why: string }>
  guards: string[] // сработавшие защитные правила (инцидент 28.10 и др.)
}

// Правило доступности (T121): выбор делается ТОЛЬКО среди здоровых моделей,
// не в карантине. chooseModelByClass имеет известные дыры фолбэка (state.ts
// ~612-615: пустой доступный пул разворачивается в POLICY_KEYS) — ритуал
// пост-проверяет результат ГАРДом: недоступная модель заменяется лучшей
// здоровой по Laplace-статистике, фиксируется в guards. Пустая здоровая база
// → «вынужденный выбор» (работу останавливать нельзя), тоже в guards.
export function decideModels(
  ledger: Ledger,
  at: number,
  healthyModels: readonly string[] = POLICY_MODELS,
): RitualDecision {
  const board = collectBoard(ledger, at, healthyModels)
  const guards: string[] = []
  const quarantined = board
    .filter((r) => r.quarantine !== null)
    .map((r) => ({ model: r.model, why: r.quarantine as string }))

  let allowed = board.filter((r) => r.healthy && r.quarantine === null)
  if (allowed.length === 0) {
    guards.push("вынужденный выбор: здоровых моделей нет — работа не останавливается, берём лучшую по статистике")
    allowed = [...board].sort((a, b) => b.score - a.score).slice(0, 1)
  }
  const allowedModels = allowed.map((r) => r.model)

  const perClass: RitualDecision["perClass"] = []
  for (const cls of ALL_CLASSES) {
    const picked = chooseModelByClass(ledger, cls, null, allowedModels, at)
    let model = picked.model
    let reason = picked.reason
    const key = shortModelKey(model)
    if (!allowed.some((r) => r.key === key)) {
      const best = [...allowed].sort((a, b) => b.score - a.score)[0]
      guards.push(
        `инцидент 28.10 отражён: ${key} недоступна/в карантине — для ${cls} выбор заменён на ${best.key}`,
      )
      model = best.model
      reason = `ritual-guard: ${best.key} (вместо ${key}: ${picked.reason})`
    }
    perClass.push({ cls, model, key: shortModelKey(model), reason })
  }
  return { perClass, base: allowedModels, quarantined, guards }
}

// ------------------------------------------- гард выбора моделей (T119) ----
// Консервативный пост-гард поверх chooseModelByClass: перебивает выбор ТОЛЬКО
// когда выбранная модель в карантине (кулдаун/≥50% отказов) И есть здоровая
// база. Если здоровых моделей нет — цепочка выбора НЕ перебивается (иначе
// все задачи схлопнулись бы на одну модель — ровно тот отказ, который чиним).
export interface GuardOutcome {
  model: string
  applied: boolean
  why: string
}

export function guardModel(decision: RitualDecision, cls: TaskClass, picked: string): GuardOutcome {
  const pickedKey = shortModelKey(picked)
  if (decision.base.length === 0) {
    return { model: picked, applied: false, why: "здоровой базы нет — цепочку выбора не перебиваем" }
  }
  const row = decision.perClass.find((p) => p.cls === cls)
  if (!row) return { model: picked, applied: false, why: `для класса ${cls} решения нет` }
  if (row.key === pickedKey) return { model: picked, applied: false, why: "ритуал выбрал ту же модель" }
  const quarantined = decision.quarantined.some((q) => shortModelKey(q.model) === pickedKey)
  if (!quarantined) {
    return { model: picked, applied: false, why: "модель не в карантине — статистику не перебиваем" }
  }
  const why = decision.quarantined.find((q) => shortModelKey(q.model) === pickedKey)?.why ?? "карантин"
  return { model: row.model, applied: true, why: `${pickedKey} в карантине (${why}) → ${row.key}` }
}

export interface CouncilEntry {
  project: string // имя/путь проекта
  ledger: Ledger
}
export interface CouncilRow {
  instance: string // ключ = имя инстанса (T103)
  projects: string[]
  spawned: number
  done: number
  failed: number
  failures: string[] // «<проект> <модель>: <error>» — суть, не дамп
}

// ------------------------------------------- межпроектный совет (T116) ------
// Совет по именам: одно имя = одна строка, опыт всех проектов, где оно живёт.
export function councilReports(entries: readonly CouncilEntry[], w: RitualWindow): CouncilRow[] {
  const byName = new Map<string, CouncilRow>()
  for (const e of entries) {
    const rep = collectInstanceReport(e.ledger, w)
    let row = byName.get(rep.instance)
    if (!row) {
      row = { instance: rep.instance, projects: [], spawned: 0, done: 0, failed: 0, failures: [] }
      byName.set(rep.instance, row)
    }
    if (!row.projects.includes(e.project)) row.projects.push(e.project)
    row.spawned += rep.spawned
    row.done += rep.done
    row.failed += rep.failed
    for (const f of rep.failures) {
      if (row.failures.length < 5) row.failures.push(`${e.project} ${f.model ?? "?"}: ${f.error ?? "?"}`)
    }
  }
  return [...byName.values()].sort((a, b) => b.spawned - a.spawned)
}

// ------------------------------------------------- сводный пост в ленту -----
export interface PapaPostInput {
  window: RitualWindow
  report: InstanceReport
  council: CouncilRow[]
  board: BoardRow[]
  decision: RitualDecision
  project: string
}

// Русская форма множественного числа: 1 демон / 2 демона / 5 демонов.
// forms — необязательные «1 / 2-4 / 5» для слов неправильного склонения.
function plural(n: number, word: string, forms?: [string, string, string]): string {
  const m10 = n % 10
  const m100 = n % 100
  if (forms) {
    if (m10 === 1 && m100 !== 11) return `${n} ${forms[0]}`
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} ${forms[1]}`
    return `${n} ${forms[2]}`
  }
  if (m10 === 1 && m100 !== 11) return `${n} ${word}`
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} ${word}а`
  return `${n} ${word}ов`
}

// «ПАПА, А МЫ…» — красивый, лаконичный, человекочитаемый (T120: без JSON-дампов,
// ≤12 строк сути). Форма: что сделали → на чём → что больно → что решили.
export function renderPapaPost(input: PapaPostInput): string {
  const { window: w, report, council, board, decision } = input
  const moon = w.kind === "nightly" ? "🌙" : "🌊"
  const when = new Date(w.to).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })
  const L: string[] = []
  L.push(
    `${moon} папа, а мы… · ${when} · ${input.project} · ${report.instance} (${w.kind === "nightly" ? "ночной фикс" : "после волны"})`,
  )

  const alive = report.running > 0 ? `, ещё ${report.running} в работе` : ""
  L.push(
    `• Дела: ${plural(report.spawned, "демон")} → ${report.done} закончили, ${report.failed} умерли${alive}.`,
  )
  const quality: string[] = []
  if (report.emptyRuns > 0) quality.push(`пустых прогонов ${report.emptyRuns}`)
  if (report.noSelfReports > 0) quality.push(`без самоотчёта ${report.noSelfReports}`)
  if (report.orientationHells > 0) quality.push(`orientation-hell ${report.orientationHells}`)
  if (report.avgPlanAcc !== null) quality.push(`эстимейт ×${report.avgPlanAcc.toFixed(2)}`)
  // T128: переработка — постоянное мерило (T118): число видно на дэйли
  if (report.overrunMin > 0) quality.push(`переработка +${Math.round(report.overrunMin)}м`)
  L.push(quality.length > 0 ? `• Чистота: ${quality.join(", ")}.` : "• Чистота: всё чисто — пустых нет, самоотчёты на месте.")

  const modelLine = board
    .filter((r) => (report.models[r.key] ?? 0) > 0)
    .map((r) => `${r.key} ×${report.models[r.key]}`)
    .join(" · ")
  L.push(modelLine !== "" ? `• На чём работали: ${modelLine}.` : "• На чём работали: прогонов в окне не было.")

  const health: string[] = []
  for (const r of decision.quarantined) health.push(`${shortModelKey(r.model)} — карантин (${r.why})`)
  const baseLine = decision.base.map((m) => shortModelKey(m)).join(", ")
  L.push(`• Здоровье: база выбора [${baseLine}]${health.length > 0 ? `; ${health.join("; ")}` : ""}.`)

  const dec = decision.perClass
    .filter((d, i, arr) => arr.findIndex((x) => x.model === d.model) === i)
    .map((d) => `${d.cls} → ${d.key}`)
    .join("; ")
  L.push(`• Решения (ложатся в выбор моделей): ${dec}.`)
  L.push(
    decision.guards.length > 0
      ? `• Гарды: ${decision.guards.length} — ${decision.guards[0]}`
      : "• Гарды: тихо — никто недоступный в выбор не просился.",
  )

  if (council.length > 0) {
    const rows = council.map((c) => `${c.instance} — ${c.projects.length} репо, ${c.done}/${c.spawned}`).join("; ")
    L.push(`• Совет по именам: ${rows}.`)
  }
  if (report.failures.length > 0) {
    const f = report.failures[0]
    L.push(`• Боль: ${plural(report.failures.length, "", ["смерть", "смерти", "смертей"])} — первая: ${f.model ?? "?"} · ${f.error ?? "диагностики нет"} (это про провайдера, не про девочек).`)
  }
  return L.join("\n")
}
