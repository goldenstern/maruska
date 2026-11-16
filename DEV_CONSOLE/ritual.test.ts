// Tests for the T119 ritual «Папа, а мы…» (ritual.ts).
// Run: node --experimental-strip-types --test DEV_CONSOLE/ritual.test.ts

import { test } from "node:test"
import assert from "node:assert/strict"

import { type Agent, type Ledger, type Task, type TabSession, DEMON_MODEL, INSTANCE_MODEL, NEMOTRON_MODEL } from "./state.ts"
import {
  type CouncilEntry,
  collectBoard,
  collectInstanceReport,
  decideModels,
  councilReports,
  nightlyWindow,
  renderPapaPost,
  waveWindow,
} from "./ritual.ts"
import { instanceNameOf } from "./experience.ts" // T116: канон имени = experience.ts (ритуал импортирует тот же)

const AT = Date.parse("2026-10-28T21:00:00.000Z")

function tab(session_id: string, title: string): TabSession {
  return { session_id, title, model: null, emoji: null, last_seen: new Date(AT).toISOString() }
}

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    task: `задача ${id}`,
    state: "DOING",
    owner: "dev",
    parent: null,
    why: null,
    verification: null,
    session_ref: "ses-tab",
    agent_error: null,
    created_at: new Date(AT - 3600_000).toISOString(),
    updated_at: new Date(AT - 60_000).toISOString(),
    ...over,
  }
}

function agent(id: string, over: Partial<Agent> = {}): Agent {
  return {
    id,
    task_id: "T1",
    label: `demon ${id}`,
    state: "completed",
    session_ref: `ses-${id}`,
    home: "ses-tab",
    model: DEMON_MODEL,
    note: null,
    self_report: "готово, отчёт в задаче",
    kind: "dev",
    emoji: null,
    began_at: new Date(AT - 1800_000).toISOString(),
    eta_min: 30,
    updated_at: new Date(AT - 60_000).toISOString(),
    ...over,
  }
}

function ledger(over: Partial<Ledger> = {}): Ledger {
  return {
    version: 1,
    updated_at: new Date(AT).toISOString(),
    tasks: [task("T1")],
    agents: [agent("A1")],
    tabs: [tab("ses-tab", "Тема ритуала · Маруська Гольденштерн")],
    models: [],
    ...over,
  }
}

// ---------------------------------------------------------------- T119-1 ---
test("T119: instanceNameOf = канон T116 §3 (хвост титула, локальное имя не выдумываем)", () => {
  assert.equal(instanceNameOf("Тема ритуала · Маруська Гольденштерн"), "Маруська Гольденштерн")
  assert.equal(instanceNameOf("Тема · Мара"), "Мара")
  assert.equal(instanceNameOf("Мара"), "Мара") // до-T86 формат «Имя · Тема»
  assert.equal(instanceNameOf("👩 Динамические имена · Маруська Гольденштерн"), "Маруська Гольденштерн")
  assert.equal(instanceNameOf("Тема · Свой Человек"), "Свой Человек") // местное имя — изолированный бакет
  assert.equal(instanceNameOf(""), "Маруська Гольденштерн")
  assert.equal(instanceNameOf(null), "Маруська Гольденштерн")
})

// ---------------------------------------------------------------- T119-2 ---
test("T119: самоотчёт считает исходы окна, качество (T97/T118) и распределение моделей", () => {
  const w = nightlyWindow(AT)
  const led = ledger({
    agents: [
      agent("A1"),
      agent("A2", { state: "failed", model: NEMOTRON_MODEL, task_id: "T1" }),
      agent("A3", { state: "running", model: INSTANCE_MODEL, updated_at: new Date(AT - 30_000).toISOString() }),
      agent("A4", {
        state: "completed",
        counters: { plan_acc: 2, empty_run: true, early_settle: false, injections: 1, overrun_min: 7 },
        self_report: null,
        orientation: "hell",
      }),
      agent("A5", { updated_at: new Date(AT - 48 * 3600_000).toISOString() }), // вне окна
    ],
    tasks: [task("T1", { agent_error: "[upstream] Endpoint is unavailable" })],
  })
  const rep = collectInstanceReport(led, w)
  assert.equal(rep.instance, "Маруська Гольденштерн")
  assert.equal(rep.spawned, 4) // A5 вне ночного окна
  assert.equal(rep.done, 2)
  assert.equal(rep.failed, 1)
  assert.equal(rep.running, 1)
  assert.equal(rep.emptyRuns, 1)
  assert.equal(rep.noSelfReports, 1)
  assert.equal(rep.orientationHells, 1)
  assert.equal(rep.models["glm-5.3-flash"], 2)
  assert.equal(rep.failures[0]?.error, "[upstream] Endpoint is unavailable")
  assert.ok(rep.avgPlanAcc !== null && rep.avgPlanAcc > 0)
  // T128: переработка окна — вход ритуала (T118: обратная сторона эффективности)
  assert.equal(rep.overrunMin, 7, "Σ переработки в окне из counters.overrun_min")
})

// ---------------------------------------------------------------- T119-3 ---
test("T119: недоступная модель (инцидент 28.10) НЕ выбирается, даже будучи лучшей по статистике", () => {
  const mimo = {
    model: INSTANCE_MODEL,
    ok: 100,
    fail: 0,
    cooldown_until: null,
    byClass: { "dev:small": { ok: 40, fail: 0, editsPerSecSum: 400, runs: 40 } },
  }
  const glm = {
    model: DEMON_MODEL,
    ok: 5,
    fail: 1,
    cooldown_until: null,
    byClass: { "dev:small": { ok: 5, fail: 0, editsPerSecSum: 5, runs: 5 } },
  }
  const led = ledger({ models: [mimo, glm] as Ledger["models"] })
  // mimo офф-подписка (28.10): health-check T121 отдаёт здоровую базу без неё
  const decision = decideModels(led, AT, [DEMON_MODEL, NEMOTRON_MODEL])
  assert.ok(!decision.base.includes(INSTANCE_MODEL), "base не должна содержать недоступную модель")
  for (const d of decision.perClass) assert.notEqual(d.key, "mimo-v2.6-flash")
  // выбор сделан производственной функцией state.ts (причина из неё)
  assert.ok(decision.perClass.every((d) => /^(auto|re-examine|owner-pin|ritual-guard)/.test(d.reason)))
})

// ---------------------------------------------------------------- T119-4 ---
test("T119: карантин — модель с ≥50% отказов (≥3 прогонов) или в кулдауне выбывает из базы", () => {
  const sick = {
    model: NEMOTRON_MODEL,
    ok: 1,
    fail: 3,
    cooldown_until: null,
  }
  // Кулдаунник — ключ, уникальный в детском пуле (консольный mimo-free): ключ
  // deepseek общий с ГО-политикой (звено 2), нормализатор прошивает таблицу
  // ключом, отказник Go-deepseek идёт первым и поглощает дубликат по ключу.
  const cool = { model: "opencode/mimo-v2.6-flash-free", ok: 10, fail: 0, cooldown_until: new Date(AT + 600_000).toISOString() }
  const led = ledger({ models: [sick, cool] as Ledger["models"] })
  const decision = decideModels(led, AT, [DEMON_MODEL, NEMOTRON_MODEL])
  const why = decision.quarantined.map((q) => `${q.model}|${q.why}`).join("\n")
  assert.ok(why.includes("отказы 3/4"), why)
  assert.ok(why.includes("кулдаун до"), why)
  assert.ok(!decision.base.includes(NEMOTRON_MODEL), "отказник выбывает из базы")
  assert.ok(!decision.base.includes("opencode/mimo-v2.6-flash-free"), "кулдаунник выбывает из базы")
  for (const d of decision.perClass) assert.equal(d.key, "glm-5.3-flash")
})

// ---------------------------------------------------------------- T119-5 ---
test("T119: пустая здоровая база → «вынужденный выбор» (гард), работа не останавливается", () => {
  const led = ledger()
  const decision = decideModels(led, AT, [])
  assert.ok(decision.guards.some((g) => g.includes("вынужденный выбор")), decision.guards.join("; "))
  const policy = new Set(["glm-5.3-flash", "nemotron-3.5-super-vl", "mimo-v2.6-flash", "deepseek-v4.1-flash", "flint-40b", "beam"])
  assert.ok(decision.perClass.length > 0)
  for (const d of decision.perClass) assert.ok(policy.has(d.key), `чужая модель в решении: ${d.key}`)
})

// ---------------------------------------------------------------- T119-6 ---
test("T119: совет по именам склеивает проекты по имени инстанса (T116-ключ)", () => {
  const w = nightlyWindow(AT)
  const entries: CouncilEntry[] = [
    { project: "pipeline-setup", ledger: ledger() },
    {
      project: "other-repo",
      ledger: ledger({
        agents: [agent("B1"), agent("B2", { state: "failed" })],
        tabs: [tab("ses-tab", "Другая тема · Мара")],
      }),
    },
  ]
  const rows = councilReports(entries, w)
  const gold = rows.find((r) => r.instance === "Маруська Гольденштерн")
  assert.ok(gold)
  assert.deepEqual(gold.projects, ["pipeline-setup"])
  assert.equal(rows.find((r) => r.instance === "Мара")?.spawned, 2)
})

// ---------------------------------------------------------------- T119-7 ---
test("T119: пост «папа, а мы…» — лаконичный и человекочитаемый (T120)", () => {
  const w = nightlyWindow(AT)
  const led = ledger({
    agents: [agent("A1"), agent("A2", { state: "failed", model: NEMOTRON_MODEL, task_id: "T1" })],
    tasks: [task("T1", { agent_error: "[upstream] Endpoint is unavailable" })],
    models: [{ model: DEMON_MODEL, ok: 5, fail: 0, cooldown_until: null }] as Ledger["models"],
  })
  const report = collectInstanceReport(led, w)
  const board = collectBoard(led, AT, [DEMON_MODEL, NEMOTRON_MODEL])
  const decision = decideModels(led, AT, [DEMON_MODEL, NEMOTRON_MODEL])
  const post = renderPapaPost({
    window: w,
    report,
    council: [],
    board,
    decision,
    project: "pipeline-setup",
  })
  const lines = post.split("\n")
  assert.ok(post.startsWith("🌙 папа, а мы…"))
  assert.ok(post.includes("Решения (ложатся в выбор моделей)"))
  assert.ok(post.includes("Маруська Гольденштерн"))
  assert.ok(!post.includes("{"), "никаких JSON-дампов в ленте")
  assert.ok(lines.length <= 12, `пост слишком длинный: ${lines.length} строк`)
  // внеоконная волна — другой знак, тот же формат
  const wave = renderPapaPost({
    window: waveWindow(AT, AT - 3600_000),
    report,
    council: [],
    board,
    decision,
    project: "pipeline-setup",
  })
  assert.ok(wave.startsWith("🌊 папа, а мы…"))
  assert.ok(wave.includes("после волны"))
  // T128: переработка видна в «Чистоте» — постоянное мерило T118
  assert.ok(!post.includes("переработка"), "нулевая переработка не рисуется")
  const withOverrun = renderPapaPost({
    window: w,
    report: { ...report, overrunMin: 18.4 },
    council: [],
    board,
    decision,
    project: "pipeline-setup",
  })
  assert.ok(withOverrun.includes("переработка +18м"), `число переработки в посте: ${withOverrun}`)
})

// ------------------- T119: гард выбора моделей (чистая функция) -------------
import { guardModel } from "./ritual.ts"
test("T119: гард перебивает выбор ТОЛЬКО при карантине и здоровой базе", () => {
  const decision = {
    perClass: [{ cls: "qc" as const, model: "opencode/mimo-v2.6-flash-free", key: "mimo-v2.6-flash", reason: "r" }],
    base: ["opencode/mimo-v2.6-flash-free"],
    quarantined: [{ model: "opencode/glm-5.3-flash-free", why: "отказы 16/24" }],
    guards: [],
  }
  // Карантинная модель → заменяем на решение ритуала.
  const applied = guardModel(decision, "qc", "opencode/glm-5.3-flash-free")
  assert.equal(applied.applied, true, "гард сработал")
  assert.equal(applied.model, "opencode/mimo-v2.6-flash-free", "взята модель ритуала")
  assert.match(applied.why, /карантин/, "причина названа")
  // Не карантинная модель — статистику не перебиваем.
  const kept = guardModel(decision, "qc", "opencode/deepseek-v4.1-flash-free")
  assert.equal(kept.applied, false, "не карантин — выбор не тронут")
  assert.equal(kept.model, "opencode/deepseek-v4.1-flash-free", "модель сохранена")
  // Здоровой базы нет — цепочку выбора НЕ перебиваем (иначе всё схлопнется на одну).
  const noBase = { ...decision, base: [] }
  const fallback = guardModel(noBase, "qc", "opencode/glm-5.3-flash-free")
  assert.equal(fallback.applied, false, "без здоровой базы гард молчит")
  assert.equal(fallback.model, "opencode/glm-5.3-flash-free", "выбор сохранён")
})