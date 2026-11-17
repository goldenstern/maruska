// Tests for the DEV CONSOLE state core.
// Run: node --experimental-strip-types --test DEV_CONSOLE/state.test.ts

import { after, test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { applyOp, applyTabFeed, autoBlinkAction, beginAgent, batchHorizon, BLINK_GLYPHS, blinkCycle, blinkRestore, calcInstanceSpeed, calcRepoSpeed, chooseChildModel, chooseModelByClass, childModelAllowed, CHILD_KEY_TO_MODEL, CHILD_KEYS, CHILD_MODELS, childPool, COOLDOWN_MS, DAEMON_EMOJI, demonName, DEMON_MODEL, describeTab, dropOwnFromForeign, EFF_GAP_MS, ensureTabEff, errorTextOfPayload, flushTabEffActivity, formatCountersSignature, formatInstanceCountersSignature, formatModelClassToken, formatOverrunSuffix, formatQuotaHeader, formatRepoSpeed, formatTabEff, FREE_POOL, freshLedger, INSTANCE_CLASS, INSTANCE_EMOJI, INSTANCE_MODEL, INSTANCE_PATH, instanceClass, instancePlanAcc, instancePool, isExecutorSession, isForeignDirectory, isForeignSession, isFreeModel, isRateLimited, learnEta, liveOverrunMin, loadLedger, liveExecutorConflict, mergeLedger, mergeQuota, modelForKey, modelPole, modelSpeedFactor, modelStats, modelUsable, normalizeDirPath, normalizeTitle, noteTabEffWork, NEMOTRON_MODEL, noteOverrun, openTasksOf, overrunOfDay, overrunWakeReason, OVERRUN_WAKE_FACTOR, parseActiveSessions, parseConsoleQuota, parseLsFiles, parseNumstat, parseSessionFeed, parseChildFeed, attachTabChildren, personaTitle, planEtaForTask, planPercent, poleModels, project, projectCounters, projectTabs, projectWorksheet, POLICY_MODELS, applySelfReport, classifyAgentError, noSelfReportReason, noteInjection, noteAgentProgress, noteAgentUsage, noteAgentTool, noteAgentRequest, noteOrientationCheck, NO_SELF_REPORT, NO_SELF_REPORT_MIN, ORIENTATION_N, quotaFallbackModel, quotaGuardUsage, quotaWarning, recordModelResult, recordModelResultByClass, rekeyAgent, renderConsoleHtml, reserveLedgerId, reserveModel, resetModelCooldowns, ROLLING_WINDOW_MIN, rollingUsage, saveLedger, settleAgent, SETTLED_FRESH_MS, setModelCooldown, settleOnEvent, settleOnTurn, SETTLE_IDLE_MS, markAgentError, syncTabTitle, tabOverrunMin, TAB_FRESH_MS, TAB_IDLE_MS, tabStatus, taskClass, timeAwarePercent, upsertTab, wakeMessage, zombieSettleReason, type InstanceDiffSnapshot, type InstanceEditEvent, type InstanceSpeed, type Ledger, type OpInput, type TabEff, type Task, type TaskClass } from "./state.ts"
import { cpuGate, getCpuState, isCpuProbeRunning, probeAndUpdate, resetCpuState, updateCpuState, type CpuSample } from "./cpu.ts"
import { exportsOf, gapsIn, importsOf } from "./import_gate.ts" // T130: гейт идентификаторов (импорт↔экспорт)
import { fileURLToPath } from "node:url"
// T102: персонажная система ипостасей (новый файл промптов) — отдельной строкой,
// чтобы правка каталога не трогала большой импорт state.ts.
import { bumpUpstreamCooldown, loadModelHealth, saveModelHealth, recordModelHealth, applyModelHealth, nextAgentId, onCooldown } from "./state.ts"
import { DEFAULT_PERSONA_ID, PERSONAS, instancePersona, instancePromptBlock, personaById, personaForTaskClass, personaPromptBlock, resolvePersona, topLevelPersona } from "./personas.ts"

function apply(ledger: Ledger, input: OpInput) {
  return applyOp(ledger, input)
}

function must(ledger: Ledger, input: OpInput): Task {
  const out = applyOp(ledger, input)
  assert.equal(out.ok, true, `expected ok, got: ${!out.ok ? out.error : ""}`)
  return (out as { ok: true; task: Task }).task
}

function err(ledger: Ledger, input: OpInput): string {
  const out = applyOp(ledger, input)
  assert.equal(out.ok, false, "expected rejection")
  return (out as { ok: false; error: string }).error
}

// Строка инстанса/демона в ui (T71): префикс = свой эмодзи из палитры,
// фолбэк 🤖/▸ — запись без назначенного (или с чужим значением) не рисуется пустой.
// T89 (табуляция): голова инстанса на отступе 2, демоны — на отступе 6.
// T83 (правка Основателя 07.10 12:56): маркер 🤖 только у шапки секции ИНСТАНСЫ;
// голова инстанса — только своё эмодзи + имя (без 🤖), оси — чистый отступ.
const instanceRow = (x: string): boolean =>
  INSTANCE_EMOJI.some((e) => x.startsWith(`  ${e} `))
const daemonRow = (x: string): boolean => x.startsWith("      ▸ ") || DAEMON_EMOJI.some((e) => x.startsWith(`      ${e} `))

// T83 (правка Основателя 07.10 12:56): строка инстанса = блок из 2-3 строк-осей.
// Голова (идентичность) — первая строка блока: только она несёт своё эмодзи
// и имя инстанса целиком (маркер 🤖 только у шапки секции ИНСТАНСЫ); оси —
// чистый отступ. Путь logOS.runtime.LUNA из рендера убран.
const identityRow = (x: string): boolean => instanceRow(x)
// T89: отступы = уровни: секция 0, голова инстанса 2, оси блока 4, демоны 6.
// Строка оси блока — отступ ровно 4 (не 6 — там демоны).
const sectionRow = (x: string): boolean => x.startsWith("    ") && !x.startsWith("      ")
// Строки блока: от головы до первой строки вне блока (демон/завершённый — свой
// отступ, следующий инстанс — новая голова, граница секции — пустая строка).
const instanceBlock = (lines: string[], identityIdx: number): string[] => {
  const out = [lines[identityIdx]]
  for (let i = identityIdx + 1; i < lines.length && sectionRow(lines[i]) && !identityRow(lines[i]); i++) out.push(lines[i])
  return out
}
// Ось-1 (КТО·ЧЕМ·МЕРИЛО·ВРЕМЯ·КАК, T157): модель · бар · мерило · Δ · ⏱+ · HH:MM · статус (последнее слово).
const stateOf = (lines: string[], identityIdx: number): string => {
  const block = instanceBlock(lines, identityIdx)
  assert.ok(block.length >= 2, `блок инстанса минимум из двух строк:\n${block.join("\n")}`)
  return block[1]
}
// Ось-2 (ДЕЛО, T157): в задаче · [шлейф]; есть только у вкладок с делом.
const workOf = (lines: string[], identityIdx: number): string => {
  const block = instanceBlock(lines, identityIdx)
  assert.ok(block.length >= 3, `блок с осью-2 (голова + ось-1 + дело, T157):\n${block.join("\n")}`)
  return block[2]
}
// Индекс строки идентичности по заголовку вкладки.
const identityOf = (ui: string, title: string): number => {
  const idx = ui.split("\n").findIndex((x) => identityRow(x) && x.includes(title))
  assert.ok(idx >= 0, `строка инстанса «${title}» отрисована`)
  return idx
}
// Строки, которые панель реально рисует (массив lines шаблона): проверки
// «секция есть/нет» честнее по нему — в страницу вшита и константа заголовка.
const paneLines = (html: string): string[] => {
  const m = /^const lines = (\[.*\]);$/m.exec(html)
  assert.ok(m, "строки панели вшиты в страницу")
  return JSON.parse(m![1]) as string[]
}

// ------------------------------------------------------------- projection ---

test("empty ledger → no sections, truthful minimal ui", () => {
  const p = project(freshLedger())
  assert.match(p.ui, /LAVK DEV CONSOLE/)
  assert.match(p.ui, /журнал пуст/)
  for (const marker of [
    "🔄 В РАБОТЕ",
    "⚡ ЗАДАЧИ",
    "🤖 АГЕНТЫ",
    "✅ ГОТОВО",
    "⛔ ЗАБЛОКИРОВАНО",
    "🔔 РЕШЕНИЕ ОСНОВАТЕЛЯ",
    "⏭ NEXT",
    "🤖 ИНСТАНСЫ",
  ]) {
    assert.ok(!p.ui.includes(marker), `empty ledger must not contain: ${marker}`)
  }
  assert.equal(p.active.length, 0)
  assert.equal(p.agents.length, 0)
})

test("create → WAIT with id T1; second create → T2", () => {
  const led = freshLedger()
  const t1 = must(led, { op: "create", task: "Build feature X", owner: "dev" })
  assert.equal(t1.state, "WAIT")
  assert.equal(t1.id, "T1")
  assert.equal(t1.owner, "dev")
  const t2 = must(led, { op: "create", task: "Research Y" })
  assert.equal(t2.id, "T2")
  assert.equal(t2.owner, null)
  assert.equal(led.tasks.length, 2)
})

test("create rejects empty task", () => {
  const led = freshLedger()
  assert.match(err(led, { op: "create", task: "  " }), /non-empty/)
  assert.equal(led.tasks.length, 0)
})

test("update: task text and owner", () => {
  const led = freshLedger()
  must(led, { op: "create", task: "Task A" })
  must(led, { op: "update", id: "T1", task: "Task A v2", owner: "dev" })
  assert.equal(led.tasks[0].task, "Task A v2")
  assert.equal(led.tasks[0].owner, "dev")
})

test("update: rejects unknown id and empty strings", () => {
  const led = freshLedger()
  must(led, { op: "create", task: "Task A" })
  assert.match(err(led, { op: "update", id: "T9", owner: "dev" }), /no task with id/)
  assert.match(err(led, { op: "update", id: "T1", task: "  " }), /non-empty/)
  assert.match(err(led, { op: "update", id: "T1", owner: "" }), /non-empty/)
  must(led, { op: "update", id: "T1", owner: null })
  assert.equal(led.tasks[0].owner, null)
})

// --------------------------------------------------------- state machine ----

test("legal transition WAIT → DOING; DOING shows IN PROGRESS", () => {
  const led = freshLedger()
  must(led, { op: "create", task: "Task A" })
  const t = must(led, { op: "set_state", id: "T1", state: "DOING" })
  assert.equal(t.state, "DOING")
  const p = project(led)
  assert.equal(p.active.length, 1)
  assert.ok(p.ui.includes("🔄 В РАБОТЕ"))
})

test("no-op same-state transition is rejected", () => {
  const led = freshLedger()
  must(led, { op: "create", task: "Task A" })
  assert.match(err(led, { op: "set_state", id: "T1", state: "WAIT" }), /already WAIT/)
})

test("illegal transition BLOCKED → DONE is rejected", () => {
  const led = freshLedger()
  must(led, { op: "create", task: "Task A" })
  must(led, { op: "set_state", id: "T1", state: "BLOCKED", why: "awaiting credential" })
  assert.match(err(led, { op: "set_state", id: "T1", state: "DONE", verification: "x" }), /illegal transition: BLOCKED → DONE/)
})

test("BLOCKED requires why; why shows in ⛔; WAIT clears it", () => {
  const led = freshLedger()
  must(led, { op: "create", task: "Task A" })
  assert.match(err(led, { op: "set_state", id: "T1", state: "BLOCKED" }), /requires 'why'/)

  must(led, { op: "set_state", id: "T1", state: "BLOCKED", why: "missing env credential" })
  let p = project(led)
  assert.equal(p.blocked.length, 1)
  assert.ok(p.ui.includes("⛔ ЗАБЛОКИРОВАНО"))
  assert.ok(p.ui.includes("missing env credential"))

  must(led, { op: "set_state", id: "T1", state: "WAIT" })
  p = project(led)
  assert.equal(p.blocked.length, 0)
  assert.equal(led.tasks[0].why, null)
  assert.ok(!p.ui.includes("⛔ ЗАБЛОКИРОВАНО"))
})

test("⛔ names the instance waiting in (T70): session_ref → tab title; unknown → no suffix", () => {
  const led = freshLedger()
  upsertTab(led, { session_id: "ses_win", title: "Маруська ЛУНА · Обсуждение", model: "mimo", last_seen: "2026-10-07T10:00:00.000Z" })

  must(led, { op: "create", task: "Ждём ключ от API", session_ref: "ses_win" })
  must(led, { op: "set_state", id: "T1", state: "BLOCKED", why: "нет креда" })
  let ui = project(led).ui
  const line = ui.split("\n").find((l) => l.includes("[T1]") && l.includes("нет креда"))
  assert.ok(line, "blocked line rendered")
  assert.ok(line.includes("ждёт в 🤖 Маруська ЛУНА · Обсуждение"), `instance suffix on the line: ${line}`)
  // Инстанс идёт раньше текста и why — видно сразу, в каком окне ждёт.
  assert.ok(line.indexOf("ждёт в") < line.indexOf("нет креда"), "instance precedes why")

  // Привязки нет / вкладка неизвестна — не выдумываем инстанс.
  must(led, { op: "create", task: "Сирота без вкладки" })
  must(led, { op: "set_state", id: "T2", state: "BLOCKED", why: "внешний блокер" })
  ui = project(led).ui
  const orphan = ui.split("\n").find((l) => l.includes("[T2]") && l.includes("внешний блокер"))
  assert.ok(orphan && !orphan.includes("ждёт в"), `no instance invented: ${orphan}`)
})

test("GATE requires why; shows in 🔔; DOING clears it", () => {
  const led = freshLedger()
  must(led, { op: "create", task: "Deploy pipeline" })
  assert.match(err(led, { op: "set_state", id: "T1", state: "GATE" }), /requires 'why'/)

  must(led, { op: "set_state", id: "T1", state: "GATE", why: "Deploy to production?" })
  let p = project(led)
  assert.equal(p.gates.length, 1)
  assert.ok(p.ui.includes("🔔 РЕШЕНИЕ ОСНОВАТЕЛЯ"))
  assert.ok(p.ui.includes("Deploy to production?"))

  must(led, { op: "set_state", id: "T1", state: "DOING" })
  p = project(led)
  assert.equal(p.gates.length, 0)
  assert.equal(led.tasks[0].why, null)
})

test("DONE requires verification (the barrier)", () => {
  const led = freshLedger()
  must(led, { op: "create", task: "Task A" })
  assert.match(err(led, { op: "set_state", id: "T1", state: "DONE" }), /requires 'verification'/)
  assert.match(err(led, { op: "set_state", id: "T1", state: "DONE", verification: "   " }), /requires 'verification'/)
  assert.equal(led.tasks[0].state, "WAIT", "failed DONE must not change state")
})

test("DONE records verification and leaves ⚡ TASKS", () => {
  const led = freshLedger()
  must(led, { op: "create", task: "Task A", owner: "dev" })
  const t = must(led, { op: "set_state", id: "T1", state: "DONE", verification: "npm test → 12/12" })

  assert.equal(t.state, "DONE")
  assert.equal(t.verification, "npm test → 12/12")

  const p = project(led)
  assert.equal(p.done.length, 1)
  assert.ok(!p.ui.includes("✅ ГОТОВО"), "completed tasks are not rendered — the console shows live state only")
  assert.ok(!p.ui.includes("⏭ NEXT"), "NEXT section removed from the interface")
  assert.ok(!p.tasks.some((x) => x.id === "T1"), "DONE tasks leave ⚡ ЗАДАЧИ")
})

test("DONE is absolutely terminal; rework = a new task", () => {
  const led = freshLedger()
  must(led, { op: "create", task: "Task A" })
  must(led, { op: "set_state", id: "T1", state: "DONE", verification: "verified" })

  assert.match(err(led, { op: "set_state", id: "T1", state: "DOING" }), /illegal transition: DONE → DOING/)
  assert.match(err(led, { op: "set_state", id: "T1", state: "WAIT" }), /illegal transition: DONE → WAIT/)
  assert.match(err(led, { op: "reopen", id: "T1", reason: "x" }), /unknown op/, "reopen op does not exist")

  // Rework = a new task referencing the old one; the DONE record is never rewritten.
  const t2 = must(led, { op: "create", task: "Rework of T1: regression found" })
  assert.equal(t2.id, "T2")
  assert.equal(led.tasks[0].state, "DONE")
  assert.equal(led.tasks[0].verification, "verified")
})

test("GATE → DONE allowed with verification (per transition table)", () => {
  const led = freshLedger()
  must(led, { op: "create", task: "Task A" })
  must(led, { op: "set_state", id: "T1", state: "GATE", why: "ship?" })
  const t = must(led, { op: "set_state", id: "T1", state: "DONE", verification: "founder approved + live check" })
  assert.equal(t.state, "DONE")
})

test("unknown op and invalid state are rejected", () => {
  const led = freshLedger()
  must(led, { op: "create", task: "Task A" })
  assert.match(err(led, { op: "dance" }), /unknown op/)
  assert.match(err(led, { op: "set_state", id: "T1", state: "PLANNED" as never }), /invalid state/)
})

// ------------------------------------------------------ UI truthfulness -----

test("sections exist only when their arrays are non-empty", () => {
  const led = freshLedger()
  must(led, { op: "create", task: "Active work", owner: "dev" })
  must(led, { op: "set_state", id: "T1", state: "DOING" })

  const p = project(led)
  assert.ok(p.ui.includes("🔄 В РАБОТЕ"))
  // T104(3): строка времени списка задач живёт по всему открытому списку
  // (WAIT+DOING): единственный DOING при пустой очереди не гасит ⚡ ЗАДАЧИ.
  assert.ok(p.ui.includes("⚡ ЗАДАЧИ"), "the only task is DOING → time line still rendered (T104(3))")
  assert.ok(
    p.ui.includes("⚡ ЗАДАЧИ · ~05:00 горизонт"),
    "horizon counts the open list (T1 DOING = QUEUE_DEFAULT_MIN, no live agents)",
  )
  assert.equal(p.ui.split("[T1]").length - 1, 1, "DOING task stays only in 🔄 В РАБОТЕ")
  assert.ok(!p.ui.includes("🤖 АГЕНТЫ"), "no running agents → AGENTS omitted")
  assert.ok(!p.ui.includes("⛔ ЗАБЛОКИРОВАНО"))
  assert.ok(!p.ui.includes("🔔 РЕШЕНИЕ ОСНОВАТЕЛЯ"))
  assert.ok(!p.ui.includes("✅ ГОТОВО"))
  assert.ok(!p.ui.includes("⏭ NEXT"), "NEXT does not exist anymore")
  assert.ok(!p.ui.includes("🤖 ИНСТАНСЫ"), "no tabs and no live agents → no instances section")
})

test("each task appears in exactly one section (no duplication)", () => {
  const led = freshLedger()
  must(led, { op: "create", task: "Blocked one" })
  must(led, { op: "set_state", id: "T1", state: "BLOCKED", why: "key missing" })
  must(led, { op: "create", task: "Gate one" })
  must(led, { op: "set_state", id: "T2", state: "GATE", why: "решить?" })

  const p = project(led)
  assert.ok(p.ui.includes("⛔ ЗАБЛОКИРОВАНО"))
  assert.ok(p.ui.includes("🔔 РЕШЕНИЕ ОСНОВАТЕЛЯ"))
  assert.ok(!p.ui.includes("⚡ ЗАДАЧИ"), "BLOCKED/GATE tasks live in their own sections, not the queue")
  const count = (s: string, needle: string) => s.split(needle).length - 1
  assert.equal(count(p.ui, "[T1]"), 1, "T1 rendered exactly once")
  assert.equal(count(p.ui, "[T2]"), 1, "T2 rendered exactly once")
})

test("демоны: строка только из настоящей записи Agent; секции «🤖 АГЕНТЫ» больше нет (T69)", () => {
  const led = freshLedger()
  assert.ok(!project(led).ui.includes("🤖 АГЕНТЫ"))
  led.agents.push({
    id: "A1",
    task_id: "T1",
    label: "dev-1",
    kind: null,
    state: "running",
    session_ref: null,
    home: null,
    model: "nemotron-3-ultra",
    note: null,
    emoji: null, // запись без эмодзи — строка рисуется фолбэком ▸ (T71, правило 4)
    began_at: new Date().toISOString(),
    eta_min: 30,
    updated_at: new Date().toISOString(),
  })
  const p = project(led)
  assert.equal(p.agents.length, 1)
  assert.ok(!p.ui.includes("🤖 АГЕНТЫ"), "дубль-секция убрана (T69): демоны и есть записи Agent")
  assert.ok(!p.ui.includes("📂"), "старый глиф 📂 не рисуется нигде (T162: глиф инстанса — 🤖)")
  assert.ok(p.ui.includes("[T1] · nemotron-3-ultra — работает"), "task + model, no record name")
  // без инстансы демон идёт хвостом секции — с именем записи (T64) и отступом
  const daemon = p.ui.split("\n").find((x) => x.includes("▸"))!
  assert.ok(daemon.startsWith(`      ▸ ${demonName("A1")} `), `имя демона + отступ 6 (T89): ${daemon}`)
  assert.ok(daemon.includes("⏱"), `план на строке: ${daemon}`)
})

test("set_state: owner rides the same call (the dispatch gate reads it)", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "probe" })
  const a = applyOp(l, { op: "set_state", id: "T1", state: "DOING", owner: "research" })
  assert.ok(a.ok, "set_state DOING+owner accepted")
  assert.equal((a as { task: Task }).task.owner, "research", "owner lands in the same call")
  // T99: owner now on header line with · separator (instances style)
  const ui = project(l).ui
  const header = ui.split("\n").find((x) => x.startsWith("  ● [T1]"))!
  assert.ok(header.includes("· research"), `owner rendered on header: ${header}`)

  const b = applyOp(l, { op: "set_state", id: "T1", state: "WAIT", owner: null })
  assert.ok(b.ok && (b as { task: Task }).task.owner === null, "owner=null clears")

  const c = applyOp(l, { op: "set_state", id: "T1", state: "DOING", owner: "  " })
  assert.match(err(l, { op: "set_state", id: "T1", state: "DOING", owner: "  " }), /owner/)
  assert.ok(c.ok === false, "empty owner rejected")
})

test("agent line: model + short task instead of the record name; label only as fallback", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "Дедупликация блока участников: видимые вхождения и адаптив" })
  const a = beginAgent(l, { input: { agent: "general", description: "[T1] полный бриф со словами".repeat(4) }, ref: "ses_m1" })
  a.model = "nemotron-3-ultra"
  const line = project(l).ui.split("\n").find((x) => daemonRow(x))!
  assert.ok(line.includes("nemotron-3-ultra"), `model shown: ${line}`)
  assert.ok(line.includes("Дедупликация блока участников"), `short task shown: ${line}`)
  assert.ok(!line.includes("general-1"), `record name hidden: ${line}`)
  assert.ok(line.includes("⏱"), `countdown kept: ${line}`)
})

test("beginAgent: record exists from observed spawn; [T#] tag binds the task", () => {
  const led = freshLedger()
  const a = beginAgent(led, { input: { agent: "explore", description: "[T3] quick scan of the repo" }, ref: "call-1" })
  assert.equal(a.state, "running")
  assert.equal(a.task_id, "T3", "task binding parsed from the spawn payload tag")
  assert.equal(a.label, "logOS.runtime.LUNA.demon-001", "имя записи = демон (T64), не explore-1")
  assert.equal(a.kind, "explore", "вид спавна ушёл в kind — по нему учится ETA")
  assert.equal(a.session_ref, "call-1")
  assert.equal(led.agents.length, 1)

  // no tag → no binding; unknown kind → generic label
  const b = beginAgent(led, { input: { description: "no tag here" } })
  assert.equal(b.task_id, null)
  assert.equal(b.id, "A2")
  assert.equal(b.label, "logOS.runtime.LUNA.demon-002")
  assert.equal(b.session_ref, null)
})

test("settleAgent: exact ref match, else oldest running; no running → undefined", () => {
  const led = freshLedger()
  const a1 = beginAgent(led, { input: { agent: "general", description: "[T1] one" }, ref: "call-1" })
  const a2 = beginAgent(led, { input: { agent: "general", description: "[T2] two" }, ref: "call-2" })

  // exact ref settles the right agent even with another running
  assert.equal(settleAgent(led, "completed", "call-2")?.id, a2.id)
  assert.equal(a2.state, "completed")
  assert.equal(a1.state, "running", "untouched agent stays running")

  // no ref → oldest running (FIFO)
  assert.equal(settleAgent(led, "failed")?.id, a1.id)
  assert.equal(a1.state, "failed")

  // nothing running → undefined, no phantom records
  assert.equal(settleAgent(led, "completed"), undefined)
  assert.equal(led.agents.length, 2)
})

test("rekeyAgent: call id → child session id for exact later settle; null claims oldest", () => {
  const led = freshLedger()
  const a1 = beginAgent(led, { input: { agent: "general", description: "[T1] one" }, ref: "call-1" })
  const a2 = beginAgent(led, { input: { agent: "general", description: "[T2] two" }, ref: "call-2" })

  assert.equal(rekeyAgent(led, "call-2", "ses_x")?.id, a2.id)
  assert.equal(led.agents[1].session_ref, "ses_x")

  // event-field mismatch fallback: null claims the oldest running
  assert.equal(rekeyAgent(led, null, "ses_y")?.id, a1.id)
  assert.equal(a1.session_ref, "ses_y")

  // settle by the child session id matches exactly
  assert.equal(settleAgent(led, "completed", "ses_x")?.id, a2.id)
  assert.equal(settleAgent(led, "failed", "ses_y")?.id, a1.id)

  // no running → undefined
  assert.equal(rekeyAgent(led, null, "ses_z"), undefined)
})

test("rekeyAgent: existing record on the target session = one agent per session", () => {
  const led = freshLedger()
  // context-hook recorder fired first (session-keyed), spawn record arrives second
  const ctxRec = beginAgent(led, { input: { agent: "general", description: "child session" }, ref: "ses_x" })
  const spawnRec = beginAgent(led, { input: { agent: "explore", description: "[T4] real payload" }, ref: "call-9" })
  assert.equal(settleAgent(led, "completed", "ses_x")?.id, ctxRec.id, "precondition: recorder settles alone")

  rekeyAgent(led, "call-9", "ses_x")
  assert.equal(led.agents.length, 1, "duplicate absorbed — one session = one agent")
  assert.equal(led.agents[0].id, spawnRec.id, "spawn record kept (richer input)")
  assert.equal(led.agents[0].session_ref, "ses_x")
  assert.equal(led.agents[0].state, "completed", "terminal state of the absorbed record is not lost")
})

// -------------------------------------------------------- T41: metrics -----

test("T41: settleAgent writes counters (plan_acc, empty_run, early_settle, injections)", () => {
  const led = freshLedger()
  const a = beginAgent(led, { input: { agent: "general", description: "[T1] work" }, ref: "ses_m1" })
  // T41/T93: set durable counters on agent record before settle
  a.edit_count = 5
  a.injection_count = 2
  const began = Date.parse(a.began_at)
  const planned = a.eta_min
  // Settle with runtime signals (earlySettle only; emptyRun/injections read from durable counters)
  const settled = settleAgent(led, "completed", "ses_m1", { earlySettle: false })
  assert.ok(settled, "agent settled")
  assert.ok(settled!.counters, "counters written")
  const c = settled!.counters!
  assert.equal(c.injections, 2, "injections recorded from durable counter")
  assert.equal(c.empty_run, false, "empty_run false when edits > 0")
  assert.equal(c.early_settle, false, "early_settle false")
  // plan_acc = actual / plan, clamped to [0.1, 10]
  assert.ok(typeof c.plan_acc === "number", "plan_acc is a number")
  assert.ok(c.plan_acc! >= 0.1 && c.plan_acc! <= 10, "plan_acc clamped to [0.1, 10]")
  // Verify formula: actual_min / planned_min (allow small timing variance)
  const actualMin = (Date.parse(settled!.updated_at) - began) / 60000
  const expectedRatio = actualMin / planned
  const expectedClamped = Math.max(0.1, Math.min(10, expectedRatio))
  assert.ok(Math.abs(c.plan_acc! - expectedClamped) < 0.5, `plan_acc ≈ actual/planned: got ${c.plan_acc}, expected ~${expectedClamped}`)
})

test("T41: empty_run detected when completed with zero edits", () => {
  const led = freshLedger()
  const a = beginAgent(led, { input: { agent: "general", description: "[T1] work" }, ref: "ses_empty" })
  // T41/T93: set durable counters (0 edits, 1 injection)
  a.edit_count = 0
  a.injection_count = 1
  const settled = settleAgent(led, "completed", "ses_empty", {})
  assert.ok(settled!.counters!.empty_run, "empty_run = true when completed with zero edits")
  assert.equal(settled!.counters!.injections, 1, "injections recorded from durable counter")
})

test("T41: early_settle detected when session active after settle", () => {
  const led = freshLedger()
  const a = beginAgent(led, { input: { agent: "general", description: "[T1] work" }, ref: "ses_early" })
  a.edit_count = 3
  a.injection_count = 0
  const settled = settleAgent(led, "completed", "ses_early", { earlySettle: true })
  assert.ok(settled!.counters!.early_settle, "early_settle = true when session continued after settle")
})

test("T41: plan_acc is null when eta_min missing or began_at invalid", () => {
  const led = freshLedger()
  const a = beginAgent(led, { input: { agent: "general", description: "[T1] work" }, ref: "ses_noeta" })
  a.eta_min = 0 // missing plan
  a.edit_count = 0
  a.injection_count = 0
  const settled = settleAgent(led, "completed", "ses_noeta", {})
  assert.equal(settled!.counters!.plan_acc, null, "plan_acc = null when eta_min <= 0")
})

test("T41: old record without counters loads without crash (fallback null)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-t41-"))
  const file = join(dir, "state.json")
  try {
    // Write a ledger without counters field (pre-T41 format)
    writeFileSync(file, JSON.stringify({
      version: 1,
      updated_at: new Date().toISOString(),
      tasks: [],
      agents: [{
        id: "A1", task_id: "T1", label: "logOS.runtime.LUNA.demon-001", kind: "general",
        state: "completed", session_ref: "ses_x", home: null, model: "nemotron-3-ultra",
        note: "test", emoji: "🧞", began_at: new Date(Date.now() - 30*60000).toISOString(),
        eta_min: 30, updated_at: new Date().toISOString()
      }],
      tabs: [], models: []
    }), "utf8")
    const loaded = loadLedger(file)
    assert.equal(loaded.agents.length, 1)
    assert.equal(loaded.agents[0].counters, null, "legacy record gets counters: null")
    // Should not throw and counters should be null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------- T92: цена контекста --
// Семантика «injections на задачу»: сколько раз рантайм запустил контекст в
// СЕССИЮ агента (диспатч-промпт по доставке, ETA-самоотчёт). Проекция
// топ-вкладок сюда не считается — у вкладки записи Agent нет, атрибуция «по
// времени активности» врала при параллельных задачах (defect T41/T42).

test("T92: noteInjection → settle: живое не-ноль «цены контекста задачи»", () => {
  const led = freshLedger()
  const a = beginAgent(led, { input: { agent: "general", description: "[T7] dispatch work" }, ref: "ses_t92" })
  assert.equal(a.injection_count ?? 0, 0, "до инжектов счётчик пуст")
  // Диспатч-промпт доставлен → +1; ETA-самоотчёт → +1 (та же точка, что в index.ts)
  assert.equal(noteInjection(led, "ses_t92"), 1, "диспатч-промпт доставлен")
  assert.equal(noteInjection(led, "ses_t92"), 2, "первый ETA-самоотчёт")
  assert.equal(noteInjection(led, "ses_t92"), 3, "второй ETA-самоотчёт")
  assert.equal(a.injection_count, 3, "durable счётчик на записи")
  // Settle читает durable счётчик (без opts) → counters.injections живое, НЕ 0
  const settled = settleAgent(led, "completed", "ses_t92", { earlySettle: false })
  assert.ok(settled, "агент закрылся")
  assert.equal(settled!.counters!.injections, 3, "settle фиксирует живое не-ноль")
  assert.match(formatCountersSignature(settled!.counters!), /\+3/, "подпись несёт +N")
})

test("T92: noteInjection — инжект только живой записи, закрытая/чужая = 0", () => {
  const led = freshLedger()
  const a = beginAgent(led, { input: { agent: "general", description: "[T8] work" }, ref: "ses_t92b" })
  noteInjection(led, "ses_t92b")
  settleAgent(led, "failed", "ses_t92b", {})
  assert.equal(a.counters!.injections, 1, "инжект до смерти учтён")
  // Мёртвому не накручиваем (ETA-таймер снят, поздний prompt не врёт)
  assert.equal(noteInjection(led, "ses_t92b"), 0, "после settle — 0")
  assert.equal(noteInjection(led, "ses_stranger"), 0, "чужая сессия — 0")
  assert.equal(noteInjection(led, null), 0, "без рефа — 0")
  // Ребёнок контекст-рекордера: инжектов не было — честный 0, не дефект
  const child = beginAgent(led, { input: { agent: "general", description: "child session" }, ref: "ses_child" })
  settleAgent(led, "completed", "ses_child", {})
  assert.equal(child.counters!.injections, 0, "ребёнок без диспатча/ETA — честный 0")
})

// ------------------------------------------------------- T42: панель ---------
// Подписи эффективности рендерятся из Agent.counters (T41, пишутся при settle),
// НЕ пересчитываются на рендере; записи без counters — просто без подписи.

test("T42: formatCountersSignature — Δ-план, один ⚠, injections только >0", () => {
  assert.equal(
    formatCountersSignature({ plan_acc: 1.9, empty_run: true, early_settle: true, injections: 3, overrun_min: 0 }),
    "Δ1.9× ⚠ +3",
    "все сигналы компактной строкой",
  )
  assert.equal(
    formatCountersSignature({ plan_acc: 0.8, empty_run: false, early_settle: false, injections: 0, overrun_min: 0 }),
    "Δ0.8×",
    "флаги выключены → только отношение",
  )
  assert.equal(
    formatCountersSignature({ plan_acc: null, empty_run: true, early_settle: false, injections: 0, overrun_min: 0 }),
    "⚠",
    "нет плана → ⚠ сам по себе",
  )
  assert.equal(
    formatCountersSignature({ plan_acc: null, empty_run: false, early_settle: false, injections: 0, overrun_min: 0 }),
    "",
    "пустые counters → без подписи",
  )
  assert.equal(formatCountersSignature(null), "", "запись без counters молчит")
  assert.equal(formatCountersSignature(undefined), "", "undefined тоже молчит")
})

test("T42: строка завершённого несёт подпись, строка работающего — чистая", () => {
  const led = freshLedger()
  upsertTab(led, { session_id: "ses_a", title: "Tab A", model: "mimo", last_seen: "2026-10-07T10:00:00.000Z" })
  must(led, { op: "create", task: "Рендер T42", session_ref: "ses_a" })
  const agent = beginAgent(led, { input: { agent: "general", description: "[T1] render work" }, ref: "ses_a" })

  // Работает: counters ещё нет → ни Δ, ни ⚠.
  let rows = project(led).ui.split("\n")
  const running = rows.find((r) => daemonRow(r) && r.includes("[T1]"))
  assert.ok(running, "строка работающего демона отрисована")
  assert.ok(!running.includes("Δ") && !running.includes("⚠"), `строка чистая: ${running}`)

  // T41/T93: set durable counters on agent record before settle
  agent.edit_count = 0  // empty run
  agent.injection_count = 2
  // Закрылся с флагами → подпись на строке «завершил».
  settleAgent(led, "completed", "ses_a", { emptyRun: true, earlySettle: false })
  rows = project(led).ui.split("\n")
  const settled = rows.find((r) => r.includes("завершил"))
  assert.ok(settled, `строка завершённого отрисована: ${rows.join(" | ")}`)
  assert.ok(settled.includes("Δ"), `отношение план/факт видно: ${settled}`)
  assert.ok(settled.includes("⚠"), `⚠ пустого прогона видно: ${settled}`)
  assert.ok(settled.includes("+2"), `инжекты видны: ${settled}`)
})

test("T42: инстансы сортируются по plan_acc (садящиеся вверху), без данных — вниз", () => {
  const led = freshLedger()
  // Zeta: plan_acc высокий, last_seen СТАРЫЙ, имя последнее по алфавиту —
  // без сортировки T42 ушла бы вниз. Счётчики проставляем напрямую (данные
  // проекции), формулой plan_acc в этом тесте не занимаемся (её тестит T41).
  upsertTab(led, { session_id: "ses_z", title: "Zeta", model: "mimo", last_seen: "2026-10-07T09:00:00.000Z" })
  must(led, { op: "create", task: "Медленная", session_ref: "ses_z" })
  const az = beginAgent(led, { input: { agent: "general", description: "[T1] slow" }, ref: "ses_z" })
  settleAgent(led, "completed", "ses_z", { emptyRun: false, earlySettle: false, injections: 0 })
  az.counters = { plan_acc: 10, empty_run: false, early_settle: false, injections: 0, overrun_min: 0 }
  // Alpha: counters без числового плана, last_seen НОВЫЙ, имя первое по алфавиту.
  upsertTab(led, { session_id: "ses_a", title: "Alpha", model: "mimo", last_seen: "2026-10-07T10:00:00.000Z" })
  must(led, { op: "create", task: "Без плана", session_ref: "ses_a" })
  const aa = beginAgent(led, { input: { agent: "general", description: "[T2] no plan" }, ref: "ses_a" })
  aa.eta_min = 0
  settleAgent(led, "completed", "ses_a", { emptyRun: false, earlySettle: false, injections: 0 })

  // Агрегат инстанса и ключ сортировки.
  assert.equal(formatInstanceCountersSignature([az.id], led), "Δ10.0×", "средний Δ по агентам инстанса")
  assert.equal(formatInstanceCountersSignature([aa.id], led), "", "нет числового плана → без подписи")
  assert.equal(instancePlanAcc([az.id], led), 10, "ключ сортировки — средний plan_acc")
  assert.equal(instancePlanAcc([aa.id], led), null, "без данных → null (в конец списка)")

  const ui = project(led).ui
  const posZ = ui.indexOf("Zeta")
  const posA = ui.indexOf("Alpha")
  assert.ok(posZ >= 0 && posA >= 0, `обе строки инстансов отрисованы: Z=${posZ} A=${posA}`)
  assert.ok(posZ < posA, `садящийся инстанс выше, несмотря на старый last_seen и алфавит: Z=${posZ} A=${posA}`)
  assert.ok(ui.includes("Δ10.0×"), "ось несёт агрегированную подпись инстанса")
})

test("T41: settleOnEvent and settleOnTurn pass through counters (durable)", () => {
  const led = freshLedger()
  const a = beginAgent(led, { input: { agent: "general", description: "[T1] work" }, ref: "ses_event" })
  // T41/T93: set durable counters on agent record
  a.edit_count = 5
  a.injection_count = 3
  const settled = settleOnEvent(led, "completed", "ses_event", "test", { earlySettle: false })
  assert.ok(settled!.counters, "settleOnEvent writes counters")
  assert.equal(settled!.counters!.injections, 3, "injections from durable counter")
  assert.equal(settled!.counters!.empty_run, false, "empty_run false when edits > 0")

  const b = beginAgent(led, { input: { agent: "general", description: "[T2] work" }, ref: "ses_turn" })
  b.edit_count = 0
  b.injection_count = 1
  const settled2 = settleOnTurn(led, "ses_turn", new Set(), Date.now() - 40*60000, "test", undefined, { earlySettle: false })
  assert.ok(settled2!.counters, "settleOnTurn writes counters")
  assert.ok(settled2!.counters!.empty_run, "empty_run true when durable edit_count is 0")
  assert.equal(settled2!.counters!.injections, 1, "injections from durable counter")
})

// ------------------------------------------------- agent death (T46) -------

test("T46: failed event flips an early-settled record to failed + agent_error on the task", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "rate-limited work" })
  must(l, { op: "set_state", id: "T1", state: "DOING", owner: "dev" })
  const a = beginAgent(l, { input: { agent: "general", description: "[T1] work" }, ref: "ses_die" })
  assert.equal(l.tasks[0].agent_error, null, "no mark while the agent lives")

  // ранний settle (пересекается с T52): событие закрыло запись как completed
  assert.equal(settleOnEvent(l, "completed", "ses_die")?.id, a.id)
  assert.equal(a.state, "completed")
  assert.equal(l.tasks[0].agent_error, null, "success carries no mark")

  // живой образец 07.10 02:47: сессия умерла по rate limit ПОСЛЕ раннего settle
  const dead = settleOnEvent(l, "failed", "ses_die", "session.execution.failed (rate limit)")
  assert.equal(dead?.id, a.id)
  assert.equal(a.state, "failed", "the session died → the record says failed")
  assert.match(l.tasks[0].agent_error ?? "", new RegExp(a.id), "the mark names the dead agent")
  assert.match(l.tasks[0].agent_error ?? "", /rate limit/, "the mark carries the reason")

  // повтор события = no-op; поздний success смерть не откатывает
  assert.equal(settleOnEvent(l, "failed", "ses_die", "duplicate"), undefined)
  assert.equal(settleOnEvent(l, "completed", "ses_die"), undefined)
  assert.equal(a.state, "failed", "death is not rolled back by a late success")
  assert.equal(l.tasks.length, 1, "no phantom records")
})

test("T46: a known session closes only its own record; unknown ref keeps the FIFO fallback", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "one" })
  const a1 = beginAgent(l, { input: { agent: "general", description: "[T1] one" }, ref: "ses_1" })
  const a2 = beginAgent(l, { input: { agent: "general", description: "[T1] two" }, ref: "ses_2" })
  assert.equal(settleOnEvent(l, "completed", "ses_2")?.id, a2.id)
  // чужая запись этим событием не закрывается — даже смертью
  assert.equal(settleOnEvent(l, "failed", "ses_1")?.id, a1.id)
  assert.equal(a1.state, "failed")
  assert.equal(a2.state, "completed", "another session's record is never touched")
  assert.match(l.tasks[0].agent_error ?? "", /^A1 /, "only the dead agent's task is marked")
  // сессия неизвестна записям — прежний FIFO-фолбэк (поведение до T46)
  const a3 = beginAgent(l, { input: { agent: "general", description: "free" }, ref: "ses_3" })
  assert.equal(settleOnEvent(l, "failed", "ses_unknown")?.id, a3.id)
  assert.equal(a3.state, "failed")
})

// --------------------------------------------------- T52: ранний settle ----
// Живой образец 07.10 01:34: session.execution.succeeded шины приходит после
// КАЖДОГО хода (A19 помечен completed в 01:34:01, а агент дорабатывал T34 до
// 01:47+) — «первый succeeded» НЕ terminal. Правило: закрытие только по
// terminal-условию = сессии нет в GET /api/session/active (T73) И последнее
// событие сессии старше SETTLE_IDLE_MS (N = TAB_IDLE_MS); смерть (failed)
// остаётся terminal сама по себе.

test("T52: succeeded-ход не закрывает — multi-ход агент живёт несколько ходов подряд", () => {
  const l = freshLedger()
  const a = beginAgent(l, { input: { agent: "general", description: "правка state.ts" }, ref: "ses_live" })
  const active: ReadonlySet<string> = new Set(["ses_live"])
  let at = Date.now()
  for (let turn = 0; turn < 6; turn++) {
    at += 60_000 // ход каждую минуту: активность свежая, сессия в active
    assert.equal(settleOnTurn(l, "ses_live", active, at, "ход", at), undefined, `ход ${turn}: не terminal`)
    assert.equal(a.state, "running", `ход ${turn}: запись живая — панель не пустеет`)
  }
})

test("T52: уход из active + тишина > N — закрывает completed (а свежее событие — нет)", () => {
  const l = freshLedger()
  const a = beginAgent(l, { input: { agent: "general", description: "work" }, ref: "ses_gone" })
  const gone: ReadonlySet<string> = new Set()
  const at = Date.now()
  // ушёл из active, но последнее событие свеже (ход только что) — не terminal
  assert.equal(settleOnTurn(l, "ses_gone", gone, at, undefined, at + 60_000), undefined, "тишина не выдержана")
  assert.equal(a.state, "running", "ранний settle запрещён")
  // ушёл из active И тишина > N — terminal: запись закрыта, ETA-план снимается вместе с ней
  const closed = settleOnTurn(l, "ses_gone", gone, at, undefined, at + SETTLE_IDLE_MS + 1000)
  assert.equal(closed?.id, a.id, "terminal-условие закрыло своего агента")
  assert.equal(a.state, "completed")
})

test("T52: active === null (API молчит) — «ушёл из active» не доказано, не закрываем", () => {
  const l = freshLedger()
  const a = beginAgent(l, { input: { agent: "general", description: "тихо" }, ref: "ses_quiet" })
  const silent = Date.now() - (SETTLE_IDLE_MS * 2)
  assert.equal(settleOnTurn(l, "ses_quiet", null, silent, undefined, Date.now()), undefined, "API молчит — не terminal")
  assert.equal(a.state, "running")
})

test("T52: словаря активности нет (рестарт) — берётся updated_at записи", () => {
  const l = freshLedger()
  const a = beginAgent(l, { input: { agent: "general", description: "после рестарта" }, ref: "ses_boot" })
  const born = Date.parse(a.updated_at)
  // свежая запись и пустой active: данных о тишине нет → не закрываем
  assert.equal(settleOnTurn(l, "ses_boot", new Set(), null, undefined, born + 60_000), undefined)
  assert.equal(a.state, "running")
  // запись молчит дольше N, сессии в active нет — закрываем
  const closed = settleOnTurn(l, "ses_boot", new Set(), null, undefined, born + SETTLE_IDLE_MS + 1000)
  assert.equal(closed?.id, a.id)
  assert.equal(a.state, "completed")
})

test("T52: смерть сессии (failed) закрывает сразу и не откатывается поздним ходом", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "work" })
  must(l, { op: "set_state", id: "T1", state: "DOING", owner: "dev" })
  const a = beginAgent(l, { input: { agent: "general", description: "[T1] work" }, ref: "ses_dead" })
  // terminal-условие тишины смерти не нужно: упавшая сессия = конец
  assert.equal(settleOnEvent(l, "failed", "ses_dead", "session.execution.failed")?.id, a.id)
  assert.equal(a.state, "failed")
  assert.match(l.tasks[0].agent_error ?? "", new RegExp(a.id), "задача помечена")
  // поздний succeeded-ход мёртвого не переоткрывает
  assert.equal(settleOnTurn(l, "ses_dead", new Set(), Date.now(), undefined, Date.now()), undefined)
  assert.equal(a.state, "failed")
})

test("T52: без наблюдаемой ses_-сессии скан не закрывает (чужой ref — не наш случай)", () => {
  const l = freshLedger()
  const a = beginAgent(l, { input: { agent: "general", description: "spawn без ребёнка" }, ref: "call_abc" })
  const silent = Date.now() - (SETTLE_IDLE_MS * 2)
  assert.equal(settleOnTurn(l, "call_abc", new Set(), silent, undefined, Date.now()), undefined, "не ses_ — не наблюдаем")
  assert.equal(settleOnTurn(l, null, new Set(), silent, undefined, Date.now()), undefined, "ref нет — не трогаем")
  assert.equal(a.state, "running")
})

test("T52: SETTLE_IDLE_MS для агентов = 30 мин (DEFAULT_ETA_MIN), TAB_IDLE_MS для вкладок = 5 мин", () => {
  assert.equal(SETTLE_IDLE_MS, 30 * 60_000)
  assert.equal(TAB_IDLE_MS, 5 * 60_000)
  assert.notEqual(SETTLE_IDLE_MS, TAB_IDLE_MS, "agent settle threshold decoupled from tab idle")
})

// ------------------------------------------- T47: дубль-гейт диспатча -------
test("T47: running/waiting-запись задачи блокирует диспатч (live-сессия не нужна)", () => {
  const l = freshLedger()
  const a = beginAgent(l, { input: { agent: "general", description: "[T47] один" }, ref: "ses_t47a" })
  assert.match(liveExecutorConflict(l, "T47", new Set()) ?? "", /executor already running/)
  a.state = "waiting"
  assert.match(liveExecutorConflict(l, "T47", new Set()) ?? "", /executor already running/)
  // чужая running-запись нашу задачу не блокирует
  assert.equal(liveExecutorConflict(l, "T99", new Set()), null)
})

test("T47: терминальная запись + живая сессия в active → дубль-гейт держит", () => {
  const l = freshLedger()
  const a = beginAgent(l, { input: { agent: "general", description: "[T47] ранний settle" }, ref: "ses_t47b" })
  settleAgent(l, "completed", "ses_t47b", {})
  assert.equal(a.state, "completed")
  // сессия ещё в active-пробе (T73) — второй спавн на те же файлы запрещён
  assert.match(liveExecutorConflict(l, "T47", new Set(["ses_t47b"])) ?? "", /дубль-гейт T47/)
  // сессия ушла из active и тишина — ре-диспатч разрешён (terminal-settle пройден)
  assert.equal(liveExecutorConflict(l, "T47", new Set()), null)
})

test("T47: активность сессии ПОСЛЕ settle → дубль-гейт; протухшая активность — нет", () => {
  const l = freshLedger()
  beginAgent(l, { input: { agent: "general", description: "[T47] активность после settle" }, ref: "ses_t47c" })
  settleAgent(l, "completed", "ses_t47c", {})
  const now = Date.now()
  const settledAt = Date.parse(l.agents[0].updated_at)
  // событие сессии зафиксировано позже settle — сессия жила дальше
  assert.match(
    liveExecutorConflict(l, "T47", new Set(), () => settledAt + 1_000, now) ?? "",
    /активность ses_t47c после settle/,
  )
  // запись ещё running (ветка 1) блокирует независимо от активности;
  // активность старше SETTLE_IDLE_MS — протухший словарь не блокирует
  assert.equal(liveExecutorConflict(l, "T47", new Set(), () => now - SETTLE_IDLE_MS - 1, now), null)
  // active молчит (null) + записей нет — честный пропуск
  assert.equal(liveExecutorConflict(l, "T99", null), null)
})

test("T47: запись без ses_-рефа terminal — живость не доказать, не блокируем", () => {
  const l = freshLedger()
  beginAgent(l, { input: { agent: "general", description: "[T47] без рефа" } })
  settleAgent(l, "completed", null, {})
  assert.equal(liveExecutorConflict(l, "T47", new Set(["ses_ghost"])), null)
})

test("T46: agent_error reaches the pane, survives save/load, clears on a new attempt", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-"))
  const file = join(dir, "state.json")
  try {
    const l = freshLedger()
    must(l, { op: "create", task: "умерший исполнитель оставил задачу без работника ".repeat(6) })
    must(l, { op: "set_state", id: "T1", state: "DOING", owner: "dev" })
    const a = beginAgent(l, { input: { agent: "general", description: "[T1] work" }, ref: "ses_ui" })
    settleOnEvent(l, "failed", "ses_ui", "session.execution.failed (обрыв)")

    const ui = project(l).ui
    const headerIdx = ui.split("\n").findIndex((x) => x.startsWith("  ● [T1]"))
    const axis = ui.split("\n")[headerIdx + 1] || ""
    assert.ok(axis.includes("⚠"), "the mark is on the task axis: " + axis)
    assert.ok(axis.includes(a.id), "the axis names the dead agent: " + axis)
    assert.ok(axis.includes("сбой"), "occupancy shows the dead agent: " + axis)
    assert.ok(axis.length <= 360, "ui axis too long (" + axis.length + ")")

    // пометка переживает рестарт (sanitizeTask поле не отбрасывает)
    saveLedger(file, l)
    assert.match(loadLedger(file).tasks[0].agent_error ?? "", new RegExp(a.id))

    // новая попытка снимает пометку
    const retry = beginAgent(l, { input: { agent: "general", description: "[T1] retry" }, ref: "ses_retry" })
    assert.equal(l.tasks[0].agent_error, null, "a fresh attempt clears the mark")
    assert.ok(retry.id)

    // вход в DOING тоже снимает: старая смерть ретраю не мешает
    markAgentError(l, "T1", "A99 умер: probe")
    assert.match(l.tasks[0].agent_error ?? "", /probe/)
    must(l, { op: "set_state", id: "T1", state: "WAIT" })
    must(l, { op: "set_state", id: "T1", state: "DOING", owner: "dev" })
    assert.equal(l.tasks[0].agent_error, null, "entering DOING clears the mark")

    // закрытие задачи = вопрос решён
    markAgentError(l, "T1", "A99 умер: probe again")
    must(l, { op: "set_state", id: "T1", state: "DONE", verification: "v" })
    assert.equal(l.tasks[0].agent_error, null, "closing the task resolves the mark")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("T164: устаревший держатель не затирает свежие записи — CAS-слияние по updated_at", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-"))
  const file = join(dir, "state.json")
  try {
    // базовый файл: задача T1
    const base = freshLedger()
    must(base, { op: "create", task: "базовая задача" })
    saveLedger(file, base)

    // держатель W загрузил файл (штамп = тогдашний updated_at)
    const holder = loadLedger(file)
    assert.equal(holder.tasks.length, 1)

    // тем временем другой писатель добавил T2 и поднял T1 в DOING
    const other = loadLedger(file)
    must(other, { op: "create", task: "свежая задача" })
    must(other, { op: "set_state", id: "T1", state: "DOING", owner: "dev" })
    saveLedger(file, other)
    assert.equal(loadLedger(file).tasks.length, 2)

    // W с его устаревшим снимком сохраняется ПОСЛЕ — затирания быть не должно:
    // T2 (которого у W нет) выживает, T1 остаётся DOING (свежее обновление старше)
    saveLedger(file, holder)
    const back = loadLedger(file)
    assert.equal(back.tasks.length, 2, "устаревший снимок не стёр T2")
    assert.equal(back.tasks.find((t) => t.id === "T1")?.state, "DOING", "LWW: свежий DOING не откатился в WAIT")
    // собственная мутация держателя (обновил T1 текст) с БОЛЕЕ новым updated_at всё же побеждает
    const later = loadLedger(file)
    must(later, { op: "update", id: "T1", task: "новее всех" })
    saveLedger(file, later)
    assert.equal(loadLedger(file).tasks.find((t) => t.id === "T1")?.task, "новее всех", "новая мутация доходит")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("T164: точный file-stamp ловит изменения с тем же updated_at", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-stamp-"))
  const file = join(dir, "state.json")
  try {
    const base = freshLedger()
    must(base, { op: "create", task: "задача до параллельной записи" })
    saveLedger(file, base)

    const stale = loadLedger(file)
    const external = loadLedger(file)
    // Имитируем два изменения в одной миллисекунде: байты файла меняются,
    // а updated_at намеренно остаётся прежним. Старый stamp пропускал merge.
    external.tasks[0].state = "DOING"
    external.tasks[0].owner = "external-writer"
    external.tasks[0].updated_at = stale.tasks[0].updated_at
    external.updated_at = stale.updated_at
    writeFileSync(file, JSON.stringify(external, null, 2) + "\n", "utf8")

    saveLedger(file, stale)
    const saved = loadLedger(file)
    assert.equal(saved.tasks[0].state, "DOING", "свежее содержимое не затирается совпавшим updated_at")
    assert.equal(saved.tasks[0].owner, "external-writer")
    assert.equal(existsSync(file + ".lock"), false, "lock освобождён после записи")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("T164: восстановление из backup не перезаписывает валидный .bak битым primary", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-backup-recovery-"))
  const file = join(dir, "state.json")
  try {
    const first = freshLedger()
    must(first, { op: "create", task: "резервный валидный снимок" })
    saveLedger(file, first)
    const second = loadLedger(file)
    must(second, { op: "create", task: "последующий снимок" })
    saveLedger(file, second)
    const validBackup = readFileSync(file + ".bak", "utf8")

    writeFileSync(file, "{ definitely not valid JSON", "utf8")
    const recovered = loadLedger(file)
    assert.equal(recovered.tasks.length, 1, "битый primary восстановлен из предыдущего backup")
    saveLedger(file, recovered)

    assert.equal(readFileSync(file + ".bak", "utf8"), validBackup, "битый primary не затирает последнюю валидную резервную копию")
    assert.equal(loadLedger(file).tasks.length, 1, "восстановленный primary читается")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("T164: леджер, созданный после пустой загрузки, сливается с первым снимком", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-first-write-"))
  const file = join(dir, "state.json")
  try {
    const first = freshLedger()
    const second = freshLedger()
    must(first, { op: "create", task: "первый независимый writer" })
    must(second, { op: "create", task: "второй независимый writer" })
    second.tasks[0].id = "T2" // изолируем проблему слияния от отдельной гонки аллокатора ID

    saveLedger(file, first)
    saveLedger(file, second)

    const saved = loadLedger(file)
    assert.deepEqual(saved.tasks.map((task) => task.id).sort(), ["T1", "T2"], "первый writer не теряет запись второго")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("P0-A: параллельные процессы создают уникальные task/agent ID и не теряют записи", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-id-reservation-"))
  const file = join(dir, "state.json")
  try {
    const base = freshLedger()
    must(base, { op: "create", task: "последний существующий ID" })
    base.tasks[0].id = "T40"
    beginAgent(base, { input: { agent: "general", description: "последний агент" }, ref: "ses_previous" }).id = "A20"
    saveLedger(file, base)

    const stateUrl = new URL("./state.ts", import.meta.url).href
    const script = `
      import { loadLedger, applyOp, beginAgent, saveLedger } from ${JSON.stringify(stateUrl)};
      const file = ${JSON.stringify(file)};
      const ledger = loadLedger(file);
      const task = applyOp(ledger, { op: "create", task: "parallel child task", owner: "dev" }, { idFile: file });
      if (!task.ok) throw new Error(task.error);
      const agent = beginAgent(ledger, { input: { agent: "general", description: "parallel child agent" }, ref: "call_" + process.pid, idFile: file });
      saveLedger(file, ledger);
      console.log(JSON.stringify({ task: task.task.id, agent: agent.id }));
    `
    const launches = Array.from({ length: 8 }, () => new Promise<{ task: string; agent: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] })
      let stdout = ""
      let stderr = ""
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
      child.on("error", reject)
      child.on("close", (code) => {
        if (code !== 0) return reject(new Error(`allocator child exit ${code}: ${stderr}`))
        try { resolve(JSON.parse(stdout.trim())) } catch (error) { reject(new Error(`bad allocator child output: ${stdout} (${String(error)})`)) }
      })
    }))
    const results = await Promise.all(launches)
    const taskIds = results.map((row) => row.task)
    const agentIds = results.map((row) => row.agent)
    assert.equal(new Set(taskIds).size, 8, `task IDs are unique: ${taskIds.join(", ")}`)
    assert.equal(new Set(agentIds).size, 8, `agent IDs are unique: ${agentIds.join(", ")}`)
    assert.deepEqual(taskIds.map((id) => Number(id.slice(1))).sort((a, b) => a - b), [41, 42, 43, 44, 45, 46, 47, 48])
    assert.deepEqual(agentIds.map((id) => Number(id.slice(1))).sort((a, b) => a - b), [21, 22, 23, 24, 25, 26, 27, 28])

    const saved = loadLedger(file)
    assert.equal(saved.tasks.filter((task) => task.task === "parallel child task").length, 8, "all task rows survived independent saves")
    assert.equal(saved.agents.filter((agent) => agent.session_ref?.startsWith("call_")).length, 8, "all agent rows survived independent saves")
    assert.ok(existsSync(`${file}.ids.json`), "durable reservation sidecar created")
    assert.equal(existsSync(`${file}.ids.json.lock`), false, "allocator lock released")
    assert.equal(existsSync(`${file}.lock`), false, "ledger lock released")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("P0-A: ID allocator seeds from backup after primary ledger corruption", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-id-backup-"))
  const file = join(dir, "state.json")
  try {
    writeFileSync(file, "{ broken primary", "utf8")
    writeFileSync(`${file}.bak`, JSON.stringify({ tasks: [{ id: "T70" }], agents: [{ id: "A30" }] }), "utf8")
    assert.equal(reserveLedgerId(file, "task"), "T71")
    assert.equal(reserveLedgerId(file, "agent"), "A31")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("P0-A: corrupted ID sidecar fails closed instead of reissuing a reservation", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-id-corrupt-"))
  const file = join(dir, "state.json")
  try {
    writeFileSync(`${file}.ids.json`, "{ broken allocator", "utf8")
    assert.throws(() => reserveLedgerId(file, "task", [{ id: "T99" }]), /allocator is corrupt/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("P0-A: runtime ID options keep task and agent creation on the durable allocator", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-id-runtime-"))
  const file = join(dir, "state.json")
  try {
    const l = freshLedger()
    const one = applyOp(l, { op: "create", task: "через runtime" }, { idFile: file })
    assert.equal(one.ok, true)
    assert.equal(one.ok ? one.task.id : "", "T1")
    const agent = beginAgent(l, { input: { agent: "general" }, idFile: file })
    assert.equal(agent.id, "A1")
    const stale = freshLedger()
    const two = applyOp(stale, { op: "create", task: "второй snapshot" }, { idFile: file })
    assert.equal(two.ok ? two.task.id : "", "T2", "stale in-memory state cannot reissue T1")
    const secondAgent = beginAgent(stale, { input: { agent: "general" }, idFile: file })
    assert.equal(secondAgent.id, "A2", "agent counter is independent and monotonic")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("P0-B: независимые model increments суммируются по baseline ровно один раз", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-model-merge-"))
  const file = join(dir, "state.json")
  const model = "opencode/glm-5.3-flash-free"
  const cls = "dev:small" as const
  try {
    const seed = freshLedger()
    seed.models = [{ model, ok: 10, fail: 2, upstream_fails: 4, upstream_streak: 3, cooldown_until: null,
      byClass: { [cls]: { ok: 5, fail: 1, editsPerSecSum: 2, runs: 6 } } as never }]
    saveLedger(file, seed)

    const first = loadLedger(file)
    const second = loadLedger(file)
    recordModelResultByClass(first, model, cls, true, 0.5)
    recordModelResultByClass(second, model, cls, true, 0.5)
    saveLedger(file, first)
    saveLedger(file, second)

    let stat = modelStats(loadLedger(file)).find((row) => row.model === model)!
    assert.equal(stat.ok, 12, "оба независимых ok учитываются")
    assert.deepEqual(stat.byClass?.[cls], { ok: 7, fail: 1, editsPerSecSum: 3, runs: 8 })
    assert.equal(stat.fail, 2, "неизменённый fail сохраняется")
    assert.equal(stat.upstream_fails, 4, "неизменённый upstream counter сохраняется")

    saveLedger(file, second)
    stat = modelStats(loadLedger(file)).find((row) => row.model === model)!
    assert.equal(stat.ok, 12, "повторное сохранение того же снимка не задваивает delta")
    assert.equal(stat.byClass?.[cls].runs, 8)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("P0-B: новые model rows из пустого baseline складывают оба независимых результата", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-model-empty-baseline-"))
  const file = join(dir, "state.json")
  const model = "opencode/glm-5.3-flash-free"
  const cls = "dev:small" as const
  try {
    saveLedger(file, freshLedger())
    const first = loadLedger(file)
    const second = loadLedger(file)
    recordModelResultByClass(first, model, cls, true, 0.25)
    recordModelResultByClass(second, model, cls, true, 0.5)
    saveLedger(file, first)
    saveLedger(file, second)
    const stat = modelStats(loadLedger(file)).find((row) => row.model === model)!
    assert.equal(stat.ok, 2, "both writers created a new row, so both increments survive")
    assert.deepEqual(stat.byClass?.[cls], { ok: 2, fail: 0, editsPerSecSum: 0.75, runs: 2 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("P0-B: per-class recording does not double-count global totals when lifecycle already recorded them", () => {
  const model = "opencode/glm-5.3-flash-free"
  const cls = "dev:small" as const
  const l = freshLedger()
  recordModelResult(l, model, true)
  recordModelResultByClass(l, model, cls, true, 0.5, undefined, false)
  let stat = modelStats(l).find((row) => row.model === model)!
  assert.equal(stat.ok, 1, "one completed agent is one global success")
  assert.deepEqual(stat.byClass?.[cls], { ok: 1, fail: 0, editsPerSecSum: 0.5, runs: 1 })

  const failed = freshLedger()
  recordModelResult(failed, model, false, "upstream")
  recordModelResultByClass(failed, model, cls, false, 0.1, "upstream", false)
  stat = modelStats(failed).find((row) => row.model === model)!
  assert.equal(stat.upstream_fails, 1, "one endpoint failure is one global upstream failure")
  assert.equal(stat.byClass?.[cls].runs, 1, "the per-class run is still retained")
  assert.equal(stat.byClass?.[cls].fail, 0, "upstream does not poison model fail-rate")
})

test("P0-B: явный reset upstream-стрика и cooldown побеждает старый writer", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-model-reset-"))
  const file = join(dir, "state.json")
  const model = "opencode/glm-5.3-flash-free"
  try {
    const seed = freshLedger()
    seed.models = [{ model, ok: 4, fail: 0, upstream_fails: 3, upstream_streak: 4,
      cooldown_until: new Date(Date.now() + 60_000).toISOString(),
      upstream_streak_reset_at: "2026-11-01T00:00:00.000Z",
      upstream_streak_updated_at: "2026-11-01T00:00:00.000Z",
      cooldown_updated_at: "2026-11-01T00:00:00.000Z" }]
    saveLedger(file, seed)

    const stale = loadLedger(file)
    const reset = loadLedger(file)
    bumpUpstreamCooldown(stale, model, 10_000, Date.now() - 5_000)
    resetModelCooldowns(reset)
    saveLedger(file, reset)
    saveLedger(file, stale)

    const stat = modelStats(loadLedger(file)).find((row) => row.model === model)!
    assert.equal(stat.upstream_streak, 0, "pre-reset stale increment is discarded")
    assert.equal(stat.cooldown_until, null, "pre-reset stale cooldown is not restored")
    assert.ok(stat.upstream_streak_reset_at && Date.parse(stat.upstream_streak_reset_at) > Date.parse("2026-11-01T00:00:00.000Z"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("P0-C: tombstone не даёт stale snapshot воскресить удалённого агента", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-agent-tombstone-"))
  const file = join(dir, "state.json")
  try {
    const base = freshLedger()
    beginAgent(base, { input: { agent: "general", description: "spawn call record" }, ref: "call_1" })
    beginAgent(base, { input: { agent: "general", description: "child session record" }, ref: "ses_child" })
    saveLedger(file, base)

    const stale = loadLedger(file)
    const current = loadLedger(file)
    const removedId = current.agents.find((agent) => agent.session_ref === "ses_child")!.id
    assert.ok(rekeyAgent(current, "call_1", "ses_child"), "rekey absorbs duplicate record")
    assert.ok(current.tombstones?.agents?.[removedId], "removed duplicate receives durable tombstone")
    saveLedger(file, current)
    saveLedger(file, stale)

    const saved = loadLedger(file)
    assert.ok(!saved.agents.some((agent) => agent.id === removedId), "stale writer cannot resurrect removed agent")
    assert.ok(saved.tombstones?.agents?.[removedId], "tombstone survives roundtrip")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("P0-C: tombstone скрывает сущность даже если старый файл содержит и строку, и маркер удаления", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-tombstone-read-"))
  const file = join(dir, "state.json")
  try {
    const l = freshLedger()
    const removed = beginAgent(l, { input: { agent: "general" }, ref: "call_deleted" })
    l.tombstones = { agents: { [removed.id]: new Date().toISOString() } }
    saveLedger(file, l)
    const loaded = loadLedger(file)
    assert.ok(!loaded.agents.some((agent) => agent.id === removed.id), "read normalization obeys tombstone before projection")
    assert.ok(loaded.tombstones?.agents?.[removed.id], "deletion marker remains durable")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("T166: ипостась ребёнка назначает фреймворк по классу задачи — без каталога и без выбора", () => {
  // детерминированная карта класс → ипостась
  assert.equal(personaForTaskClass("qc")?.id, "mary-sue")
  assert.equal(personaForTaskClass("dev:large")?.id, "mara")
  assert.equal(personaForTaskClass("dev:small")?.id, "masha")
  assert.equal(personaForTaskClass("research:large")?.id, "curie", "префикс research → Кюри")
  assert.equal(personaForTaskClass("research:small")?.id, "curie")
  assert.equal(personaForTaskClass(null), null)
  assert.equal(personaForTaskClass(""), null)
  // фиксированный блок: короткий, без каталога, без «выбери ОДНУ»
  const fixed = personaPromptBlock(null, personaForTaskClass("dev:small"))
  assert.match(fixed, /назначена фреймворком по классу задачи/, "режим T166 назван")
  assert.match(fixed, /Маша/, "имя назначенной ипостаси в блоке")
  assert.ok(!fixed.includes("Каталог ипостасей"), "каталога в диспатч-блоке больше нет")
  assert.ok(fixed.length < 700, `блок короткий (${fixed.length} симв. против ~1.5КБ каталога)`)
  // каталог жив для ручных спавнов (T102-режим не тронут)
  const catalog = personaPromptBlock()
  assert.match(catalog, /Каталог ипостасей/)
  assert.match(catalog, /ОДНУ ипостась/)
})

test("T166: эскалация upstream-кулдауна — серия смертей удлиняет окно, успех сбрасывает", () => {
  const l = freshLedger()
  const base = 5 * 60_000 // половина COOLDOWN_MS, T153
  const t0 = Date.now()
  const u1 = bumpUpstreamCooldown(l, "opencode-go/mimo-v2.6-flash", base, t0)
  const s1 = modelStats(l).find((x) => x.model === "opencode-go/mimo-v2.6-flash")
  assert.equal(s1?.upstream_streak, 1, "серия началась с 1")
  assert.equal(Date.parse(u1 ?? "") - t0, base, "первый провал = базовое окно")
  bumpUpstreamCooldown(l, "opencode-go/mimo-v2.6-flash", base, t0)
  const s2 = modelStats(l).find((x) => x.model === "opencode-go/mimo-v2.6-flash")
  assert.equal(s2?.upstream_streak, 2)
  assert.ok(Date.parse(s2?.cooldown_until ?? "") - t0 > base, "второй провал длиннее базового")
  for (let i = 0; i < 5; i++) bumpUpstreamCooldown(l, "opencode-go/mimo-v2.6-flash", base, t0)
  const s3 = modelStats(l).find((x) => x.model === "opencode-go/mimo-v2.6-flash")
  assert.equal(s3?.upstream_streak, 7)
  assert.equal(Date.parse(s3?.cooldown_until ?? "") - t0, base * 4, "cap ×4 (молотилки по трупу нет)")
  // успех сбрасывает серию
  recordModelResult(l, "opencode-go/mimo-v2.6-flash", true)
  const s4 = modelStats(l).find((x) => x.model === "opencode-go/mimo-v2.6-flash")
  assert.equal(s4?.upstream_streak, 0, "успех обнуляет серию эскалации")
  // чужая модель не эскалируется
  assert.equal(bumpUpstreamCooldown(l, "gpt-6-luna", base, t0), null)
})

test("T166: re-examine проба не втыкает в кулдаун при живых альтернативах", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "задача для выбора модели" })
  must(l, { op: "set_state", id: "T1", state: "DOING", owner: "dev" })
  // лидер dev:small после warmup-стиля: крутим пробы, пока не выпадет re-examine
  // (детерминированный хэш) — проверяем инвариант: выбранная модель не в кулдауне,
  // если есть хоть одна живая в пуле.
  for (const m of ["opencode-go/mimo-v2.6-flash", "opencode/deepseek-v4.1-flash-free", "opencode/nemotron-3.5-super-vl-free", "opencode/glm-5.3-flash-free"]) {
    for (let i = 0; i < 6; i++) recordModelResultByClass(l, m, "dev:small", i % 3 !== 2, 0.2)
  }
  // строим пул: primary живо (glm/nemotron), secondary охлаждён кроме beam —
  // ИНВАРИАНТ (канон выбора): «кулдаун проигрывает отсутствию модели», поэтому
  // poolKeys = живое первичное звено; проба должна брать alt ИЗ poolKeys и alt
  // обязан быть жив (жизнь в primary гарантирована построением).
  const pool = childPool().primary.concat(childPool().secondary)
  const baseAt = Date.now()
  for (const m of pool) {
    if (!childPool().primary.includes(m) && m !== "opencode/beam-free") setModelCooldown(l, m, 600_000, baseAt)
  }
  let sawReexamine = false
  for (let i = 0; i < 40; i++) {
    l.updated_at = new Date(baseAt + i * 101_000).toISOString() // seed re-examine меняется
    const at = baseAt + i * 61_000 // внутри 600-секундного окна: живое остаётся живым
    const r = chooseModelByClass(l, "dev:small", null, undefined, at)
    if (r.reason.startsWith("re-examine")) {
      sawReexamine = true
      assert.notEqual(r.model, "opencode-go/mimo-v2.6-flash", "проба не выбирает модель в кулдауне")
      const alt = modelStats(l).find((x) => x.model === r.model)
      assert.equal(onCooldown(alt, at), false, `alt ${r.model} не в кулдауне (живая альтернатива была)`)
    }
  }
  assert.ok(sawReexamine, "детерминированный обход должен был наткнуться на re-examine")
})

test("T165-хвост: models мержится монотонно — кулдаун и счётчики не откатываются", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-"))
  const file = join(dir, "state.json")
  try {
    const base = freshLedger()
    saveLedger(file, base)
    const holder = loadLedger(file) // держатель со старым снимком (кулдаунов не знает)
    // другой писатель поставил карантин и накрутил статы — В САМОЙ записи
    // (modelStats отдаёт нормализованную копию, мутировать надо other.models)
    const other = loadLedger(file)
    const t0 = Date.now()
    setModelCooldown(other, "opencode-go/mimo-v2.6-flash", 120_000, t0)
    const st = other.models!.find((x) => x.model === "opencode-go/mimo-v2.6-flash")!
    st.ok += 3
    st.fail += 1
    st.upstream_fails = 2
    st.upstream_streak = 2
    saveLedger(file, other)
    // устаревший держатель сохраняется — карантин и статы должны выжить
    saveLedger(file, holder)
    const back = modelStats(loadLedger(file)).find((x) => x.model === "opencode-go/mimo-v2.6-flash")
    assert.ok(back, "запись модели выжила")
    assert.equal(back.cooldown_until, st.cooldown_until, "кулдаун не откатился")
    assert.equal(back.ok, 3, "ok не откатился")
    assert.equal(back.fail, 1, "fail не откатился")
    assert.equal(back.upstream_fails, 2, "upstream_fails не откатился")
    assert.equal(back.upstream_streak, 2, "стрик не откатился")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("T165-хвост: agent-id коллизия A180×2 — аллокатор выжимает max по свежему файлу", () => {
  // симуляция гонки: два снимка леджера, у обоих max A179
  const l1 = freshLedger()
  const l2 = freshLedger()
  const mk = (id: string): Agent => ({
    id,
    task_id: null,
    label: "demon",
    kind: "general",
    state: "running",
    session_ref: null,
    home: null,
    model: null,
    note: null,
    emoji: "🤖",
    began_at: new Date().toISOString(),
    injections: 0,
    eta_min: 30,
    edited_files: [],
  })
  // снимок 2 уже знает A180 (первый диспатч успел засейвиться), снимок 1 — нет
  l1.agents = [mk("A179")]
  l2.agents = [mk("A179"), mk("A180")]
  assert.equal(nextAgentId(l2.agents), "A181", "снимок с A180 даёт A181")
  assert.equal(nextAgentId(l1.agents), "A180", "устаревший снимок даёт A180 (сериализатор не даст второго)")
})

test("agents persist: loadLedger sanitizes; invalid agent state refuses to load", () => {  const dir = mkdtempSync(join(tmpdir(), "dev-console-"))
  const file = join(dir, "state.json")
  try {
    const led = freshLedger()
    beginAgent(led, { input: { agent: "qc", description: "[T9] check" }, ref: "c-1" })
    saveLedger(file, led)
    const back = loadLedger(file)
    // T41/T93: loaded agents get durable counters (0) and counters: null for records without settled metrics
    assert.deepEqual(
      back.agents.map(a => ({...a, counters: null, edit_count: 0, injection_count: 0})),
      led.agents.map(a => ({...a, counters: null, edit_count: 0, injection_count: 0}))
    )

    const legacy = { version: 1, tasks: [], agents: [{ id: "A1", label: "x", state: "runing", updated_at: "t" }] }
    writeFileSync(file, JSON.stringify(legacy), "utf8")
    assert.throws(() => loadLedger(file), /invalid state/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("migration: legacy task fields are stripped; blocker/question → why", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-"))
  const file = join(dir, "state.json")
  try {
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        updated_at: new Date().toISOString(),
        agents: [],
        tasks: [
          {
            id: "T1",
            task: "Old task",
            state: "BLOCKED",
            owner: "dev",
            blocker: "was blocked",
            question: null,
            next_action: "legacy",
            reopen_reason: null,
            verification: null,
            created_at: "2026-10-01T00:00:00.000Z",
            updated_at: "2026-10-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    )
    const led = loadLedger(file)
    const t = led.tasks[0]
    assert.equal(t.why, "was blocked", "legacy blocker migrated into why")
    assert.ok(!("blocker" in t) && !("question" in t) && !("next_action" in t) && !("reopen_reason" in t))

    writeFileSync(
      file,
      JSON.stringify({ version: 1, tasks: [{ id: "T9", state: "PLANNED", task: "x" }], agents: [] }),
      "utf8",
    )
    assert.throws(() => loadLedger(file), /invalid state/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ----------------------------------------------------------- persistence ----

test("save → load round trip; missing file → fresh; corrupt → throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-"))
  const file = join(dir, "DEVATA", "state.json")
  try {
    assert.equal(loadLedger(file).tasks.length, 0, "missing file → fresh ledger")

    const led = freshLedger()
    must(led, { op: "create", task: "Persistent task", owner: "qc" })
    must(led, { op: "set_state", id: "T1", state: "BLOCKED", why: "waiting for API key" })
    saveLedger(file, led)

    const back = loadLedger(file)
    assert.deepEqual(back.tasks, led.tasks)
    assert.equal(back.version, 1)

    writeFileSync(file, "{ not json", "utf8")
    assert.throws(() => loadLedger(file), /not valid JSON/)

    writeFileSync(file, JSON.stringify({ version: 1, tasks: "nope", agents: [] }), "utf8")
    assert.throws(() => loadLedger(file), /unexpected shape/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------- console pane html ---

test("renderConsoleHtml: live-pane markup (refresh, charset, timestamp)", () => {
  const html = renderConsoleHtml("━━ 🛰 LAVK ━━\n🔄 В РАБОТЕ\n  ● [T1] x", "2026-10-04T00:00:00.000Z")
  assert.ok(html.includes('http-equiv="refresh" content="10"'), "мета-рефреш 10с (канон T104(2), заказ Основателя 24.10); CPU-предохранитель 1ч (10.11) снят 15.11 по жалобе «стейт не обновляется» — виновники CPU были другие (OneDrive, таймеры)")
  assert.ok(html.includes('charset="utf-8"'), "utf-8 declared")
  assert.ok(html.includes("2026-10-04T00:00:00.000Z"), "updated_at shown")
  assert.ok(html.includes("В РАБОТЕ"), "ui content embedded")
  assert.ok(html.startsWith("<!doctype html>"), "html document")
  // The colorizer must be valid JS: no literal newline inside script strings
  // (that killed the first live build). T43: строки добавляются живыми узлами —
  // innerHTML-join убран (round-trip подменял узлы и терял слушатели).
  assert.ok(html.includes("rowEls.forEach(function (el) { wrap.appendChild(el); })"), "строки — живыми узлами, не join-строкой")
  assert.ok(!html.includes('.join("\n")'), "no raw newline inside script strings")
})

test("renderConsoleHtml: hostile task text cannot break out of the script", () => {
  const html = renderConsoleHtml("  ● [T1] </script><img src=x onerror=alert(1)>", "x")
  assert.ok(!html.includes("</script><img"), "no raw tag breakout")
  assert.ok(html.includes("\\u003c"), "embedded as escaped JS string")
})

test("renderConsoleHtml: live countdown — plan embedded, client ticker every second", () => {
  const l = freshLedger()
  beginAgent(l, { input: { agent: "general", description: "[T1] work" }, ref: "ses_e1" })
  const p = project(l)
  const html = renderConsoleHtml(p.ui, l.updated_at, p.agents)
  assert.ok(html.includes("const ETA = {"), "agent plans embedded in the page")
  assert.ok(html.includes('data-t0='), "⏱ token carries its plan into the DOM")
  assert.ok(html.includes("setInterval(tickEta, 1000)"), "client re-ticks every second")
  assert.ok(html.includes('class="eta"'), "countdown span rendered by the script")
  // no agents → no plan payload, ticker still harmless
  const empty = renderConsoleHtml("x", "t")
  assert.ok(empty.includes("const ETA = {}"), "empty plan payload by default")
})

// ------------------------------------------------- glance, not dump (ui) ---

test("ui clips long task/why texts; full text stays in the ledger only", () => {
  const l = freshLedger()
  apply(l, { op: "create", task: "Дублирование блока участников: ".repeat(20) + "конец" })
  apply(l, { op: "set_state", id: "T1", state: "DOING" })
  apply(l, { op: "create", task: "B" })
  apply(l, { op: "set_state", id: "T2", state: "BLOCKED", why: "почему-то очень длинное ".repeat(30) })
  const ui = project(l).ui
  for (const line of ui.split("\n")) {
    assert.ok(line.length <= 360, `ui line too long (${line.length}): ${line.slice(0, 50)}…`)
  }
  assert.ok(ui.includes("…"), "clipped lines carry an ellipsis")
  assert.ok(JSON.stringify(l).includes("конец"), "full text still in the ledger")
})

test("T74(3): недавно завершённый (settle ≤15 мин) — тусклая строка с ✓; дальше консоль = живое состояние", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "Done one" })
  must(l, { op: "set_state", id: "T1", state: "DONE", verification: "v" })
  const a = beginAgent(l, { input: { agent: "general", description: "[T1] probe" }, ref: "ses_x1" })
  settleAgent(l, "completed", "ses_x1")

  let p = project(l)
  assert.ok(!p.ui.includes("✅"), "no completed block")
  assert.ok(!p.ui.includes("📂"), "settled agent never claims a section (T162: старый глиф 📂 не рисуется)")
  assert.ok(!p.ui.includes("general-1"), "no settled labels")
  const row = p.ui.split("\n").find((x) => x.includes(`✓ ${demonName(a.id)}`))
  assert.ok(row, `свежий settle виден тусклой строкой с ✓: ${p.ui}`)
  assert.ok(row!.includes("[T1]") && row!.includes("завершил"), `что делал — честно: ${row}`)
  assert.ok(!/⏱/.test(row!), "план закрыт вместе с агентом — отсчёта нет")
  assert.equal(p.done.length, 1, "ledger history intact")
  assert.equal(p.agents.length, 0, "running list truthful")

  // панель: строка завершённого узнаётся по ✓ и гасится (не жёлтая/не фиолетовая)
  const html = renderConsoleHtml(p.ui, l.updated_at, p.agents)
  assert.ok(html.includes('cls = "fin"'), "цветовая раскраска знает тусклые строки")
  assert.ok(html.includes(".fin { color:#484f58; font-weight:normal; }"), "тусклая строка поставлена в стилях")

  // старше 15 минут — строки больше нет: дальше не тянем (order 04.10)
  a.updated_at = new Date(Date.now() - SETTLED_FRESH_MS - 60_000).toISOString()
  p = project(l)
  assert.ok(!p.ui.includes(demonName(a.id)), "старый settle не показывается: консоль = живое состояние")
  assert.equal(p.agents.length, 0, "и в живых не появился")
})

// --------------------------------------------------------- progress bars ---

test("decomposition: parent bar = children DONE/total; children marked ↳", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "Big feature" })
  must(l, { op: "create", task: "step one", parent: "T1" })
  must(l, { op: "create", task: "step two", parent: "T1" })
  must(l, { op: "set_state", id: "T2", state: "DONE", verification: "v" })
  const ui = project(l).ui
  // T99: parent has header + axis; bar on axis
  const parentIdx = ui.split("\n").findIndex((x) => x.includes("[T1]"))
  const parentAxis = ui.split("\n")[parentIdx + 1] || ""
  assert.ok(parentAxis.includes("▰▰▱▱▱ 1/2"), `bar on parent axis: ${parentAxis}`)
  const childHeader = ui.split("\n").find((x) => x.includes("[T3]"))!
  assert.ok(childHeader.startsWith("    ↳"), `child header marked ↳ (отступ 4, T89): ${childHeader}`)
})

test("no decomposition → no bar (never invent a percent)", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "Plain task" })
  must(l, { op: "set_state", id: "T1", state: "DOING" })
  const line = project(l).ui.split("\n").find((x) => x.includes("[T1]"))!
  assert.ok(!line.includes("▰") && !line.includes("▱"), line)
})

test("create: unknown parent rejected", () => {
  const l = freshLedger()
  assert.match(err(l, { op: "create", task: "x", parent: "T9" }), /parent/)
})

// ----------------------------------------------------- T39: Plan markers in panel ---

test("T39: parent task with children est_min renders plan label and marker", () => {
  const l = freshLedger()
  const parent = must(l, { op: "create", task: "Parent feature", est_min: 60 })
  must(l, { op: "create", task: "Child 1", parent: parent.id, est_min: 30 })
  must(l, { op: "create", task: "Child 2", parent: parent.id, est_min: 30 })
  const p = project(l)
  // T99: parent has header + axis; plan info on axis
  const parentIdx = p.ui.split("\n").findIndex((x) => x.includes("[T1]"))
  const parentAxis = p.ui.split("\n")[parentIdx + 1] || ""
  // Should have fact bar (0/2) and plan label (⏱60м) and plan marker (▏)
  assert.ok(parentAxis.includes("0/2"), `fact bar: ${parentAxis}`)
  assert.ok(parentAxis.includes("⏱"), `plan label: ${parentAxis}`)
  assert.ok(parentAxis.includes("▏"), `plan marker present: ${parentAxis}`)
})

test("T39: parent task without children est_min renders fact bar only (no plan marker)", () => {
  const l = freshLedger()
  const parent = must(l, { op: "create", task: "Parent feature" }) // no est_min
  must(l, { op: "create", task: "Child 1", parent: parent.id }) // no est_min
  must(l, { op: "create", task: "Child 2", parent: parent.id }) // no est_min
  const p = project(l)
  // T99: parent has header + axis; plan info on axis
  const parentIdx = p.ui.split("\n").findIndex((x) => x.includes("[T1]"))
  const parentAxis = p.ui.split("\n")[parentIdx + 1] || ""
  // Should have fact bar (0/2) but no plan label/marker
  assert.ok(parentAxis.includes("0/2"), `fact bar: ${parentAxis}`)
  assert.ok(!parentAxis.includes("⏱"), `no plan label: ${parentAxis}`)
  assert.ok(!parentAxis.includes("▏"), `no plan marker: ${parentAxis}`)
})

test("T39: renderConsoleHtml embeds PLAN data for parent tasks with est_min children", () => {
  const l = freshLedger()
  const parent = must(l, { op: "create", task: "Parent feature", est_min: 60 })
  must(l, { op: "create", task: "Child 1", parent: parent.id, est_min: 30 })
  must(l, { op: "create", task: "Child 2", parent: parent.id, est_min: 30 })
  const p = project(l)
  const html = renderConsoleHtml(p.ui, l.updated_at, p.agents, null, null, l.tasks)
  assert.ok(html.includes("const PLAN ="), "plan data embedded in page")
  // Should have plan data for the parent task row
  assert.ok(html.includes("totalEst"), "plan data includes totalEst")
  assert.ok(html.includes("createdAt"), "plan data includes createdAt")
  assert.ok(html.includes("setInterval(tickPlan, 1000)"), "client plan ticker every second")
})

test("T39: renderConsoleHtml without allTasks param still works (backward compat)", () => {
  const l = freshLedger()
  const parent = must(l, { op: "create", task: "Parent feature", est_min: 60 })
  must(l, { op: "create", task: "Child 1", parent: parent.id, est_min: 30 })
  const p = project(l)
  // Old call signature without allTasks
  const html = renderConsoleHtml(p.ui, l.updated_at, p.agents)
  assert.ok(html.includes("const PLAN ="), "plan data embedded even without allTasks")
  assert.ok(html.includes("{}"), "empty plan data when allTasks not provided")
})

test("T39: plan marker position reflects planPercent (clamped 0..100)", () => {
  const l = freshLedger()
  const parent = must(l, { op: "create", task: "Parent feature", est_min: 60 })
  must(l, { op: "create", task: "Child 1", parent: parent.id, est_min: 30 })
  must(l, { op: "create", task: "Child 2", parent: parent.id, est_min: 30 })
  // Manually set created_at in ledger to be 30 min ago → planPercent should be ~50%
  const taskInLedger = l.tasks.find((t) => t.id === parent.id)!
  taskInLedger.created_at = new Date(Date.now() - 30 * 60000).toISOString()
  const p = project(l)
  // T99: plan marker on axis line
  const parentIdx = p.ui.split("\n").findIndex((x) => x.includes("[T1]"))
  const parentAxis = p.ui.split("\n")[parentIdx + 1] || ""
  // At 50%, marker should be 3 ▏ chars (ceil(50/20)=3, out of 5)
  const markerMatch = parentAxis.match(/▏+/)
  assert.ok(markerMatch, "plan marker present")
  assert.ok(markerMatch[0].length >= 2 && markerMatch[0].length <= 3, `marker position ~50%: ${markerMatch[0].length}`)
})

// ----------------------------------------------------- T38: Phase estimation -----

test("T38: explicit est_min wins over auto-estimation (history exists but ignored)", () => {
  const l = freshLedger()
  // Create parent
  const parent = must(l, { op: "create", task: "Parent feature" })
  // Create sibling with phase "impl" and known duration
  const sibling = must(l, { op: "create", task: "Sibling impl", parent: parent.id, phase: "impl" })
  sibling.state = "DONE"
  sibling.created_at = new Date(Date.now() - 60 * 60000).toISOString() // 60 min ago
  sibling.updated_at = new Date().toISOString()
  // Create new child with explicit est_min=42 — should win over history
  const child = must(l, { op: "create", task: "New impl", parent: parent.id, phase: "impl", est_min: 42 })
  assert.equal(child.est_min, 42, "explicit est_min=42 wins over auto-estimate")
  // Verify response carries phase_est info
  const out = applyOp(l, { op: "create", task: "Another impl", parent: parent.id, phase: "impl", est_min: 15 })
  assert.ok((out as { ok: true; task: Task & { _estInfo?: string } }).task._estInfo?.includes("явно"))
})

test("T38: auto-estimate from DONE siblings with same parent+phase (mean, clamp, ≤5 latest)", () => {
  const l = freshLedger()
  const parent = must(l, { op: "create", task: "Parent feature" })
  // Create 3 DONE siblings with phase "impl" — durations: 10, 20, 30 min
  for (const mins of [10, 20, 30]) {
    const s = must(l, { op: "create", task: `Sibling ${mins}m`, parent: parent.id, phase: "impl" })
    const idx = l.tasks.findIndex(t => t.id === s.id)
    l.tasks[idx].state = "DONE"
    l.tasks[idx].created_at = new Date(Date.now() - mins * 60000).toISOString()
    l.tasks[idx].updated_at = new Date().toISOString()
  }
  // New child without explicit est_min — should get mean of last ≤5 (10+20+30)/3 = 20
  const child = must(l, { op: "create", task: "New impl", parent: parent.id, phase: "impl" })
  assert.equal(child.est_min, 20, "mean of 3 siblings: (10+20+30)/3 = 20")
  // Add 3 more (total 6) — should use last 5 (20,30,10,20,30 if added in that order)
  for (const mins of [10, 20, 30]) {
    const s = must(l, { op: "create", task: `Sibling ${mins}m v2`, parent: parent.id, phase: "impl" })
    const idx = l.tasks.findIndex(t => t.id === s.id)
    l.tasks[idx].state = "DONE"
    l.tasks[idx].created_at = new Date(Date.now() - mins * 60000).toISOString()
    l.tasks[idx].updated_at = new Date().toISOString()
  }
  // Actually let's just test that >5 records → last 5 are used
  const child2 = must(l, { op: "create", task: "New impl 2", parent: parent.id, phase: "impl" })
  // The last 5 siblings created: 20, 30, 10, 20, 30 (the 10 from first batch is pushed out)
  // Mean = (20+30+10+20+30)/5 = 22
  assert.equal(child2.est_min, 22, "mean of last 5 siblings")
})

test("T38: cross-parent fallback — history from different parent with same phase", () => {
  const l = freshLedger()
  const parent1 = must(l, { op: "create", task: "Parent 1" })
  const parent2 = must(l, { op: "create", task: "Parent 2" })
  // Create DONE sibling under parent1 with phase "review"
  const s1 = must(l, { op: "create", task: "Review 1", parent: parent1.id, phase: "review" })
  const idx1 = l.tasks.findIndex(t => t.id === s1.id)
  l.tasks[idx1].state = "DONE"
  l.tasks[idx1].created_at = new Date(Date.now() - 25 * 60000).toISOString()
  l.tasks[idx1].updated_at = new Date().toISOString()
  // Create child under parent2 with same phase "review" — no siblings under parent2
  const child = must(l, { op: "create", task: "Review 2", parent: parent2.id, phase: "review" })
  // Should fall back to cross-parent history (25 min)
  assert.equal(child.est_min, 25, "cross-parent fallback used: 25 min from parent1's review")
  // Response should indicate history source
  const out = applyOp(l, { op: "create", task: "Review 3", parent: parent2.id, phase: "review" })
  assert.ok((out as { ok: true; task: Task & { _estInfo?: string } }).task._estInfo?.includes('истории фазы'))
})

test("T38: no history anywhere → est_min = null", () => {
  const l = freshLedger()
  const parent = must(l, { op: "create", task: "Parent" })
  const child = must(l, { op: "create", task: "No history phase", parent: parent.id, phase: "test" })
  assert.equal(child.est_min, null, "no history → null")
  const out = applyOp(l, { op: "create", task: "Another no history", parent: parent.id, phase: "test" })
  assert.ok((out as { ok: true; task: Task & { _estInfo?: string } }).task._estInfo?.includes("нет истории"))
})

test("T38: planPercent — clamp 0..100, created long ago → 100, just now → 0, middle by estimates → ~50", () => {
  const l = freshLedger()
  const parent = must(l, { op: "create", task: "Parent for plan%" })
  // Parent created long ago
  parent.created_at = new Date(Date.now() - 2 * 60 * 60000).toISOString() // 2 hours ago
  // Two children with est_min summing to 60 min
  const c1 = must(l, { op: "create", task: "Child 1", parent: parent.id, phase: "impl", est_min: 30 })
  const c2 = must(l, { op: "create", task: "Child 2", parent: parent.id, phase: "impl", est_min: 30 })
  // Elapsed = 120 min, total est = 60 min → 200% → clamped to 100
  assert.equal(planPercent(parent, l.tasks), 100, "elapsed > total est → clamped to 100")
  // New parent, just created
  const parent2 = must(l, { op: "create", task: "Parent fresh" })
  const c3 = must(l, { op: "create", task: "Child 3", parent: parent2.id, phase: "impl", est_min: 30 })
  // Just created → elapsed ~0 → 0%
  assert.equal(planPercent(parent2, l.tasks), 0, "just created → 0%")
  // Middle: parent created 30 min ago, total est 60 min → 50%
  const parent3 = must(l, { op: "create", task: "Parent mid" })
  parent3.created_at = new Date(Date.now() - 30 * 60000).toISOString()
  const c4 = must(l, { op: "create", task: "Child 4", parent: parent3.id, phase: "impl", est_min: 30 })
  const c5 = must(l, { op: "create", task: "Child 5", parent: parent3.id, phase: "impl", est_min: 30 })
  assert.equal(planPercent(parent3, l.tasks), 50, "30 min elapsed / 60 min est → 50%")
  // No children with est_min → null
  const parent4 = must(l, { op: "create", task: "Parent no est" })
  assert.equal(planPercent(parent4, l.tasks), null, "no est children → null")
})

test("T38: create response carries phase_est (explicit/history)", () => {
  const l = freshLedger()
  const parent = must(l, { op: "create", task: "Parent" })
  // Explicit
  const out1 = applyOp(l, { op: "create", task: "Explicit", parent: parent.id, phase: "impl", est_min: 42 })
  assert.ok((out1 as { ok: true; task: Task & { _estInfo?: string } }).task._estInfo?.includes("явно"))
  // History (with DONE sibling)
  const sib = must(l, { op: "create", task: "Sibling", parent: parent.id, phase: "impl" })
  const sibIdx = l.tasks.findIndex(t => t.id === sib.id)
  l.tasks[sibIdx].state = "DONE"
  l.tasks[sibIdx].created_at = new Date(Date.now() - 15 * 60000).toISOString()
  l.tasks[sibIdx].updated_at = new Date().toISOString()
  const out2 = applyOp(l, { op: "create", task: "From history", parent: parent.id, phase: "impl" })
  assert.ok((out2 as { ok: true; task: Task & { _estInfo?: string } }).task._estInfo?.includes("истории фазы"))
})

// ------------------------------------------------- occupancy marker (T63) ---

test("⚡ ЗАДАЧИ: occupancy marker = agent id + state; no bound agent → free row", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "занятая задача" }) // T1 → ⚡ ЗАДАЧИ
  must(l, { op: "create", task: "свободная задача" }) // T2 → ⚡ ЗАДАЧИ
  const run = beginAgent(l, { input: { agent: "general", description: "[T1] work" }, ref: "ses_m1" })
  const fin = beginAgent(l, { input: { agent: "explore", description: "[T1] scan" }, ref: "ses_m2" })
  settleAgent(l, "completed", "ses_m2")

  const ui = project(l).ui
  // строка задачи (хедер блока), а не строка демона (в обеих встречается [T1])
  const busyHeader = ui.split("\n").find((x) => x.startsWith("  ● [T1]"))!
  const freeHeader = ui.split("\n").find((x) => x.startsWith("  ● [T2]"))!
  // T99: occupancy now on axis line (state · progress · children/ETA · occupancy)
  // Find the axis line for T1 (next non-empty line after header)
  const busyIdx = ui.split("\n").findIndex((x) => x.startsWith("  ● [T1]"))
  const busyAxis = ui.split("\n")[busyIdx + 1] || ""
  assert.ok(busyAxis.includes(`${run.id} работает`), `running agent marked on axis: ${busyAxis}`)
  assert.ok(busyAxis.includes(`${fin.id} завершил`), `settled agent marked on axis: ${busyAxis}`)
  // Free task has no occupancy on axis
  const freeIdx = ui.split("\n").findIndex((x) => x.startsWith("  ● [T2]"))
  const freeAxis = ui.split("\n")[freeIdx + 1] || ""
  assert.ok(freeHeader.includes("свободная задача") && !freeAxis.includes("🔒"), `free task axis carries no marker: ${freeAxis}`)
})

test("occupancy marker: 🔄 В РАБОТЕ row shows it too; marker reaches the pane", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "в работе" })
  must(l, { op: "set_state", id: "T1", state: "DOING", owner: "dev" })
  const a = beginAgent(l, { input: { agent: "general", description: "[T1] work" }, ref: "ses_m3" })

  const p = project(l)
  const header = p.ui.split("\n").find((x) => x.startsWith("  ● [T1]"))!
  // T99: axis line carries occupancy
  const idx = p.ui.split("\n").findIndex((x) => x.startsWith("  ● [T1]"))
  const axis = p.ui.split("\n")[idx + 1] || ""
  assert.ok(header.includes("· dev"), `owner suffix kept on header: ${header}`)
  assert.ok(axis.includes(`${a.id} работает`), `occupied axis marked: ${axis}`)
  assert.ok(!axis.includes(a.label), `axis marker = id, not the record name: ${axis}`)

  const html = renderConsoleHtml(p.ui, l.updated_at, p.agents)
  assert.ok(html.includes("🔒") && html.includes(a.id), "the occupancy marker reaches the live pane")
})

test("agent line: bar from the bound task's decomposition, ETA countdown always", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "Feature" })
  must(l, { op: "create", task: "sub", parent: "T1" })
  beginAgent(l, { input: { agent: "general", description: "[T1] work" }, ref: "ses_b1" })
  beginAgent(l, { input: { agent: "general", description: "free agent" }, ref: "ses_b2" })
  const lines = project(l).ui.split("\n").filter((x) => daemonRow(x))
  const bound = lines.find((x) => x.includes("[T1]"))!
  assert.ok(bound.includes("▱▱▱▱▱ 0/1"), `bound agent carries the task bar: ${bound}`)
  assert.ok(bound.includes("⏱30:00"), `bound agent carries the ETA countdown (T85: mm:ss): ${bound}`)
  const free = lines.find((x) => !x.includes("[T1]"))!
  assert.ok(free.includes("⏱30:00") && !free.includes("▰"), `unbound agent shows ETA mm:ss, no fake bar: ${free}`)
})

// ------------------------------------------------ queue order (T72) ---------

// id задач в порядке их строк внутри секции ⚡ ЗАДАЧИ: T99 block format.
// Header line = "  ● [Tid] ..." (root) or "    ↳ [Tid] ..." (child), axis line = "    ⏳ ..." (starts with AXIS_INDENT).
// We find task ids by looking for header lines in the section.
function queueIds(ui: string): string[] {
  const head = ui.split("\n").findIndex((x) => x.startsWith("⚡ ЗАДАЧИ"))
  assert.ok(head >= 0, "секция ⚡ ЗАДАЧИ отрисована")
  const ids: string[] = []
  for (const line of ui.split("\n").slice(head + 1)) {
    // Header lines start with TAB_INDENT + marker (2 spaces + ●) for roots,
    // or AXIS_INDENT + marker (4 spaces + ↳) for children.
    const m = /^ {2,4}[●↳] \[(T\d+)\]/.exec(line)
    if (!m) continue
    ids.push(m[1])
  }
  return ids
}

// created_at в тестах фиксируется руками: opCreate штампует now(), и задачи,
// созданные в одной миллисекунде, не имели бы порядка внутри яруса.
function stamp(l: Ledger, id: string, iso: string): void {
  const t = l.tasks.find((x) => x.id === id)
  assert.ok(t, `задача ${id} есть в леджере`)
  t.created_at = iso
}

test("⚡ ЗАДАЧИ: осмысленный порядок — горячие → начатые → свежие (T72)", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "старый нетронутый бэклог" }) // T1
  must(l, { op: "create", task: "начатая: есть DONE-дети" }) // T2
  must(l, { op: "create", task: "горячая по owner" }) // T3
  must(l, { op: "create", task: "горячая по агенту" }) // T4
  must(l, { op: "create", task: "свежая нетронутая" }) // T5
  stamp(l, "T1", "2026-10-01T09:00:00.000Z")
  stamp(l, "T2", "2026-10-02T09:00:00.000Z")
  stamp(l, "T3", "2026-10-03T09:00:00.000Z")
  stamp(l, "T4", "2026-10-04T09:00:00.000Z")
  stamp(l, "T5", "2026-10-07T09:00:00.000Z")
  must(l, { op: "create", task: "закрытый шаг", parent: "T2" }) // T6 → DONE
  must(l, { op: "set_state", id: "T6", state: "DONE", verification: "v" })
  must(l, { op: "update", id: "T3", owner: "dev" })
  beginAgent(l, { input: { agent: "general", description: "[T4] work" }, ref: "ses_t72" })

  const ids = queueIds(project(l).ui)
  // (а) T3/T4 — owner или занятый агент, внутри яруса created_at asc;
  // (б) T2 — DONE-ребёнок есть, owner/агента нет; (в) T5 свежее T1 → сверху.
  assert.deepEqual(ids, ["T3", "T4", "T2", "T5", "T1"], "ярусы сверху вниз, ничего из WAIT не потеряно")
  assert.deepEqual([...ids].sort(), ["T1", "T2", "T3", "T4", "T5"], "все WAIT-задачи остались в списке")
  assert.ok(!ids.includes("T6"), "DONE-дети в очередь не попадают")
})

test("⚡ ЗАДАЧИ: родитель ● и WAIT-дети ↳ одной группой, дети сразу за родителем по id (T72)", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "родитель" }) // T1
  must(l, { op: "create", task: "дитя два", parent: "T1" }) // T2
  must(l, { op: "create", task: "корневая соседка" }) // T3
  must(l, { op: "create", task: "дитя один", parent: "T1" }) // T4
  must(l, { op: "create", task: "закрытое дитя", parent: "T1" }) // T5 → DONE
  must(l, { op: "set_state", id: "T5", state: "DONE", verification: "v" })
  // ребёнок с owner не вырывается в свой ярус — он остаётся в группе родителя
  must(l, { op: "update", id: "T2", owner: "dev" })
  stamp(l, "T1", "2026-10-02T09:00:00.000Z")
  stamp(l, "T2", "2026-10-07T09:00:00.000Z")
  stamp(l, "T3", "2026-10-05T09:00:00.000Z")
  stamp(l, "T4", "2026-10-06T09:00:00.000Z")

  // у T1 есть DONE-ребёнок → ярус «начатые» (раньше нетронутой T3);
  // дети идут сразу за родителем в порядке id, DONE-ребёнок T5 не показан.
  assert.deepEqual(queueIds(project(l).ui), ["T1", "T2", "T4", "T3"])
})

test("⚡ ЗАДАЧИ: нетронутые — свежие сверху, старый бэклог внизу; ярус пересчитывается на рендер (T72)", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "древний бэклог 1" }) // T1
  must(l, { op: "create", task: "древний бэклог 2" }) // T2
  must(l, { op: "create", task: "свежая задача" }) // T3
  stamp(l, "T1", "2026-10-01T09:00:00.000Z")
  stamp(l, "T2", "2026-10-02T09:00:00.000Z")
  stamp(l, "T3", "2026-10-07T09:00:00.000Z")
  assert.deepEqual(
    queueIds(project(l).ui),
    ["T3", "T2", "T1"],
    "среди нетронутых свежие сверху (created_at desc), старый бэклог уходит вниз",
  )

  // Взята задача из глубины бэклога → на следующем рендере она в «горячих»:
  // порядок ярусов пересчитан на каждый рендер, дедуп не нужен (проекция чистая).
  must(l, { op: "update", id: "T1", owner: "dev" })
  assert.deepEqual(queueIds(project(l).ui), ["T1", "T3", "T2"], "горячие пересчитываются на каждый рендер")
})

// --------------------------------------------------------- T43: drag-priority -----

test("T43: queueOrder respects priority — tasks with priority go first within tier", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "low priority" }) // T1
  must(l, { op: "create", task: "high priority" }) // T2
  must(l, { op: "create", task: "medium priority" }) // T3
  stamp(l, "T1", "2026-10-01T09:00:00.000Z")
  stamp(l, "T2", "2026-10-02T09:00:00.000Z")
  stamp(l, "T3", "2026-10-03T09:00:00.000Z")
  // Set priorities: T2=1 (highest), T3=2, T1=none
  l.tasks.find((t) => t.id === "T2")!.priority = 1
  l.tasks.find((t) => t.id === "T3")!.priority = 2
  // All are "untouched" (no owner, no agent, no DONE children) → tier (в), sorted by priority desc (lower number first), then created_at desc
  // With priority: T2(1), T3(2), then T1(no priority, newest first among no-priority)
  const ids = queueIds(project(l).ui)
  assert.deepEqual(ids, ["T2", "T3", "T1"], "priority overrides created_at within no-priority group")
})

test("T43: queueOrder — priority works within hot tier (owner/agent)", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "hot no priority" }) // T1
  must(l, { op: "create", task: "hot with priority 2" }) // T2
  must(l, { op: "create", task: "hot with priority 1" }) // T3
  stamp(l, "T1", "2026-10-01T09:00:00.000Z")
  stamp(l, "T2", "2026-10-02T09:00:00.000Z")
  stamp(l, "T3", "2026-10-03T09:00:00.000Z")
  must(l, { op: "update", id: "T1", owner: "dev" })
  must(l, { op: "update", id: "T2", owner: "dev" })
  must(l, { op: "update", id: "T3", owner: "dev" })
  l.tasks.find((t) => t.id === "T2")!.priority = 2
  l.tasks.find((t) => t.id === "T3")!.priority = 1
  // Hot tier: sorted by priority asc, then created_at asc
  const ids = queueIds(project(l).ui)
  assert.deepEqual(ids, ["T3", "T2", "T1"], "hot tier: priority asc, then created_at asc")
})

test("T43: DOING section also respects priority", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "doing low" }) // T1
  must(l, { op: "create", task: "doing high" }) // T2
  must(l, { op: "set_state", id: "T1", state: "DOING" })
  must(l, { op: "set_state", id: "T2", state: "DOING" })
  l.tasks.find((t) => t.id === "T2")!.priority = 1
  l.tasks.find((t) => t.id === "T1")!.priority = 2
  const ui = project(l).ui
  // T99: DOING section has block format - header lines start with "  ● [T]"
  // Find DOING section - goes until next section header (line starting with section marker)
  const doingStart = ui.indexOf("🔄 В РАБОТЕ")
  // Find next section header (line starting with emoji marker at column 0)
  const afterDoing = ui.slice(doingStart + 1)
  const nextSectionMatch = afterDoing.match(/\n[🔄⚡⛔🔔🤖💬🌍]/)
  const nextSectionOffset = nextSectionMatch ? nextSectionMatch.index + doingStart + 1 : -1
  const doingSection = nextSectionOffset >= 0 ? ui.slice(doingStart, nextSectionOffset) : ui.slice(doingStart)
  // Find header lines in the DOING section
  const lines = doingSection.split("\n").slice(1) // skip "🔄 В РАБОТЕ"
  const headers = lines.filter((x) => /^ {2}[●↳] \[T\d+\]/.test(x))
  assert.ok(headers.length >= 2, `both DOING tasks rendered (found ${headers.length}): ${headers.join(" | ")}`)
  // T2 (priority 1) should come before T1 (priority 2)
  const t1Idx = headers.findIndex((x) => x.includes("[T1]"))
  const t2Idx = headers.findIndex((x) => x.includes("[T2]"))
  assert.ok(t2Idx < t1Idx, `T2 (priority 1) before T1 (priority 2) in DOING: T2@${t2Idx} T1@${t1Idx}`)
})

test("T43: backcompat — old ledger without priority field loads and renders as before", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-t43-"))
  const file = join(dir, "state.json")
  try {
    // Write a ledger without priority field (pre-T43 format)
    writeFileSync(file, JSON.stringify({
      version: 1,
      updated_at: new Date().toISOString(),
      tasks: [
        { id: "T1", task: "Old task", state: "WAIT", owner: null, parent: null, why: null, verification: null, created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z" },
        { id: "T2", task: "Old task 2", state: "WAIT", owner: null, parent: null, why: null, verification: null, created_at: "2026-10-02T00:00:00.000Z", updated_at: "2026-10-02T00:00:00.000Z" },
      ],
      agents: [], tabs: [], models: []
    }), "utf8")
    const led = loadLedger(file)
    assert.equal(led.tasks.length, 2)
    assert.equal(led.tasks[0].priority, undefined, "old tasks have no priority field")
    assert.equal(led.tasks[1].priority, undefined)
    // Render should work without crash
    const ui = project(led).ui
    assert.ok(ui.includes("[T1]") && ui.includes("[T2]"), "old tasks render correctly")
    // Order should be by created_at desc (newer first for untouched)
    const ids = queueIds(ui)
    assert.deepEqual(ids, ["T2", "T1"], "backcompat: created_at desc for untouched tasks")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("T43: priority field not written to ledger when null (backcompat save)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-t43-save-"))
  const file = join(dir, "state.json")
  try {
    const l = freshLedger()
    must(l, { op: "create", task: "No priority" }) // T1
    saveLedger(file, l)
    const content = readFileSync(file, "utf8")
    const parsed = JSON.parse(content)
    // priority should not be in the saved JSON (or be absent/undefined)
    assert.ok(!("priority" in parsed.tasks[0]) || parsed.tasks[0].priority === null, "priority not serialized when null/undefined")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("T43: приоритет детей (фаз) применяется в очереди; без приоритетов — прежний порядок по id", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "Родитель-фазы" }) // T1
  must(l, { op: "create", task: "Фаза А", parent: "T1" }) // T2
  must(l, { op: "create", task: "Фаза Б", parent: "T1" }) // T3
  const kidIds = (ui: string): string[] =>
    ui
      .split("\n")
      .filter((line) => line.includes("↳ [T"))
      .map((line) => (line.match(/\[(T\d+)\]/) || [])[1] || "")
  assert.deepEqual(kidIds(project(l).ui), ["T2", "T3"], "бэккомпат: без приоритетов дети идут по id")
  // Драг фазы: Т3 подняли выше Т2
  l.tasks.find((t) => t.id === "T3")!.priority = 1
  l.tasks.find((t) => t.id === "T2")!.priority = 2
  assert.deepEqual(kidIds(project(l).ui), ["T3", "T2"], "priority детей применяется в рендере очереди")
})

test("T43: генерация страницы — слэши шаблона целы, drag включается после проба", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "Задача для regex-прогона" })
  const html = renderConsoleHtml(project(l).ui, l.updated_at, l.agents)
  const codeLine = (needle: string): string => html.split(/\r?\n/).find((line) => line.includes(needle)) || ""
  // 1) Одиночные слэши внутри template literal съедаются IdentityEscape —
  //    страница получала убитый вид regex'а (случай A68/T43: s+[(Td+)]).
  const taskLine = codeLine("taskMatch = raw.match")
  assert.ok(taskLine.includes("/^[●↳]\\s+\\[(T\\d+)\\]/"), "taskMatch regex цел в HTML: " + taskLine.trim())
  const planLine = codeLine("html.replace(/⏱")
  assert.ok(planLine.includes("/⏱\\d+м/"), "tickPlan ⏱-ярлык regex цел: " + planLine.trim())
  const agoLine = codeLine("exec(d.textContent)")
  assert.ok(agoLine.includes("(\\d{1,2}:\\d{2})\\s*$"), "initAgo regex цел: " + agoLine.trim())
  // 2) Порядок с пройом: сборка кандидатов при рендере + включение в .then проба
  //    (синхронная сборка видит channelAlive=false — гейт на месте был мёртв)
  assert.ok(codeLine("pendingT43.push(function () {") !== "", "усиление строк копится в pendingT43")
  assert.ok(codeLine("pendingT43.forEach(function (fn) { fn(); });") !== "", "drag включается в .then проба")
  assert.ok(!html.includes("if (taskMatch && channelAlive)"), "синхронный гейт при сборке убран")
})

test("T43: 🔒 В РАБОТЕ — иерархия: ребёнок с приоритетом остаётся под родителем", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "Родитель работает" }) // T1
  must(l, { op: "set_state", id: "T1", state: "DOING" })
  must(l, { op: "create", task: "Дитя работает", parent: "T1" }) // T2
  must(l, { op: "set_state", id: "T2", state: "DOING" })
  must(l, { op: "create", task: "Другой корень" }) // T3
  must(l, { op: "set_state", id: "T3", state: "DOING" })
  // драг поднял ребёнка (priority 1) и чужой корень (priority 1):
  // без фикса плоской сортировки T2 уехал бы выше T1 («↳» перед «●»)
  l.tasks.find((t) => t.id === "T2")!.priority = 1
  l.tasks.find((t) => t.id === "T3")!.priority = 1
  const ui = project(l).ui
  const i1 = ui.indexOf("[T1]")
  const i2 = ui.indexOf("[T2]")
  const i3 = ui.indexOf("[T3]")
  assert.ok(i1 >= 0 && i2 >= 0 && i3 >= 0, "все три строки в рендере")
  assert.ok(i3 < i1, `корень с приоритетом выше корня без: T3@${i3} < T1@${i1}`)
  assert.ok(i1 < i2, `ребёнок остаётся под родителем: T1@${i1} < T2@${i2}`)
})

// ------------------------------------------------------------------ ETA -----

test("learnEta: default without history; mean of finished same-kind; failed runs ignored", () => {
  const l = freshLedger()
  assert.equal(learnEta(l.agents, "qc"), 30, "no history → default plan")

  const mk = (label: string, state: "completed" | "failed", mins: number): void => {
    const began = Date.now() - mins * 60000
    l.agents.push({
      id: `A${l.agents.length + 1}`,
      task_id: null,
      label,
      kind: null, // до-T64 запись: вид читается из label (labelKind)
      state,
      session_ref: null,
      home: null,
      emoji: null,
      began_at: new Date(began).toISOString(),
      eta_min: 30,
      updated_at: new Date().toISOString(),
    })
  }
  mk("qc-1", "completed", 10)
  mk("qc-2", "completed", 20)
  mk("qc-3", "failed", 120) // failed loop must not poison the plan
  mk("dev-1", "completed", 40) // другой тип — своя история
  assert.equal(learnEta(l.agents, "qc"), 15, "mean of finished same-kind runs")
  assert.equal(learnEta(l.agents, "dev"), 40)
  assert.equal(learnEta(l.agents, "general"), 30, "kind without history → default")
})

test("T82: modelSpeedFactor — median(actual/plan) over closed agents with plan; <3 obs → 1", () => {
  const l = freshLedger()
  const model = "nemotron-3-ultra"
  // <3 observations → 1.0
  assert.equal(modelSpeedFactor(l.agents, model), 1.0, "no agents → 1.0")
  l.agents.push({ id: "A1", task_id: null, label: "x", kind: "general", state: "completed", session_ref: null, home: null, model, emoji: null, began_at: new Date(Date.now() - 30*60000).toISOString(), eta_min: 30, updated_at: new Date().toISOString() })
  assert.equal(modelSpeedFactor(l.agents, model), 1.0, "1 obs → 1.0")
  l.agents.push({ id: "A2", task_id: null, label: "x", kind: "general", state: "completed", session_ref: null, home: null, model, emoji: null, began_at: new Date(Date.now() - 60*60000).toISOString(), eta_min: 30, updated_at: new Date().toISOString() })
  assert.equal(modelSpeedFactor(l.agents, model), 1.0, "2 obs → 1.0")

  // 3+ observations: median of actual/plan
  // A1: actual=30, plan=30 → ratio=1.0
  // A2: actual=60, plan=30 → ratio=2.0
  // Add A3: actual=45, plan=30 → ratio=1.5
  l.agents.push({ id: "A3", task_id: null, label: "x", kind: "general", state: "completed", session_ref: null, home: null, model, emoji: null, began_at: new Date(Date.now() - 45*60000).toISOString(), eta_min: 30, updated_at: new Date().toISOString() })
  // Sorted ratios: [1.0, 1.5, 2.0] → median = 1.5
  // ФЛАП-фикс: actual считается от Date.now() — миллисекундный дрейф даёт
  // 1.5000001; точное assert.equal периодически роняло тест (12.11).
  const med = (v: number): number => modelSpeedFactor(l.agents, model)
  const approx = (a: number, b: number): boolean => Math.abs(a - b) < 0.002
  assert.ok(approx(med(0), 1.5), `3 obs → median 1.5 (got ${med(0)})`)

  // Add A4: actual=15, plan=30 → ratio=0.5
  // Sorted: [0.5, 1.0, 1.5, 2.0] → median = (1.0 + 1.5) / 2 = 1.25
  l.agents.push({ id: "A4", task_id: null, label: "x", kind: "general", state: "completed", session_ref: null, home: null, model, emoji: null, began_at: new Date(Date.now() - 15*60000).toISOString(), eta_min: 30, updated_at: new Date().toISOString() })
  assert.ok(approx(med(0), 1.25), `4 obs → median 1.25 (got ${med(0)})`)

  // Different model → separate coefficient
  assert.equal(modelSpeedFactor(l.agents, "mimo-v2.6-flash"), 1.0, "other model → 1.0")

  // Only completed agents count (running/waiting/failed ignored)
  l.agents.push({ id: "A5", task_id: null, label: "x", kind: "general", state: "running", session_ref: null, home: null, model, emoji: null, began_at: new Date().toISOString(), eta_min: 30, updated_at: new Date().toISOString() })
  assert.ok(approx(med(0), 1.25), `running agent ignored (got ${med(0)})`)

  // Agents without plan (eta_min <= 0) ignored
  l.agents.push({ id: "A6", task_id: null, label: "x", kind: "general", state: "completed", session_ref: null, home: null, model, emoji: null, began_at: new Date(Date.now() - 20*60000).toISOString(), eta_min: 0, updated_at: new Date().toISOString() })
  assert.ok(approx(med(0), 1.25), `agent without plan ignored (got ${med(0)})`)

  // Negative/zero actual duration clamped (ignored)
  l.agents.push({ id: "A7", task_id: null, label: "x", kind: "general", state: "completed", session_ref: null, home: null, model, emoji: null, began_at: new Date(Date.now()).toISOString(), eta_min: 30, updated_at: new Date(Date.now() - 1000).toISOString() }) // negative actual
  assert.ok(approx(med(0), 1.25), `negative duration ignored (got ${med(0)})`)

  // Missing began_at or updated_at → ignored
  l.agents.push({ id: "A8", task_id: null, label: "x", kind: "general", state: "completed", session_ref: null, home: null, model, emoji: null, began_at: "", eta_min: 30, updated_at: new Date().toISOString() })
  assert.ok(approx(med(0), 1.25), `missing began_at ignored (got ${med(0)})`)
})

test("T82: learnEta scales base estimate by modelSpeedFactor(model)", () => {
  const l = freshLedger()
  const model = "nemotron-3-ultra"
  // No history → default
  assert.equal(learnEta(l.agents, "general", model), 30, "no history → default 30")

  // Add completed agents with known ratios to establish model speed factor
  // A1: actual=30, plan=30 → ratio=1.0
  l.agents.push({ id: "A1", task_id: null, label: "general-1", kind: "general", state: "completed", session_ref: null, home: null, model, emoji: null, began_at: new Date(Date.now() - 30*60000).toISOString(), eta_min: 30, updated_at: new Date().toISOString() })
  // A2: actual=60, plan=30 → ratio=2.0
  l.agents.push({ id: "A2", task_id: null, label: "general-2", kind: "general", state: "completed", session_ref: null, home: null, model, emoji: null, began_at: new Date(Date.now() - 60*60000).toISOString(), eta_min: 30, updated_at: new Date().toISOString() })
  // A3: actual=45, plan=30 → ratio=1.5
  l.agents.push({ id: "A3", task_id: null, label: "general-3", kind: "general", state: "completed", session_ref: null, home: null, model, emoji: null, began_at: new Date(Date.now() - 45*60000).toISOString(), eta_min: 30, updated_at: new Date().toISOString() })
  // modelSpeedFactor = median([1.0, 1.5, 2.0]) = 1.5

  // Base mean of same-kind = (30+60+45)/3 = 45 min
  // With model factor 1.5 → 45 * 1.5 = 67.5 → 68 (rounded)
  assert.equal(learnEta(l.agents, "general", model), 68, "base 45 * k=1.5 = 68")

  // Without model → base only
  assert.equal(learnEta(l.agents, "general", null), 45, "no model → base only")

  // Different model → 1.0 factor
  assert.equal(learnEta(l.agents, "general", "mimo-v2.6-flash"), 45, "other model → 1.0 factor")

  // Clamped to [5, 120]
  // Make factor huge: add agents with high ratios
  for (let i = 4; i <= 10; i++) {
    l.agents.push({ id: `A${i}`, task_id: null, label: `general-${i}`, kind: "general", state: "completed", session_ref: null, home: null, model, emoji: null, began_at: new Date(Date.now() - 300*60000).toISOString(), eta_min: 30, updated_at: new Date().toISOString() })
  }
  // ratios now include many 10.0 → median will be high
  const eta = learnEta(l.agents, "general", model)
  assert.ok(eta <= 120, `clamped to max 120: ${eta}`)
})

test("T82: beginAgent stamps began_at + eta plan learned from finished same-kind runs (with model)", () => {
  const l = freshLedger()
  const a1 = beginAgent(l, { input: { agent: "qc", description: "[T1] check" }, ref: "ses_q1", model: "nemotron-3-ultra" })
  assert.equal(a1.eta_min, 30, "first of kind → default plan")
  assert.ok(a1.began_at, "ETA baseline stamped at begin")

  a1.state = "completed"
  a1.updated_at = new Date(Date.parse(a1.began_at) + 6 * 60000).toISOString()
  const a2 = beginAgent(l, { input: { agent: "qc", description: "[T2] check" }, ref: "ses_q2", model: "nemotron-3-ultra" })
  // Base mean = 6 min, but modelSpeedFactor <3 obs → 1.0, so plan = 6
  assert.equal(a2.eta_min, 6, "next plan = actual duration of the finished run (self-learning in the tool)")
})

test("T48: planEtaForTask — est_min задачи главнее истории, clamp 5..480, без est — learnEta", () => {
  const l = freshLedger()
  // Явная оценка — осмысленный план: не learnEta (тут default 30), не история
  assert.equal(planEtaForTask(90, l.agents, "general", null), 90, "explicit est_min = plan")
  // Крупная dev-задача > старого потолка learnEta (120) не срезается
  assert.equal(planEtaForTask(300, l.agents, "general", null), 300, "большая dev-задача живёт выше 120")
  assert.equal(planEtaForTask(1000, l.agents, "general", null), 480, "верхний clamp 480")
  assert.equal(planEtaForTask(1, l.agents, "general", null), 5, "нижний clamp 5")
  // Нет/нулевая/мусорная оценка → learnEta по виду (default 30)
  assert.equal(planEtaForTask(null, l.agents, "general", null), 30, "null → learnEta")
  assert.equal(planEtaForTask(0, l.agents, "general", null), 30, "0 → learnEta")
  assert.equal(planEtaForTask(undefined, l.agents, "general", null), 30, "undefined → learnEta")
  // Коэффициент модели на явную оценку НЕ накладывается (оценка Foundera — не история)
  const model = "nemotron-3-ultra"
  for (let i = 1; i <= 3; i++) {
    l.agents.push({ id: `A${i}`, task_id: null, label: `general-${i}`, kind: "general", state: "completed", session_ref: null, home: null, model, emoji: null, began_at: new Date(Date.now() - 60 * 60000).toISOString(), eta_min: 30, updated_at: new Date().toISOString() })
  } // k(model) = median([2,2,2]) = 2.0
  assert.ok(modelSpeedFactor(l.agents, model) > 1.5, "проверка: модель действительно медленная")
  assert.equal(planEtaForTask(45, l.agents, "general", model), 45, "explicit est_min не умножается на k(model)")
})

test("T48: beginAgent берёт est_min привязанной задачи как план-ETA; без est — learnEta", () => {
  const l = freshLedger()
  applyOp(l, { op: "create", task: "крупная dev-задача", est_min: 90 })
  const t = l.tasks[0]
  const a = beginAgent(l, { input: { agent: "general", description: `[${t.id}] implement` }, ref: "ses_t48" })
  assert.equal(a.task_id, t.id, "спавн привязан к задаче")
  assert.equal(a.eta_min, 90, "план спавна = est_min задачи (осмысленный план-ETA), а не default 30")
  // Задача без est_min → прежний путь learnEta
  applyOp(l, { op: "create", task: "мелкая" })
  const t2 = l.tasks[1]
  const a2 = beginAgent(l, { input: { agent: "general", description: `[${t2.id}] fix` }, ref: "ses_t48b" })
  assert.equal(a2.eta_min, 30, "без est_min — learnEta (default), история вида не изменилась")
})

test("remaining: countdown to the plan; overdue shows +N", () => {
  const l = freshLedger()
  beginAgent(l, { input: { agent: "general", description: "x" }, ref: "ses_r" })
  const freshLine = project(l).ui.split("\n").find((x) => daemonRow(x))!
  assert.ok(freshLine.includes("⏱30:00"), `fresh agent: full plan ahead (T85: mm:ss): ${freshLine}`)

  l.agents[0].began_at = new Date(Date.now() - 31 * 60000).toISOString()
  l.agents[0].eta_min = 30
  const over = project(l).ui.split("\n").find((x) => daemonRow(x))!
  assert.match(over, /⏱\+01:0\d/, `overdue plan renders +mm:ss (граница секунды двигается): ${over}`)
})

// ------------------------------------------- tabs / attribution (T34) -------

test("create marks the task with its own session (session_ref); blank → null", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "work owned by a tab", session_ref: "ses_tab1" })
  assert.equal(l.tasks[0].session_ref, "ses_tab1", "create attributes the task to the calling session")

  must(l, { op: "create", task: "no session known" })
  assert.equal(l.tasks[1].session_ref, null)

  must(l, { op: "create", task: "blank session ignored", session_ref: "   " })
  assert.equal(l.tasks[2].session_ref, null, "a blank attribution is not kept")

  must(l, { op: "set_state", id: "T1", state: "DOING" })
  must(l, { op: "update", id: "T1", owner: "dev" })
  assert.equal(l.tasks[0].session_ref, "ses_tab1", "transitions and edits never rewrite attribution")
})

test("upsertTab: first sighting creates; later calls refresh without clobbering known values", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_a", title: "Tab A", model: "mimo-v2.6-flash", last_seen: "2026-10-07T10:00:00.000Z" })
  assert.equal(l.tabs.length, 1, "record born on the first sighting")
  assert.equal(l.tabs[0].title, "Tab A")
  assert.equal(l.tabs[0].model, "mimo-v2.6-flash")
  assert.equal(l.tabs[0].last_seen, "2026-10-07T10:00:00.000Z")

  // Пустое наблюдение не затирает известное; устаревшее не откатывает время.
  upsertTab(l, { session_id: "ses_a", title: "", model: null, last_seen: "2026-10-07T09:00:00.000Z" })
  assert.equal(l.tabs.length, 1, "no duplicate record")
  assert.equal(l.tabs[0].title, "Tab A", "an empty title never clobbers a known one")
  assert.equal(l.tabs[0].model, "mimo-v2.6-flash", "a null model never clobbers a known one")
  assert.equal(l.tabs[0].last_seen, "2026-10-07T10:00:00.000Z", "last_seen is monotonic")

  // Свежий вызов модели двигает last_seen и уточняет title/model.
  upsertTab(l, {
    session_id: "ses_a",
    title: "Tab A v2",
    model: "nemotron-3-ultra",
    last_seen: "2026-10-07T11:00:00.000Z",
  })
  assert.deepEqual(
    { title: l.tabs[0].title, model: l.tabs[0].model, last_seen: l.tabs[0].last_seen },
    { title: "Tab A v2", model: "nemotron-3-ultra", last_seen: "2026-10-07T11:00:00.000Z" },
  )

  assert.throws(() => upsertTab(l, { session_id: "" }), /session_id/)
})

test("T91: syncTabTitle — запись таба из каноничного титула сессии, last_seen не двигается", () => {
  const l = freshLedger()
  upsertTab(l, {
    session_id: "ses_t91",
    title: "Статус · Маруська Гольденштерн · Маруська Гольденштерн",
    last_seen: "2026-10-07T15:57:00.000Z",
  })
  const tab = l.tabs[0]

  // upsert-пересборка: старый двойной хвост → канон «Персона · Тема»
  assert.equal(tab.title, "Маруська Гольденштерн · Статус", "upsert пересобрал порядок имён: Персона впереди")
  assert.equal(tab.last_seen, "2026-10-07T15:57:00.000Z")

  // syncTabTitle с тем же каноном — совпадение, нечего менять
  assert.equal(syncTabTitle(tab, "Статус · Маруська Гольденштерн"), false, "совпадение — нечего менять")
  assert.equal(tab.title, "Маруська Гольденштерн · Статус")
  assert.equal(tab.last_seen, "2026-10-07T15:57:00.000Z", "титул ≠ активность: last_seen не двигается")

  // Идемпотентно; пустой/неизвестный источник запись не выдумывает и не затирает.
  assert.equal(syncTabTitle(tab, "   "), false, "пустой источник не затирает запись")
  assert.equal(syncTabTitle(tab, null), false)
  assert.equal(syncTabTitle(tab, undefined), false)
  assert.equal(tab.title, "Маруська Гольденштерн · Статус")

  // Обрезка пробелов — на входе, в записи всегда чистый титул.
  assert.equal(syncTabTitle(tab, "  Новая тема · Маруська Гольденштерн  "), true)
  assert.equal(tab.title, "Маруська Гольденштерн · Новая тема")
})

test("T152-инцидент: syncTabTitle усыновляет эмодзи из канона титула (палетные токены сильнее поля)", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_e1", title: "Статус «В РАБОТЕ»", last_seen: "2026-11-12T01:00:00Z" })
  const tab = l.tabs[0]
  tab.emoji = "🧚" // пересборка реестра оставила чужую «девочку»
  assert.equal(syncTabTitle(tab, "🧝 Статус «В РАБОТЕ» · Маруська Гольденштерн"), true, "статус пересобран, эмодзи усыновлён")
  assert.equal(tab.emoji, "🧝", "эмодзи-поле следует за титулом — таргет PATCH-а не соберётся с чужим портретом")
  assert.equal(tab.title, "Маруська Гольденштерн · Статус «В РАБОТЕ»")
  assert.equal(syncTabTitle(tab, "🧝 Статус «В РАБОТЕ» · Маруська Гольденштерн"), false, "совпадение — менять нечего")
  const b = { title: "тема · Маруська Гольденштерн", emoji: "🧝" as string | null }
  assert.equal(syncTabTitle(b, "⚡ тема · Маруська Гольденштерн"), true, "титул с глифом мигалки меняется")
  assert.equal(b.emoji, "🧝", "⚡ не из палитры инстансов — поле НЕ усыновляет глиф мигалки")
  assert.equal(b.title, "Маруська Гольденштерн · тема", "мигание и декор не хранятся в titel записи")
})

test("projectTabs: tasks by creating session, agents by task tab else spawn tab, newest first", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_old", title: "Old tab", last_seen: "2026-10-07T10:00:00.000Z" })
  upsertTab(l, { session_id: "ses_new", title: "New tab", model: "nemotron-3-ultra", last_seen: "2026-10-07T12:00:00.000Z" })
  must(l, { op: "create", task: "owned by new tab", session_ref: "ses_new" }) // T1
  must(l, { op: "create", task: "owned by old tab", session_ref: "ses_old" }) // T2

  const bound = beginAgent(l, { input: { agent: "general", description: "[T1] work" }, ref: "ses_c1", home: "ses_old" })
  const free = beginAgent(l, { input: { agent: "explore", description: "untagged" }, ref: "ses_c2", home: "ses_old" })
  const orphan = beginAgent(l, { input: { agent: "general", description: "no home" }, ref: "ses_c3" })

  const views = projectTabs(l)
  assert.deepEqual(views.map((v) => v.session_id), ["ses_new", "ses_old"], "live tab first (last_seen desc)")
  const nw = views[0]
  const old = views[1]
  assert.equal(nw.title, "New tab", "title = имя вкладки")
  assert.equal(nw.model, "nemotron-3-ultra")
  assert.equal(typeof nw.last_seen, "string")
  assert.deepEqual(nw.tasks, ["T1"], "задачи вкладки = созданные ею")
  assert.deepEqual(nw.agents, [bound.id], "the task's tab wins over the agent's spawn tab")
  assert.deepEqual(old.tasks, ["T2"])
  assert.deepEqual(old.agents, [free.id], "an unbound agent follows its spawn tab")
  assert.ok(!views.some((v) => v.agents.includes(orphan.id)), "an agent without attribution belongs to no tab")
})

test("isExecutorSession: a top session carrying an agent record is an executor, never a tab", () => {
  const l = freshLedger()
  const a = beginAgent(l, { input: { agent: "general", description: "[T1] run" }, ref: "ses_exec" })
  assert.equal(isExecutorSession(l, "ses_exec"), true, "dispatcher executor excluded from the tab registry")
  assert.equal(isExecutorSession(l, a.session_ref!), true)
  assert.equal(isExecutorSession(l, "ses_tab"), false, "an unseen session is not an executor")
})

test("tabs persist: round trip; a legacy state.json loads with empty registry and no attribution", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-"))
  const file = join(dir, "DEVATA", "state.json")
  try {
    const l = freshLedger()
    upsertTab(l, { session_id: "ses_p", title: "Pane tab", model: "mimo", last_seen: "2026-10-07T10:00:00.000Z" })
    must(l, { op: "create", task: "attributed", session_ref: "ses_p" })
    saveLedger(file, l)

    const back = loadLedger(file)
    assert.deepEqual(back.tabs, l.tabs, "the tab registry survives a restart")
    assert.equal(back.tasks[0].session_ref, "ses_p")

    writeFileSync(file, JSON.stringify({ version: 1, tasks: [{ id: "T1", state: "WAIT", task: "x" }], agents: [] }), "utf8")
    const legacy = loadLedger(file)
    assert.deepEqual(legacy.tabs, [], "a file written before tabs → empty registry")
    assert.equal(legacy.tasks[0].session_ref, null, "a task written before attribution")

    writeFileSync(file, JSON.stringify({ version: 1, tasks: [], agents: [], tabs: "nope" }), "utf8")
    assert.deepEqual(loadLedger(file).tabs, [], "a corrupt tabs array must not block the ledger")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --------------------------------------------- tabs section in ui (T35) ------

test("ИНСТАНСЫ: строка инстанса — имя · модель · бар DONE/всего её задач · контакт (T69)", () => {
  const l = freshLedger()
  assert.ok(!project(l).ui.includes("🤖 ИНСТАНСЫ"), "empty registry → the section is not rendered")

  upsertTab(l, {
    session_id: "ses_live",
    title: "Динамические имена вкладок",
    model: "mimo-v2.6-flash",
    last_seen: new Date(Date.now() - 30_000).toISOString(), // свежий контакт
  })
  upsertTab(l, {
    session_id: "ses_idle",
    title: "Простаивающая вкладка",
    model: null,
    last_seen: new Date(Date.now() - 10 * 60_000).toISOString(), // старше порога
  })
  must(l, { op: "create", task: "живая работа вкладки", session_ref: "ses_live" })
  must(l, { op: "set_state", id: "T1", state: "DOING" })
  must(l, { op: "create", task: "закрытая задача", session_ref: "ses_live" })
  must(l, { op: "set_state", id: "T2", state: "DONE", verification: "v" })
  const busy = beginAgent(l, { input: { agent: "general", description: "[T1] work" }, ref: "ses_x1", home: "ses_live" })
  const done = beginAgent(l, { input: { agent: "general", description: "old" }, ref: "ses_x2", home: "ses_live" })
  settleAgent(l, "completed", "ses_x2")

  const ui = project(l).ui
  for (const line of ui.split("\n")) {
    assert.ok(line.length <= 360, `ui line too long (${line.length}): ${line.slice(0, 50)}…`)
  }
  assert.ok(ui.includes("🤖 ИНСТАНСЫ"), "section header rendered")
  assert.ok(!ui.includes("📂"), "старый глиф 📂 убран (T162): демоны вложены строками, не меткой")
  const lines = ui.split("\n")
  // T83: строка инстанса = блок из 2-3 строк-осей с одинаковым отступом;
  // идентичностей (первая строка блока) — по одной на вкладку.
  const identities = lines.filter((x) => identityRow(x))
  assert.equal(identities.length, 2, "one identity row per registered tab")

  const liveIdx = identityOf(ui, "Динамические имена вкладок")
  const liveBlock = instanceBlock(lines, liveIdx)
  assert.equal(liveBlock.length, 3, "короткий список задач → голова + ось-1 (кто·чем·как) + ось-2 (дело), T156")
  for (const row of liveBlock.slice(1)) {
    assert.ok(row.startsWith("    ") && !row.startsWith("      "), `ось блока = отступ 4 под головой 2 (T89): ${row}`)
  }
  assert.ok(liveBlock[0].startsWith("  ") && !liveBlock[0].startsWith("    "), `голова блока = отступ 2: ${liveBlock[0]}`)
  assert.ok(liveBlock[0].includes("Динамические имена вкладок"), `ось 1 = идентичность: ${liveBlock[0]}`)
  assert.ok(!liveBlock[0].includes("mimo-v2.6-flash"), "голова несёт только имя — параметры в осях")
  const live = liveBlock.join("\n")
  const who = liveBlock[1] // ось-1 КТО·ЧЕМ·МЕРИЛО·ВРЕМЯ·КАК (T157)
  const work = liveBlock[2] // ось-2 ДЕЛО
  assert.ok(who.includes("mimo-v2.6-flash"), `model on оси-1: ${who}`)
  assert.ok(work.includes("[T1]"), `active task on оси-2: ${work}`)
  assert.ok(who.includes("▰▰▱▱▱ 1/2"), `bar on оси-1: ${who}`)
  assert.ok(!work.includes("[T2]"), `a DONE task is not «what it does»: ${work}`)
  assert.ok(!live.includes(busy.label), `демоны больше не в строке инстанса: ${live}`)
  assert.ok(!live.includes(done.label), `a settled agent is not «what it does»: ${live}`)
  assert.match(who, /\d{2}:\d{2} · работает ⏱$/, `ось-1: время, затем статус последним словом (T157): ${who}`)
  // демоны вложены ПОСЛЕ блока инстанса, с отступом и именем (T64)
  assert.ok(
    lines[liveIdx + liveBlock.length].startsWith(`      ${busy.emoji} ${demonName(busy.id)} `),
    `демон вложен под блоком инстанса своим эмодзи: ${lines[liveIdx + liveBlock.length]}`,
  )

  const idleIdx = identityOf(ui, "Простаивающая вкладка")
  const idleWho = stateOf(lines, idleIdx)
  assert.ok(idleWho.includes("—"), `no model → «—»: ${idleWho}`)
  assert.ok(!idleWho.includes("▰") && !idleWho.includes("▱"), `задач у инстанса нет — бара нет: ${idleWho}`)
  assert.ok(idleWho.includes("простаивает"), `an idle tab says so: ${idleWho}`)
  assert.ok(!idleWho.includes("работает"), `a stale tab with no load never claims work: ${idleWho}`)
  assert.match(idleWho, /\d{2}:\d{2} · простаивает$/, `контакт на оси-1 перед статусом (T157): ${idleWho}`)
})

// ------------------------------------- multi-line instance row (T83) --------

test("T83: строка инстанса в 2-3 строки — оси идентичность/состояние/[задачи], отступ одинаковый", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_short", title: "Маруська ЛУНА", model: "mimo-v2.6-flash", last_seen: new Date().toISOString() })
  upsertTab(l, { session_id: "ses_long", title: "Маруська ПАКЕТ", model: "mimo-v2.6-flash", last_seen: new Date().toISOString() })
  must(l, { op: "create", task: "короткий список", session_ref: "ses_short" }) // T1
  // у «ПАКЕТа» длинный список (T2…T15 >40 знаков в квадратах) — своя ось
  for (let i = 0; i < 14; i++) must(l, { op: "create", task: `задача батча ${i}`, session_ref: "ses_long" })
  const d = beginAgent(l, { input: { agent: "general", description: "[T2] work" }, ref: "ses_d1", home: "ses_long" })

  const p = project(l)
  const ui = p.ui
  const lines = ui.split("\n")

  // короткий [T1] не заслуживает своей строки → голова + ось-1 (кто) + ось-2 (дело), T156
  const shortBlock = instanceBlock(lines, identityOf(ui, "Маруська ЛУНА"))
  assert.equal(shortBlock.length, 3, `короткий [T…] на оси-2 (T156):\n${shortBlock.join("\n")}`)
  assert.ok(shortBlock[0].includes("Маруська ЛУНА"), `ось 1 = идентичность (эмодзи, имя): ${shortBlock[0]}`)
  assert.ok(
    shortBlock[0].startsWith(`  ${INSTANCE_EMOJI[0]} `),
    `голова блока = своё эмодзи + имя (без 🤖, T83): ${shortBlock[0]}`,
  )
  assert.ok(
    !shortBlock[0].includes(INSTANCE_PATH),
    "путь logOS.runtime.LUNA из рендера убран — панели он не нужен (правка Основателя 07.10 12:13)",
  )
  const shortWho = shortBlock[1]
  const shortWork = shortBlock[2]
  assert.ok(
    shortWho.includes("mimo-v2.6-flash") && shortWho.includes("▱▱▱▱▱ 0/1"),
    `ось-1 = кто·чем·как (модель · бар · статус, T156): ${shortWho}`,
  )
  assert.ok(shortWork.includes("[T1]"), `ось-2 несёт дела: ${shortWork}`)
  assert.ok(!shortWork.includes("Маруська ЛУНА"), "ось-2 не дублирует имя — колонки читаются по вертикали")
  assert.ok(!shortWho.includes("Маруська ЛУНА"), "ось-1 не дублирует имя")
  assert.ok(!shortBlock[0].includes("mimo-v2.6-flash"), "голова не дублирует параметры")
  // продолжения (ось 2/3) НЕ начинаются с маркера 🤖 — с ним они читались бы
  // как отдельные инстансы; маркер только у первой строки блока (заказ 12:13)
  for (const axisLine of shortBlock.slice(1)) {
    assert.ok(!instanceRow(axisLine), `ось без маркера, чистый отступ: ${axisLine}`)
    assert.ok(axisLine.startsWith("    ") && !axisLine.startsWith("      "), `ось глубже головы на ступень (2 → 4, T89): ${axisLine}`)
  }

  // имя инстанса — первым и целиком: срезанное «Маруська…» в хвосте строки
  // основатель не читает (TAB_NAME_CHARS в голове больше не режет)
  const persona = "Маруська Гольденштерн · Обсуждение задач из бэклога папки"
  assert.ok(persona.length > 48, "титул длиннее старшей обрезки — только так тест что-то доказывает")
  upsertTab(l, { session_id: "ses_persona", title: persona, model: "mimo-v2.6-flash", last_seen: new Date().toISOString() })
  const personaHead = instanceBlock(project(l).ui.split("\n"), identityOf(project(l).ui, persona.slice(0, 20)))[0]
  assert.ok(personaHead.endsWith(persona), `имя целиком, без обрезки: ${personaHead}`)
  assert.ok(!personaHead.includes("…"), `хвост не срезан: ${personaHead}`)

  // длинный список (>40 знаков) уходит осью 4 (после осей T156), имя/параметры не смешиваются
  const longIdx = identityOf(ui, "Маруська ПАКЕТ")
  const longBlock = instanceBlock(lines, longIdx)
  assert.equal(longBlock.length, 4, `длинный [T…] — своей строкой:\n${longBlock.join("\n")}`)
  assert.match(longBlock[3], /^ {4}\[T2 T3 /, `ось 4 = [T…] на отступе оси, без маркера: ${longBlock[3]}`)
  assert.ok(longBlock[3].length > 40, `длинный список целиком, без обрезки: ${longBlock[3]}`)
  assert.ok(!longBlock[1].includes("[T") && !longBlock[2].includes("[T"), `длинный список ушёл из осей: ${longBlock[1]} | ${longBlock[2]}`)

  // T89: отступы = уровни — голова блока 2, оси глубже (4); демоны свои (6)
  for (const line of shortBlock.slice(1)) {
    assert.ok(line.startsWith("    ") && !line.startsWith("      "), `ось на отступе 4 (T89): ${line}`)
  }
  assert.ok(shortBlock[0].startsWith("  ") && !shortBlock[0].startsWith("    "), `голова блока на отступе 2: ${shortBlock[0]}`)
  for (const line of longBlock.slice(1)) {
    assert.ok(line.startsWith("    ") && !line.startsWith("      "), `ось на отступе 4 (T89): ${line}`)
  }
  const dIdx = lines.findIndex((x) => x.includes(demonName(d.id)))
  assert.equal(dIdx, longIdx + longBlock.length, "демон вложен сразу под блоком своего инстанса")
  assert.ok(lines[dIdx].startsWith(`      ${d.emoji} `), `вложенность демона своя (6 пробелов, T89): ${lines[dIdx]}`)

  // панель: ось состояния (не имя) несёт план и замыкается статусом и временем
  const html = renderConsoleHtml(ui, l.updated_at, p.agents)
  const plans = JSON.parse(/const ETA = (\{[^;]*\});/.exec(html)![1]) as Record<string, { t0: number; eta: number }>
  assert.equal(plans[String(longIdx + 2)]?.t0, Date.parse(d.began_at), "ETA привязан к оси-2 («в задаче», T156)")
  assert.match(lines[longIdx + 1], /работает ⏱$/, `ось-1 замыкается статусом (T156): ${lines[longIdx + 1]}`)
})

test("T89: детская сессия рантайма — не инстанс (фильтр в projectTabs: ui и tabIds одинаковы)", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_top", title: "Настоящая вкладка", model: "mimo-v2.6-flash", last_seen: new Date().toISOString() })
  // автотитул спавна (T33: «T## · <спека задачи>») — раньше рисовался блоком ИНСТАНСЫ
  upsertTab(l, {
    session_id: "ses_child_title",
    title: "T83 · Панель: строка ИНСТАНСЫ в 2-3 строки · Маруська Гольденштерн",
    model: "mimo-v2.6-flash",
    last_seen: new Date().toISOString(),
  })
  // другой ребёнок без характерного титула узнаётся по записи агента (session_ref)
  upsertTab(l, { session_id: "ses_child_agent", title: "обычный титул", model: "mimo-v2.6-flash", last_seen: new Date().toISOString() })
  const a = beginAgent(l, { input: { agent: "general", description: "work" }, ref: "ses_child_agent", home: "ses_top" })

  const views = projectTabs(l)
  assert.deepEqual(
    views.map((v) => v.session_id),
    ["ses_top"],
    "инстансами считаются только top-вкладки: оба ребёнка отфильтрованы",
  )
  const ui = project(l).ui
  assert.ok(!ui.includes("T83 · Панель: строка ИНСТАНСЫ"), "автотитул спавна не рисуется блоком ИНСТАНСЫ")
  assert.ok(!ui.includes("обычный титул"), "ребёнок по session_ref агента тоже не инстанс")
  assert.ok(ui.includes("Настоящая вкладка"), "настоящая вкладка осталась в секции")
  // исполнитель не пропадает вовсе: его строка демона видна (под мамой)
  assert.ok(ui.includes(demonName(a.id)), `исполнитель виден строкой демона: ${ui}`)
  // tabIds (адреса кликов) собираются тем же projectTabs — рассинхрона с ui нет
  const html = renderConsoleHtml(ui, l.updated_at, l.agents, null, { port: 45111, tabIds: views.map((v) => v.session_id) })
  assert.ok(html.includes('"ses_top"') && !html.includes("ses_child"), "в страницу уехали только адреса инстансов")
})

test("T89: цвета — панель красит строку по смыслу (все шапки секций, задачи, головы/оси инстансов)", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_1", title: "Инстанс проверки", last_seen: new Date().toISOString() })
  must(l, { op: "create", task: "работа в работе" })
  must(l, { op: "set_state", id: "T1", state: "DOING" })
  must(l, { op: "create", task: "работа в очереди" })
  const p = project(l)
  const body = paneBody(renderConsoleHtml(p.ui, l.updated_at, l.agents))
  const clsOf = (needle: string): string => {
    const line = body.split("\n").find((x) => x.includes(needle))
    assert.ok(line, `строка «${needle}» дошла до панели`)
    return (/class="([^"]*)"/.exec(line) ?? [])[1] ?? ""
  }
  // до T89 классы вешались по неотступленному startsWith и ничего не ловили
  assert.ok(clsOf("🤖 ИНСТАНСЫ").includes("sec"), "шапка ИНСТАНСЫ — секция (синяя)")
  assert.ok(clsOf("🔄 В РАБОТЕ").includes("sec"), "шапка В РАБОТЕ — секция")
  assert.ok(clsOf("⚡ ЗАДАЧИ").includes("sec"), "шапка ⚡ — секция (раньше терялась вовсе)")
  assert.ok(clsOf("работа в очереди").includes("sec"), "строка задачи — синяя, не пустая")
  assert.ok(clsOf("Инстанс проверки").includes("tab"), "голова инстанса — своя строка панели (оранжевая)")
})

test("renderConsoleHtml: ИНСТАНСЫ reaches the pane, colorized, under the 10s refresh", () => {
  const l = freshLedger()
  upsertTab(l, {
    session_id: "ses_pane",
    title: "Панельная вкладка",
    model: "nemotron-3-ultra",
    last_seen: new Date(Date.now() - 60_000).toISOString(),
  })
  const p = project(l)
  const html = renderConsoleHtml(p.ui, l.updated_at, p.agents)
  assert.ok(paneLines(html).some((x) => x.startsWith("🤖 ИНСТАНСЫ")), "section embedded in the pane")
  assert.ok(html.includes("Панельная вкладка"), "tab row embedded")
  assert.ok(html.includes("location.reload"), "панель обновляет себя ТОЛЬКО видимой (CPU 10.11)")
  assert.ok(html.includes('cls = "tab"'), "the colorizer knows tab rows")
  assert.ok(html.includes(".tab {"), "tab style shipped with the pane")

  const bare = renderConsoleHtml(project(freshLedger()).ui, "t")
  assert.ok(!paneLines(bare).some((x) => x.startsWith("🤖 ИНСТАНСЫ")), "no tabs → the pane shows no section")
})

// ---------------------------------- pane order + tab status (T59) ------------

test("ИНСТАНСЫ — первая секция панели (кто работает — до того, что делается)", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_1", title: "Вкладка", last_seen: new Date().toISOString() })
  must(l, { op: "create", task: "в работе", session_ref: "ses_1" })
  must(l, { op: "set_state", id: "T1", state: "DOING" })
  must(l, { op: "create", task: "в очереди" })
  must(l, { op: "create", task: "заблокирована" })
  must(l, { op: "set_state", id: "T3", state: "BLOCKED", why: "нет доступа" })
  const ag = beginAgent(l, { input: { agent: "general", description: "[T1] work" }, ref: "ses_child", home: "ses_1" })

  const p = project(l)
  const pos = (ui: string, marker: string): number => ui.indexOf(marker)
  const tabs = pos(p.ui, "🤖 ИНСТАНСЫ")
  assert.ok(tabs > 0, "секция инстансов отрисована")
  for (const marker of ["🔄 В РАБОТЕ", "⚡ ЗАДАЧИ", "⛔ ЗАБЛОКИРОВАНО"]) {
    assert.ok(pos(p.ui, marker) > tabs, `${marker} должна идти ПОСЛЕ инстансов`)
  }
  assert.ok(!p.ui.includes("🤖 АГЕНТЫ"), "секции АГЕНТЫ больше нет — демоны вложены (T69)")

  // тот же порядок уезжает в HTML панели
  const html = renderConsoleHtml(p.ui, l.updated_at, p.agents)
  assert.ok(html.indexOf("🤖 ИНСТАНСЫ") < html.indexOf("🔄 В РАБОТЕ"), "порядок секций дошёл до панели")
  // строки инстансов содержат «работает ⏱» без цифр — план агента (⏱Nм) к ним
  // не привязывается; строка шапки со своими таймерами — в TIMERS, не в ETA.
  // T74(1): строка вкладки несёт текущую задачу («в задаче T1 ⏱Nм») — её
  // индекс строки тоже в ETA, с планом живого агента этой задачи.
  const eta = /const ETA = (\{[^;]*\});/.exec(html)
  assert.ok(eta, "план агентов вшит в страницу")
  const plans = JSON.parse(eta![1]) as Record<string, { t0: number; eta: number }>
  // T99 block format: instance state axis gets plan (matches "в задаче T1" pattern),
  // daemon gets plan. Total 2 plans instead of 3 (occupied task axis not in ETA).
  assert.equal(
    Object.keys(plans).length,
    2,
    "план агента живёт на двух строках: ось состояния вкладки + демон; занятая строка задачи не в ETA (T99 block format)",
  )
  const uiLines = p.ui.split("\n")
  const tabIdx = identityOf(p.ui, "Вкладка")
  const agIdx = uiLines.findIndex((x) => x.includes(demonName(ag.id)))
  assert.ok(
    tabIdx > 1 && agIdx === tabIdx + instanceBlock(uiLines, tabIdx).length,
    "демон вложен сразу под блоком своей вкладки (после всех её осей)",
  )
  // Daemon line gets plan
  assert.equal(plans[String(agIdx)]?.t0, Date.parse(ag.began_at), "строка демона по-прежнему со своим планом")
  // Instance work axis line gets plan (matches "в задаче T1" pattern)
  // T156: «в задаче» переехало на ось-2 (голова + ось-1 + ось-2)
  const stateAxisIdx = tabIdx + 2
  assert.equal(plans[String(stateAxisIdx)]?.t0, Date.parse(ag.began_at), "ось-2 («в задаче») получила план агента")
  assert.ok(!Object.prototype.hasOwnProperty.call(plans, "1"), "шапка не ворует планы демоны")
})

// --------------------------------- instances section (T69) ------------------

test("ИНСТАНСЫ: шапка = общий % · ⏳(план самого долгого, параллельно) · ⏱(с самого раннего began_at)", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_1", title: "Маруська", last_seen: new Date().toISOString() })
  must(l, { op: "create", task: "задача 1", session_ref: "ses_1" })
  must(l, { op: "create", task: "задача 2" })
  must(l, { op: "set_state", id: "T1", state: "DONE", verification: "v" })
  const header = (): string => project(l).ui.split("\n")[1]
  // T104(3): живых агентов нет — отсчёта нет, но строка времени не исчезает:
  // плановый горизонт открытого списка (T2 WAIT = дефолт очереди 5м).
  assert.equal(header(), "🤖 ИНСТАНСЫ · по времени 50% · задачи 50% (1/2) · ⏳~05:00 план")

  const a1 = beginAgent(l, { input: { agent: "general", description: "x" }, ref: "ses_a1" })
  a1.began_at = new Date(Date.now() - 10 * 60000).toISOString() // шла 10 мин
  a1.eta_min = 30 // осталось 20
  const a2 = beginAgent(l, { input: { agent: "general", description: "y" }, ref: "ses_a2" })
  a2.began_at = new Date(Date.now() - 4 * 60000).toISOString()
  a2.eta_min = 10 // осталось 6
  assert.equal(
    header(),
    "🤖 ИНСТАНСЫ · по времени 50% · задачи 50% (1/2) · ⏳20:00 · ⏱10м · ~05:00 план",
    "⏳ = план самого долгого в mm:ss (T85), параллельные планы не суммируются; ⏱ = 10 с самого раннего начала; T161: план открытого списка виден и при живых агентах (без ⏳ — он занят отсчётом ребёнка)",
  )

  // задач у ledger'а нет — процента нет, таймеры живых агентов остаются
  const l2 = freshLedger()
  upsertTab(l2, { session_id: "s", title: "Инстанс", last_seen: new Date().toISOString() })
  const a = beginAgent(l2, { input: { agent: "general", description: "z" }, ref: "ses_z" })
  a.began_at = new Date(Date.now() - 60000).toISOString()
  a.eta_min = 30
  assert.equal(project(l2).ui.split("\n")[1], "🤖 ИНСТАНСЫ · ⏳29:00 · ⏱1м")
})

test("ИНСТАНСЫ: процент учитывает план (заказ 24.10) — открытые минуты тянут вниз", () => {
  const l = freshLedger()
  // 4 закрытые задачи; закрытые агенты шли по 10 минут → средняя 10м
  for (let i = 1; i <= 4; i++) {
    must(l, { op: "create", task: `закрыта ${i}` })
    must(l, { op: "set_state", id: `T${i}`, state: "DONE", verification: "v" })
    const a = beginAgent(l, { input: { agent: "general", description: "x" }, ref: `ses_d${i}` })
    a.state = "completed"
    a.began_at = new Date(Date.now() - 10 * 60000).toISOString()
    a.updated_at = new Date().toISOString()
  }
  must(l, { op: "create", task: "открыта 1" })
  must(l, { op: "create", task: "открыта 2" })
  // без est_min обе по дефолту очереди 5м → открытых 10м; сделано 4×10=40м
  assert.equal(timeAwarePercent(l.tasks, l.agents, 0), Math.floor((40 / (40 + 10)) * 100), "40м готово против 10м плана → 80%")
  // явная оценка декомпозиции (est_min) перекрывает дефолт — 30м каждая
  for (const t of l.tasks) if (t.state === "WAIT") t.est_min = 30
  assert.equal(timeAwarePercent(l.tasks, l.agents, 0), Math.floor((40 / (40 + 60)) * 100), "60м явного плана → 40%")
  // честные возвраты к счётному overallPercent
  assert.equal(timeAwarePercent([], l.agents, 0), null, "задач нет")
  const l2 = freshLedger()
  must(l2, { op: "create", task: "только открытая" })
  assert.equal(timeAwarePercent(l2.tasks, l2.agents, 0), null, "закрытых нет → счётный fallback")
})

test("ИНСТАНСЫ: est_min декомпозиции — первый источник плана задачи (заказ 24.10)", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "s", title: "Инстанс", last_seen: new Date().toISOString() })
  must(l, { op: "create", task: "открытая фаза" })
  l.tasks[0].est_min = 45
  const ui = project(l).ui.split("\n")[1]
  assert.ok(ui.includes("⏳~45:00 план"), `явная оценка перекрывает дефолт 5м: ${ui}`)
})

test("ИНСТАНСЫ: демоны вложены с отступом (бар его задачи + свой ⏱); панель привязывает план по id (T69)", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_1", title: "Инстанс один", last_seen: new Date().toISOString() })
  upsertTab(l, { session_id: "ses_2", title: "Инстанс два", last_seen: new Date(Date.now() - 5000).toISOString() })
  must(l, { op: "create", task: "фича", session_ref: "ses_1" }) // T1 — родитель
  must(l, { op: "create", task: "шаг", parent: "T1" }) // T2 — декомпозиция T1
  must(l, { op: "create", task: "очередь", session_ref: "ses_2" }) // T3
  const a1 = beginAgent(l, { input: { agent: "general", description: "[T1] work" }, ref: "ses_a", home: "ses_1" })
  a1.began_at = new Date(Date.now() - 5 * 60000).toISOString()
  a1.eta_min = 30 // осталось 25
  const a2 = beginAgent(l, { input: { agent: "general", description: "[T3] work" }, ref: "ses_b", home: "ses_2" })
  a2.began_at = new Date(Date.now() - 40 * 60000).toISOString() // самый ранний
  a2.eta_min = 10 // просрочка: +30м

  const p = project(l)
  const lines = p.ui.split("\n")
  const row1 = identityOf(p.ui, "Инстанс один")
  const block1 = instanceBlock(lines, row1)
  assert.equal(block1.length, 3, "T83/T156: голова + ось-1 (кто·чем·как) + ось-2 (дело)")
  assert.ok(block1[1].includes("▱▱▱▱▱ 0/1"), `готовность строки = её задачи DONE/всего: ${block1[1]}`)
  const d1 = lines[row1 + block1.length]
  assert.ok(d1.startsWith(`      ${a1.emoji} ${demonName(a1.id)} · [T1] `), `демон вложен под блоком инстанса (отступ 6, T89): ${d1}`)
  assert.ok(d1.includes("▱▱▱▱▱ 0/1"), `бар = готовность задачи демона (декомпозиция): ${d1}`)
  assert.ok(d1.includes("⏱25:00"), `свой обратный отсчёт (mm:ss, T85): ${d1}`)
  const row2 = identityOf(p.ui, "Инстанс два")
  const d2 = lines[row2 + instanceBlock(lines, row2).length]
  assert.ok(d2.startsWith(`      ${a2.emoji} ${demonName(a2.id)} · [T3] `), `вложен и под вторым инстансом: ${d2}`)
  assert.match(d2, /⏱\+30:00/, `просроченный план = +mm:ss (просрочка — вниз, без долей): ${d2}`)
  assert.ok(!p.ui.includes("📂"), "старый глиф 📂 убран из ui (T162, T69)")
  assert.ok(!p.ui.includes("🤖 АГЕНТЫ"), "секции АГЕНТЫ нет")

  // панель: план каждого демоны — своей строке (по id, не по позиции), шапка — своим
  const html = renderConsoleHtml(p.ui, l.updated_at, p.agents)
  const eta = JSON.parse(/const ETA = (\{[^;]*\});/.exec(html)![1]) as Record<string, { t0: number; eta: number }>
  const timers = JSON.parse(/const TIMERS = (\{[^;]*\});/.exec(html)![1]) as Record<
    string,
    { dl: number; rate: number; run: number }
  >
  assert.equal(
    Object.keys(eta).length,
    4,
    "план на каждой строке: два демона + две занятые строки задач (T85: 🔒 тикает); оси состояния вкладок теперь не в ETA (T99)",
  )
  // Даемоны получают планы
  for (const a of [a1, a2]) {
    const idx = String(lines.findIndex((x) => x.startsWith(`      ${a.emoji} ${demonName(a.id)} `)))
    assert.ok(idx !== "-1", `${a.id} demon line found at ${idx}`)
    assert.equal(eta[idx]?.t0, Date.parse(a.began_at), `${a.id}: t0 его строки`)
    assert.equal(eta[idx]?.eta, a.eta_min, `${a.id}: план его строки`)
  }
  // T99 block format: занятые строки задач (axis lines) не попадают в ETA-map
  // (regex матчит header с ●/↳ [T...], а axis line начинается с state glyph)
  const busy1Idx = lines.findIndex((x) => x.includes(`🔒${a1.id} работает`))
  const busy2Idx = lines.findIndex((x) => x.includes(`🔒${a2.id} работает`))
  assert.ok(busy1Idx >= 0, "занятая строка T1 найдена")
  assert.ok(busy2Idx >= 0, "занятая строка T3 найдена")
  // UI показывает mm:ss корректно, но ETA-map для axis lines не заполняется (T99)
  assert.ok(!("1" in eta), "строка шапки не ворует планы демоны")
  assert.equal(timers["1"]?.run, Date.parse(a2.began_at), "⏱ шапки = самый ранний began_at")
  assert.equal(timers["1"]?.rate, 1, "⏳ шапки идёт темпом 1: планы параллельны, не сумма отсчётов")
  assert.equal(
    timers["1"]?.dl,
    Math.max(
      Date.parse(a1.began_at) + a1.eta_min * 60000,
      Date.parse(a2.began_at) + a2.eta_min * 60000,
    ),
    "⏳ шапки = дедлайн самого долгого живого агента (по плану самого долгого)",
  )
})

test("статус вкладки честный: работает / ждёт / простаивает (T73)", () => {
  const l = freshLedger()
  const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()
  upsertTab(l, { session_id: "ses_turn", title: "свежий ход без нагрузки", last_seen: ago(TAB_FRESH_MS - 5_000) })
  upsertTab(l, { session_id: "ses_fresh", title: "контакт старше минуты", last_seen: ago(TAB_IDLE_MS - 60_000) })
  upsertTab(l, { session_id: "ses_wait", title: "задачи без агентов", last_seen: ago(TAB_FRESH_MS + 60_000) })
  upsertTab(l, { session_id: "ses_stale", title: "старая без нагрузки", last_seen: ago(TAB_IDLE_MS + 60_000) })
  upsertTab(l, { session_id: "ses_task", title: "старая с задачей", last_seen: ago(TAB_IDLE_MS + 60_000) })
  upsertTab(l, { session_id: "ses_agent", title: "старая с агентом", last_seen: ago(TAB_IDLE_MS + 60_000) })
  upsertTab(l, { session_id: "ses_done", title: "старая с закрытым", last_seen: ago(TAB_IDLE_MS + 60_000) })
  must(l, { op: "create", task: "открытая задача", session_ref: "ses_wait" })
  must(l, { op: "create", task: "открытая задача", session_ref: "ses_task" })
  must(l, { op: "create", task: "закрытая задача", session_ref: "ses_done" })
  must(l, { op: "set_state", id: "T3", state: "DONE", verification: "v" })
  const ag = beginAgent(l, { input: { agent: "general", description: "work" }, ref: "ses_child", home: "ses_agent" })

  const ui = project(l).ui
  // T83/T156: статус живёт на оси-1 блока инстанса, дела — на оси-2.
  const row = (title: string): string => stateOf(ui.split("\n"), identityOf(ui, title))
  // (1) работает: API не передан (probe ещё не сделался) → фолбэк-эвристика:
  // свежий ход модели (≤60с) ИЛИ живые агенты running|waiting
  assert.ok(row("свежий ход без нагрузки").includes("работает ⏱"), "свежий вызов модели = работает")
  assert.ok(row("старая с агентом").includes("работает ⏱"), "живой агент спасает от «простаивает»")
  assert.ok(ui.includes(demonName(ag.id)), `живой агент виден в ui (вложенной строкой): ${demonName(ag.id)}`)
  // (2) ждёт: контакт был, но ни живых агентов, ни свежего хода
  assert.ok(row("контакт старше минуты").includes("ждёт ⏳"), "контакт ≤5мин без агентов = ждёт")
  assert.ok(!row("контакт старше минуты").includes("работает"), "молчащая вкладка не горит рабочей")
  // верификация T73: свои задачи + нет агентов + контакт старше 60с → ждёт, не работает
  const waiting = row("задачи без агентов")
  assert.ok(waiting.includes("ждёт ⏳"), `задачи без агентов и без свежего хода = ждёт: ${waiting}`)
  assert.ok(!waiting.includes("работает ⏱"), `непустой load больше не = «работает ⏱»: ${waiting}`)
  assert.ok(workOf(ui.split("\n"), identityOf(ui, "задачи без агентов")).includes("[T1]"), `нагрузка видна на оси-2 (T156)`)
  assert.ok(row("старая с задачей").includes("ждёт ⏳"), "старый контакт с задачами: не «работает» (T73) и не «простаивает» (T59)")
  // (3) простоаивает: старше 5мин И живой нагрузки нет
  assert.ok(row("старая без нагрузки").includes("простаивает"), "за порогом и без нагрузки = простой")
  assert.ok(!row("старая без нагрузки").includes("работает"), "старая вкладка без нагрузки не работает")
  assert.ok(row("старая с закрытым").includes("простаивает"), "DONE-задачи — не нагрузка")
  // T157: статус — последнее слово оси-1, время перед ним
  assert.match(row("задачи без агентов"), / · \d{2}:\d{2} · ждёт ⏳$/)
})

test("T73: первичный источник статуса — /api/session/active (сигнал кнопки Стоп)", () => {
  const l = freshLedger()
  const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()
  // старый контакт, но сессия в active: чат работает → «работает ⏱»
  upsertTab(l, { session_id: "ses_run", title: "сессия в active", last_seen: ago(TAB_IDLE_MS + 60_000) })
  // свежий контакт, но сессии в active нет: чата нет → «ждёт ⏳», не «работает»
  upsertTab(l, { session_id: "ses_silent", title: "молчит без active", last_seen: ago(5_000) })
  // старый контакт, нет в active, нет нагрузки → «простаивает»
  upsertTab(l, { session_id: "ses_off", title: "старый без задач", last_seen: ago(TAB_IDLE_MS + 60_000) })
  // старый контакт, нет в active, но открытая задача есть (T59: это нагрузка)
  upsertTab(l, { session_id: "ses_task", title: "старый с задачей", last_seen: ago(TAB_IDLE_MS + 60_000) })
  must(l, { op: "create", task: "работа стоит", session_ref: "ses_task" })

  const active = parseActiveSessions({ data: { ses_run: { type: "running" } } })
  assert.ok(active !== null, "живой ответ разобран в множество сессий")
  // T83: статус живёт в оси состояния — вторая строка блока инстанса.
  const rowIn = (ui: string, title: string): string => stateOf(ui.split("\n"), identityOf(ui, title))

  const ui = project(l, active).ui
  assert.ok(
    rowIn(ui, "сессия в active").includes("работает ⏱"),
    "session_id ∈ active = работает, даже когда последний контакт старый",
  )
  const silent = rowIn(ui, "молчит без active")
  assert.ok(silent.includes("ждёт ⏳"), `нет в active → ждёт, свежий last_seen не делает рабочей: ${silent}`)
  assert.ok(!silent.includes("работает"), "свежий ход без active не горит «работает ⏱»")
  // открытая задача есть, но активности нет: T73 (не работает) + T59 (не простой)
  assert.ok(rowIn(ui, "старый с задачей").includes("ждёт ⏳"), "открытые задачи без active: ждёт, не простаивает (T59)")
  assert.ok(!rowIn(ui, "старый с задачей").includes("работает"), "непустой load без active не = работа (заказ T73)")
  // старый контакт + ни active, ни нагрузки → простой (семантика T59 живёт)
  assert.ok(rowIn(ui, "старый без задач").includes("простаивает"), "старый контакт + нет active + нет нагрузки = простой")

  // probe не удался (active = null) → фолбэк-эвристика по свежести вызова модели
  const fb = project(l, null).ui
  assert.ok(
    rowIn(fb, "молчит без active").includes("работает ⏱"),
    "без API эвристика: last_seen ≤60с (контекст-хук = вызов идёт) = работает",
  )
  assert.ok(!rowIn(fb, "сессия в active").includes("работает"), "без API старый контакт не работает")
})

// ------------------------------------------- T68: авто-мигание -------------
// Заказ Основателя 08.10: «пусть мигают инстансы Маруськи, которые
// простаивают». Авто-триггер живёт в index.ts (скан цикла), но решает он чистой
// функцией state.ts — здесь покрыто правило; мигалку (blinkTimers/канал T60)
// suite не гоняет, её верификация = PARSE OK + живая проба (класс T93).
test("T68: tabStatus = тот же статус, что рисует панель (скан не парсит строку рендера)", () => {
  const l = freshLedger()
  const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()
  upsertTab(l, { session_id: "ses_run", title: "старая но в active", last_seen: ago(TAB_IDLE_MS + 60_000) })
  upsertTab(l, { session_id: "ses_silent", title: "свежий контакт", last_seen: ago(5_000) })
  upsertTab(l, { session_id: "ses_load", title: "старая с задачей", last_seen: ago(TAB_IDLE_MS + 60_000) })
  upsertTab(l, { session_id: "ses_off", title: "старая без нагрузки", last_seen: ago(TAB_IDLE_MS + 60_000) })
  must(l, { op: "create", task: "работа стоит", session_ref: "ses_load" })
  const active = parseActiveSessions({ data: { ses_run: { type: "running" } } })
  const view = (id: string) => projectTabs(l).find((v) => v.session_id === id)!

  for (const [withActive, expected] of [
    [active, { ses_run: "работает ⏱", ses_silent: "ждёт ⏳", ses_load: "ждёт ⏳", ses_off: "простаивает" }],
    [null, { ses_run: "простаивает", ses_silent: "работает ⏱", ses_load: "ждёт ⏳", ses_off: "простаивает" }],
  ] as const) {
    for (const [id, status] of Object.entries(expected)) {
      const v = view(id)
      assert.equal(tabStatus(v, l, withActive), status, `tabStatus(${id}) при active=${withActive === null ? "null" : "есть"}`)
      // эквивалентность с панелью: ось-1 несёт ЭТОТ статус (T156: статус —
      // последний сегмент оси-1, сравниваем по сегментам «·»)
      const axis = describeTab(v, l, withActive)[1]
      assert.ok(
        axis.split("·").map((s) => s.trim()).includes(status),
        `строка панели несёт tabStatus (T68: скан и панель = одно решение): status=${status} axis=${axis}`,
      )
    }
  }
})

test("T68: авто-мигание — вход в «простаивает» включает, возврат активности гасит (T60 не трогаем)", () => {
  const IDLE = "простаивает"
  // смена статуса на «простаивает» → мигание ВКЛ (первый проход скана — тоже
  // переход: инстанс, простаивающий на старте рантайма, мигает сразу)
  assert.equal(autoBlinkAction(IDLE, "работает ⏱", false, false), "start", "работал → простаивает: старт")
  assert.equal(autoBlinkAction(IDLE, "ждёт ⏳", false, false), "start", "ждал → простаивает: старт")
  assert.equal(autoBlinkAction(IDLE, null, false, false), "start", "первый проход скана при простое: старт")
  // мигание уже есть — toggle не дёргаем (иначе авто ПОГАСИЛО бы чужое)
  assert.equal(autoBlinkAction(IDLE, "работает ⏱", true, false), "none", "горит ручное → не трогаем")
  // простой без смены статуса: ручное «погасить» скан не включает заново
  assert.equal(autoBlinkAction(IDLE, IDLE, true, false), "none", "клик «off» уважается: смены статуса нет")
  assert.equal(autoBlinkAction(IDLE, IDLE, false, false), "none", "простой продолжается — старт уже был")
  // активность вернулась (active-сессия/нагрузка/агент = выход из «простаивает»)
  assert.equal(autoBlinkAction("работает ⏱", IDLE, true, true), "stop", "простаивал → работает: гасим")
  assert.equal(autoBlinkAction("ждёт ⏳", IDLE, true, true), "stop", "простаивал → ждёт (свежий контакт): гасим")
  // ручное мигание T60 при пробуждении НЕ гасится (autoStarted не стоит)
  assert.equal(autoBlinkAction("работает ⏱", IDLE, true, false), "none", "клик основателя авто-логика не трогает")
  // перехода нет либо мигания нет — тишина
  assert.equal(autoBlinkAction("работает ⏱", "работает ⏱", true, false), "none")
  assert.equal(autoBlinkAction("ждёт ⏳", "работает ⏱", false, false), "none")
  assert.equal(autoBlinkAction("работает ⏱", null, false, false), "none", "первый проход на активной строке — не старт")
  assert.equal(autoBlinkAction("работает ⏱", IDLE, false, true), "none", "мигания нет (PATCH упал) — стоп не нужен")
})

test("parseActiveSessions: ответ /api/session/active → множество живых сессий, мусор → null", () => {
  const set = parseActiveSessions({ data: { ses_a: { type: "running" }, ses_b: { type: "running" } } })
  assert.ok(set !== null)
  assert.deepEqual([...set].sort(), ["ses_a", "ses_b"])
  assert.deepEqual([...parseActiveSessions({ data: {} })!], [], "пустой ответ = ни одной живой сессии")
  assert.equal(parseActiveSessions({ message: "nope" }), null, "не тот JSON → null (эвристика, не простой)")
  assert.equal(parseActiveSessions("<html>401</html>"), null, "HTML вместо JSON → null")
  assert.equal(parseActiveSessions(null), null)
})

test("панель: цвет статуса строки вкладки — работает ярко, ждёт приглушённо, простаивает серо", () => {
  const l = freshLedger()
  const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()
  upsertTab(l, { session_id: "s1", title: "работает", last_seen: ago(TAB_FRESH_MS - 5_000) })
  upsertTab(l, { session_id: "s2", title: "ждёт", last_seen: ago(TAB_IDLE_MS - 60_000) })
  upsertTab(l, { session_id: "s3", title: "простаивает", last_seen: ago(TAB_IDLE_MS + 60_000) })
  const p = project(l)
  const html = renderConsoleHtml(p.ui, l.updated_at, p.agents)
  assert.ok(html.includes(".tab { color:#ffa657; font-weight:bold; }"), "работает = яркий базовый стиль")
  assert.ok(html.includes(".tab.t-wait {"), "ждёт = приглушённый класс в стилях")
  assert.ok(html.includes(".tab.t-idle {"), "простаивает = серый класс в стилях")
  assert.ok(html.includes('cls = "tab"'), "строка вкладки по-прежнему помечена tab")
  assert.ok(html.includes('tm[1] === "простаивает" ? " t-idle" : " t-wait"'), "цвет определяется по статусу строки")
  // статусы доехали до панели (заголовок секции отдельной задачей — см. T69)
  assert.ok(html.includes("ждёт ⏳") && html.includes("простаивает"), "строки статусов дошли до панели")
})

test("renderConsoleHtml: локация → <title> и 📁-шапка (разные папки = разные вкладки)", () => {
  const a = renderConsoleHtml("x", "t", [], {
    name: "pipeline-setup",
    path: "C:\\Users\\banan\\Developer\\pipeline-setup",
    branch: "master",
    remote: "https://github.com/goldenstern/lavk-dev-console.git",
  })
  assert.ok(a.includes("<title>DEV CONSOLE · КОРПОРАЦИЯ ЯСНОСТЬ · pipeline-setup</title>"), "title несёт имя папки")
  assert.ok(
    a.includes(
      "📁 pipeline-setup · C:\\Users\\banan\\Developer\\pipeline-setup · master · https://github.com/goldenstern/lavk-dev-console.git",
    ),
    "компактная шапка: имя · путь · ветка · remote",
  )
  assert.ok(a.indexOf('id="loc"') < a.indexOf('id="wrap"'), "шапка стоит над телом панели")

  const b = renderConsoleHtml("x", "t", [], { name: "other-repo", path: "D:\\work\\other-repo" })
  assert.ok(b.includes("<title>DEV CONSOLE · КОРПОРАЦИЯ ЯСНОСТЬ · other-repo</title>"), "другая папка → другой title")
  assert.ok(b.includes("📁 other-repo · D:\\work\\other-repo</span>"), "ветка/remote не выдумываются")

  const bare = renderConsoleHtml("x", "t")
  assert.ok(bare.includes("<title>LAVK DEV CONSOLE · КОРПОРАЦИЯ ЯСНОСТЬ</title>"), "без локации — прежний заголовок")
  assert.ok(!bare.includes('id="loc"'), "без локации шапки нет")

  const evil = renderConsoleHtml("x", "t", [], { name: "</title><img src=x>", path: "p&q" })
  assert.ok(!evil.includes("</title><img"), "локация экранируется в title")
  assert.ok(evil.includes("&lt;/title&gt;&lt;img src=x&gt;"), "escaped, not raw")
  assert.ok(evil.includes("p&amp;q"), "path escaped too")
})

// -------------------------------- emoji identity: instances/daemons (T71) ----

test("T71: эмодзи назначается один раз при регистрации; на рендере не пересчитывается", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_1", title: "Маруська ЛУНА", last_seen: new Date().toISOString() })
  upsertTab(l, { session_id: "ses_2", title: "Маруська ПЛЮС", last_seen: new Date().toISOString() })
  assert.equal(l.tabs[0].emoji, INSTANCE_EMOJI[0], "первый инстанс — первый из палитры")
  assert.equal(l.tabs[1].emoji, INSTANCE_EMOJI[1], "второй — первый свободный, по порядку регистрации")

  const a1 = beginAgent(l, { input: { agent: "general", description: "[T1] x" }, ref: "c1" })
  const a2 = beginAgent(l, { input: { agent: "qc", description: "y" }, ref: "c2" })
  assert.equal(a1.emoji, DAEMON_EMOJI[0], "демоны — своя палитра")
  assert.equal(a2.emoji, DAEMON_EMOJI[1], "и тот же порядок: первый свободный")

  const ui1 = project(l).ui
  assert.ok(
    ui1.includes(`  ${INSTANCE_EMOJI[0]} Маруська ЛУНА`),
    "строка инстанса: своё эмодзи + имя первым (без 🤖, T83)",
  )
  // путь не нужен ни в одной строке инстанса (в имени демона он остаётся — T64)
  const idRows = ui1.split("\n").filter((x) => instanceRow(x))
  assert.ok(
    idRows.length > 0 && idRows.every((x) => !x.includes(INSTANCE_PATH)),
    "logOS.runtime.LUNA — только в имени демона, не в строках инстанса",
  )
  assert.ok(ui1.includes(`    ${DAEMON_EMOJI[0]} ${demonName(a1.id)} `), "вложенная строка демона — своим персонажем")

  // Повторный рендер и новое наблюдение не двигают эмодзи (оно в записи)
  project(l)
  upsertTab(l, { session_id: "ses_1", title: "Маруська ЛУНА v2", last_seen: new Date().toISOString() })
  assert.equal(l.tabs[0].emoji, INSTANCE_EMOJI[0], "upsert не пересчитывает")
  assert.ok(
    project(l).ui.includes(`  ${INSTANCE_EMOJI[0]} Маруська ЛУНА v2`),
    "та же девочка в новом рендере",
  )

  // Чужая регистрация не перетирает уже назначенное
  upsertTab(l, { session_id: "ses_3", title: "Маруська ТРИ", last_seen: new Date().toISOString() })
  assert.deepEqual(
    l.tabs.map((t) => t.emoji),
    [INSTANCE_EMOJI[0], INSTANCE_EMOJI[1], INSTANCE_EMOJI[2]],
    "каждый живёт со своим, назначение не разъезжается",
  )
})

test("T71: палитра занята — обёртка % длины; пустое/чужое — fallback 🤖/▸", () => {
  const l = freshLedger()
  const born = Array.from({ length: DAEMON_EMOJI.length + 1 }, (_, i) =>
    beginAgent(l, { input: { agent: "general", description: `job ${i}` }, ref: `c${i}` }),
  )
  assert.deepEqual(
    born.slice(0, DAEMON_EMOJI.length).map((a) => a.emoji),
    [...DAEMON_EMOJI],
    "одиннадцать — ровно по палитре в порядке регистрации",
  )
  assert.equal(
    born[DAEMON_EMOJI.length].emoji,
    DAEMON_EMOJI[0],
    "двенадцатый: свободного нет → номер регистрации % длины палитры",
  )

  // Чужое значение в записи не доходит до панели — фолбэк (правило 4)
  l.tabs.push({
    session_id: "ses_bad",
    title: "Чужая запись",
    model: null,
    emoji: "🐸",
    last_seen: new Date().toISOString(),
  })
  const ui = project(l).ui
  assert.ok(
    ui.includes("  Чужая запись"),
    "чужое поле строки инстанса → без эмодзи, голова остаётся именем (T64/T83)",
  )
  assert.ok(!ui.includes("🐸"), "чужой эмодзи в панель не попадает")
  const demon0 = demonName(born[0].id)
  const firstDaemon = ui.split("\n").find((x) => x.includes(`${demon0} ·`))!
  assert.ok(firstDaemon.startsWith(`      ${DAEMON_EMOJI[0]} ${demon0} `), `демон рисуется своим маркером: ${firstDaemon}`)
})

test("T71: эмодзи живёт в записи (рестарт); до-T71 записи получают палитру по порядку загрузки", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-"))
  const file = join(dir, "state.json")
  try {
    const l = freshLedger()
    upsertTab(l, { session_id: "ses_p", title: "Pane tab", last_seen: new Date().toISOString() })
    beginAgent(l, { input: { agent: "qc", description: "check" }, ref: "c-1" })
    saveLedger(file, l)
    const back = loadLedger(file)
    assert.equal(back.tabs[0].emoji, INSTANCE_EMOJI[0], "эмодзи инстанса пережил рестарт")
    assert.equal(back.agents[0].emoji, DAEMON_EMOJI[0], "эмодзи демона пережил рестарт")

    // Файл до T71 — поля нет: первая загрузка с фичей и есть назначение
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        tasks: [],
        agents: [{ id: "A1", label: "x", state: "running", updated_at: "2026-10-01T00:00:00.000Z" }],
        tabs: [{ session_id: "ses_a", title: "A" }, { session_id: "ses_b", title: "B" }],
      }),
      "utf8",
    )
    const legacy = loadLedger(file)
    assert.deepEqual(
      legacy.tabs.map((t) => t.emoji),
      [INSTANCE_EMOJI[0], INSTANCE_EMOJI[1]],
      "легаси-вкладки получают палитру в порядке загрузки",
    )
    assert.equal(legacy.agents[0].emoji, DAEMON_EMOJI[0], "легаси-демон тоже не остаётся без персонажа")

    saveLedger(file, legacy)
    assert.deepEqual(
      loadLedger(file).tabs.map((t) => t.emoji),
      [INSTANCE_EMOJI[0], INSTANCE_EMOJI[1]],
      "повторная загрузка уже ничего не пересчитывает",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("T71: панель узнаёт строки по эмодзи-маркерам — цвет строки и привязка плана дошли", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_1", title: "Маруська", last_seen: new Date().toISOString() })
  const a = beginAgent(l, { input: { agent: "general", description: "work" }, ref: "c1", home: "ses_1" })
  a.began_at = new Date(Date.now() - 5 * 60000).toISOString()
  a.eta_min = 30

  const p = project(l)
  const html = renderConsoleHtml(p.ui, l.updated_at, p.agents)
  const marks = /const MARKS = ([^;]*);/.exec(html)
  assert.ok(marks, "маркеры палитр уехали в страницу")
  const parsed = JSON.parse(marks![1]) as { tab: string[]; bot: string[] }
  assert.deepEqual(parsed.tab, ["🤖", ...INSTANCE_EMOJI], "строка инстанса: свой эмодзи, иначе 🤖")
  assert.deepEqual(parsed.bot, ["▸", ...DAEMON_EMOJI], "строка демона: свой персонаж, иначе ▸")

  const lines = p.ui.split("\n")
  const idx = lines.findIndex((x) => x.startsWith(`      ${DAEMON_EMOJI[0]} `))
  assert.ok(idx > 0, "строка демона с эмодзи-префиксом в панели")
  const eta = JSON.parse(/const ETA = (\{[^;]*\});/.exec(html)![1]) as Record<string, { t0: number; eta: number }>
  assert.equal(eta[String(idx)]?.t0, Date.parse(a.began_at), "план привязан к его строке (по id, а не позиции)")
  assert.equal(eta[String(idx)]?.eta, a.eta_min, "и сам план доехал до тикающего отсчёта")
  assert.ok(html.includes('cls = "bot"'), "цвет строки демона в шаблоне остался")
})

// ------------------------------------------- T74: пакет правок 07.10 --------

// Голос страницы: выполняем клиентский скрипт панели на минимальном DOM-стабе
// и читаем, что реально нарисует wrap.innerHTML — статические проверки текста
// не видят ни обёртки бара, ни таймера, вшитого в строку вкладки.
function paneBody(html: string): string {
  const src = /<script>([\s\S]*)<\/script>/.exec(html)?.[1]
  assert.ok(src, "скрипт панели вшит в страницу")
  const wrap = {
    innerHTML: "",
    appendChild(el: { outerHTML: string }): unknown {
      this.innerHTML += (this.innerHTML ? "\n" : "") + el.outerHTML // как прежний join("\n")
      return el
    },
  }
  const document = {
    getElementById: () => wrap,
    createElement: () => {
      const cell = {
        className: "",
        innerHTML: "",
        get outerHTML(): string {
          return `<div class="${this.className}">${this.innerHTML}</div>`
        },
      }
      return cell
    },
    querySelectorAll: () => [],
  }
  new Function("document", "setInterval", src!)(document, () => 0) // tickEta на загрузке, тикеров не оставляем
  return wrap.innerHTML
}

test("T74(1): строка вкладки — текущая задача с живым отсчётом («в задаче T… ⏱Nм»)", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_t74", title: "Маруська ПАКЕТ", model: "mimo-v2.6-flash", last_seen: new Date().toISOString() })
  upsertTab(l, { session_id: "ses_bare", title: "Вкладка без агента", last_seen: new Date().toISOString() })
  must(l, { op: "create", task: "текущая работа", session_ref: "ses_t74" }) // T1
  must(l, { op: "set_state", id: "T1", state: "DOING" })
  must(l, { op: "create", task: "ждёт в очереди", session_ref: "ses_t74" }) // T2
  must(l, { op: "create", task: "взята в работу", session_ref: "ses_bare" }) // T3
  must(l, { op: "set_state", id: "T3", state: "DOING" })
  const a = beginAgent(l, { input: { agent: "general", description: "[T1] work" }, ref: "ses_w1", home: "ses_t74" })
  a.began_at = new Date(Date.now() - 8 * 60000).toISOString()
  a.eta_min = 30 // осталось 22

  const p = project(l)
  const lines = p.ui.split("\n")
  const idx = identityOf(p.ui, "Маруська ПАКЕТ")
  const block74 = instanceBlock(lines, idx)
  const who74 = block74[1] // ось-1 КТО·ЧЕМ·КАК (T156)
  const work74 = block74[2] // ось-2 ДЕЛО·МЕРИЛО·ВРЕМЯ — «в задаче» здесь
  assert.ok(work74.includes("в задаче T1 ⏱22:00"), `текущая задача с остатком плана (T85 mm:ss): ${work74}`)
  assert.ok(work74.indexOf("в задаче T1") < work74.indexOf("["), "T156: текущая задача — первая в оси-2, шлейф задач после")
  // T157: время HH:MM на оси-1 перед статусом (последнее слово)
  assert.match(who74, /\d{2}:\d{2} · работает ⏱$/, `ось-1: время + статус: ${who74}`)
  assert.ok(!lines[idx].includes("mimo-v2.6-flash"), "ось идентичности не смешана с параметрами")

  // текущая задача без живого агента — задача видна, отсчёт не выдумывается
  const bare = workOf(lines, identityOf(p.ui, "Вкладка без агента"))
  assert.ok(bare.includes("в задаче T3"), `DOING и без агента читается: ${bare}`)
  assert.ok(!/в задаче T3 ⏱/.test(bare), "базы для отсчёта нет — ⏱ не рисуется")

  // панель: T99 block format — ось состояния вкладки "Маруська ПАКЕТ" в ETA (matches "в задаче T1"),
  // демон в ETA-map. Занятая T3 axis line не в ETA. Итого 2 плана.
  const html = renderConsoleHtml(p.ui, l.updated_at, p.agents)
  const plans = JSON.parse(/const ETA = (\{[^;]*\});/.exec(html)![1]) as Record<string, { t0: number; eta: number }>
  assert.equal(Object.keys(plans).length, 2, "тикают демон + ось состояния вкладки Маруська ПАКЕТ; ось Вкладки без агента и занятая T3 не в ETA (T99 block format)")

  // Demon line gets plan
  const demonIdx = lines.findIndex((x) => x.startsWith("      ") && x.includes(demonName(a.id)))
  assert.ok(demonIdx >= 0, "демон найден")
  assert.equal(plans[String(demonIdx)]?.t0, Date.parse(a.began_at), "демон в ETA-map (t0)")

  // Instance work axis for "Маруська ПАКЕТ" gets plan (matches "в задаче T1")
  // T156: «в задаче» на оси-2 → голова + ось-1 + ось-2 = paketIdx + 2
  const paketIdx = identityOf(p.ui, "Маруська ПАКЕТ")
  const stateAxisIdx = paketIdx + 2
  assert.equal(plans[String(stateAxisIdx)]?.t0, Date.parse(a.began_at), "ось-2 Маруська ПАКЕТ в ETA-map (t0)")

  // Occupied task T3 axis line has mm:ss in UI but not in ETA-map (T99 block format)
  const busy3Idx = lines.findIndex((x) => x.includes(`🔒${a.id} работает`))
  assert.ok(busy3Idx >= 0, "занятая T3 найдена")

  const div = paneBody(html).split("\n").find((x) => x.includes("в задаче T1"))!
  assert.ok(div.includes(`data-t0="${Date.parse(a.began_at)}"`), `таймер вшит в строку: ${div}`)
  assert.ok(div.includes('data-eta="30"'), "план в data-eta — тикер пересчитает остаток каждую секунду")
})

test("T74(2): занятая строка ⚡ ЗАДАЧИ несёт остаток плана занятого агента", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "занятая задача" }) // T1 → ⚡ ЗАДАЧИ
  const a = beginAgent(l, { input: { agent: "general", description: "[T1] work" }, ref: "ses_o1" })
  a.began_at = new Date(Date.now() - 10 * 60000).toISOString()
  a.eta_min = 30 // осталось 20

  const ui = project(l).ui
  const headerIdx = ui.split("\n").findIndex((x) => x.startsWith("  ● [T1]"))
  const busyAxis = ui.split("\n")[headerIdx + 1] || ""
  assert.ok(busyAxis.includes(` 🔒${a.id} работает ⏱20:00`), `занятость (T63) + остаток mm:ss (T85): ${busyAxis}`)

  // settle обрывает план: у завершённого отсчёта нет (видно, что ждать только от живых)
  settleAgent(l, "completed", "ses_o1")
  const finUi = project(l).ui
  const finHeaderIdx = finUi.split("\n").findIndex((x) => x.startsWith("  ● [T1]"))
  const finAxis = finUi.split("\n")[finHeaderIdx + 1] || ""
  assert.ok(finAxis.includes(`${a.id} завершил`), `занятость остаётся: ${finAxis}`)
  assert.ok(!/⏱\+?\d/.test(finAxis), `у завершённого нет обратного отсчёта: ${finAxis}`)
})

test("T74(4): к строке задачи — вкладка-владелец (session_ref → имя): у какой Маруськи в работе", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_own", title: "Маруська ГЛАВНАЯ", last_seen: new Date().toISOString() })
  must(l, { op: "create", task: "в работе у Маруськи", session_ref: "ses_own" }) // T1
  must(l, { op: "set_state", id: "T1", state: "DOING" })
  must(l, { op: "create", task: "в её очереди", session_ref: "ses_own" }) // T2
  must(l, { op: "create", task: "чужая без привязки" }) // T3

  const lines = project(l).ui.split("\n")
  const doing = lines.find((x) => x.startsWith("  ● [T1]"))!
  assert.ok(doing.includes(" · у 🤖 Маруська ГЛАВНАЯ"), `вкладка-владелец на строке В РАБОТЕ: ${doing}`)
  assert.ok(doing.indexOf("в работе у Маруськи") < doing.indexOf("у 🤖"), "текст задачи раньше инстанса")
  const queue = lines.find((x) => x.startsWith("  ● [T2]"))!
  assert.ok(queue.includes(" · у 🤖 Маруська ГЛАВНАЯ"), `строка ⚡ ЗАДАЧИ тоже несёт владельца: ${queue}`)
  const orphan = lines.find((x) => x.startsWith("  ● [T3]"))!
  assert.ok(!orphan.includes("у 🤖"), `привязки нет — инстанс не выдумывается: ${orphan}`)
})

test("T74(5): бар в панели обёрнут в .bar — принудительно тонкий, цвет наследует строку", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_bar", title: "Жирная строка", last_seen: new Date().toISOString() })
  must(l, { op: "create", task: "фича", session_ref: "ses_bar" }) // T1 — бар у строки инстанса
  must(l, { op: "create", task: "шаг", parent: "T1", session_ref: "ses_bar" }) // T2 — её задача тоже
  must(l, { op: "set_state", id: "T2", state: "DONE", verification: "v" })

  const p = project(l)
  assert.ok(p.ui.includes("▰▰▱▱▱ 1/2"), `бар в проекции: ${p.ui.split("\n").find((x) => x.includes("▰"))}`)
  const html = renderConsoleHtml(p.ui, l.updated_at, p.agents)
  // CSS: только жирность снимается принудительно, ЦВЕТ НЕ задаётся —
  // глифы наследуют цвет строки (.tab оранжевый, .sec синий, .bot фиолетовый…)
  assert.ok(html.includes(".bar { font-weight:normal; }"), "стиль .bar вшит в панель")
  assert.ok(!/\.bar\s*\{[^}]*color/.test(html), "цвет бара не задаётся — он у строки")

  // клиентский скрипт оборачивает токен бара (глифы + счётчик) в <span class="bar">
  assert.ok(
    html.includes("/([▰▱]{5})\\s+\\d+\\/\\d+/, '<span class=\"bar\">"),
    "токен бара оборачивается в скрипте",
  )
  const div = paneBody(html).split("\n").find((x) => x.includes("▰▰▱▱▱"))!
  assert.ok(div.startsWith('<div class="tab'), `строка инстанса остаётся жирной .tab: ${div}`)
  assert.ok(
    div.includes('<span class="bar">▰▰▱▱▱ 1/2</span>'),
    `бар обёрнут и выделен из жирности строки: ${div}`,
  )
})

// ------------------------------------------- T60: канал панели -------------
// Голос страницы на своём DOM-стабе: клик по строке инстанса и кнопка ⚡
// реально шлют POST на localhost-сервер плагина (канал T60) — не «где-то в HTML».
type StubEl = Record<string, any>

function paneChannel(html: string): {
  body: string
  ch: { textContent: string }
  cells: StubEl[]
  calls: { url: string; method: string; body: string | null }[]
} {
  const src = /<script>([\s\S]*)<\/script>/.exec(html)?.[1]
  assert.ok(src, "скрипт панели вшит в страницу")
  const calls: { url: string; method: string; body: string | null }[] = []
  const cells: StubEl[] = []
  const make = (tag: string): StubEl => {
    const cell: StubEl = {
      tag,
      className: "",
      innerHTML: "",
      textContent: "",
      title: "",
      type: "",
      style: {} as Record<string, string>, // d.style.cursor при включении drag после проба
      classList: {
        add() {},
        remove() {},
        toggle() {},
        contains: () => false,
      }, // T106: flash() кнопки ⚡ дёргает classList.toggle в микротаске после клика
      dataset: {} as Record<string, string>,
      listeners: {} as Record<string, (ev: StubEl) => void>,
      children: [] as StubEl[],
      setAttribute(k: string, v: string) {
        this.dataset[k.replace(/^data-/, "")] = v // в стабе атрибуты живут в dataset
      },
      addEventListener(name: string, fn: (ev: StubEl) => void) {
        this.listeners[name] = fn
      },
      appendChild(child: StubEl) {
        this.children.push(child)
        return child
      },
      get outerHTML(): string {
        const ds = Object.entries(this.dataset)
          .map(([k, v]) => ` data-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}="${v}"`)
          .join("")
        const kids = this.children.map((c) => c.outerHTML).join("")
        return `<${this.tag}${this.className ? ` class="${this.className}"` : ""}${ds}>${this.innerHTML}${kids}</${this.tag}>`
      },
    }
    cells.push(cell)
    return cell
  }
  const wrap = make("div")
  const ch = { textContent: "", style: { color: "" } }
  const documentStub = {
    getElementById: (id: string) => (id === "wrap" ? wrap : ch),
    createElement: (tag: string) => make(tag),
    createTextNode: (text: string) => ({ outerHTML: text, textContent: text }),
    querySelectorAll: () => [],
  }
  const fetchStub = (url: string, opts?: { method?: string; body?: string }) => {
    calls.push({ url, method: opts?.method ?? "GET", body: opts?.body ?? null })
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
  }
  // T106: setTimeout/clearTimeout заглушены — таймеры кнопки ⚡ (сброс глифа
  // 1.4с, abort 4с) не стреляют после теста и не держат event loop (иначе
  // unhandled rejection после конца теста валит весь файл).
  new Function("document", "setInterval", "setTimeout", "clearTimeout", "fetch", src!)(
    documentStub,
    () => 0,
    () => 0,
    () => {},
    fetchStub,
  )
  return { body: wrap.innerHTML, ch, cells, calls }
}

test("T60: канал вшит в панель — порт, session_id строк инстансов, клик → /blink, ⚡ → /wake", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_own", title: "Маруська СВОЯ", last_seen: "2026-10-07T08:00:00.000Z" })
  upsertTab(l, { session_id: "ses_other", title: "Маруська СОСЕДКА", last_seen: "2026-10-07T07:00:00.000Z" })
  const p = project(l)
  const ids = projectTabs(l).map((t) => t.session_id)
  const html = renderConsoleHtml(p.ui, l.updated_at, p.agents, null, { port: 45111, tabIds: ids })

  assert.ok(html.includes("const PORT = 45111;"), "порт localhost-сервера вшит в страницу")
  const embedded = JSON.parse(/const TABIDS = (\[[^\]]*\]);/.exec(html)![1]) as string[]
  assert.deepEqual(embedded, ids, "session_id строк инстансов доехали в порядке строк проекта")
  assert.ok(html.includes('fetch(CH + "/probe?from=panel")'), "живой проб («fetch дошёл») шлёт сама страница")
  assert.ok(html.includes("канал 127.0.0.1:45111 · проверяю…"), "подвал знает про канал")

  const pane = paneChannel(html)
  assert.ok(
    pane.calls.some((c) => c.method === "GET" && c.url.endsWith("/probe?from=panel")),
    "проб канала реально ушёл при отрисовке",
  )
  const wired = pane.cells.filter((c) => c.dataset.ses)
  assert.equal(wired.length, 2, "каждая строка инстанса получила свой session_id (шапка — нет)")
  // T83: блок инстанса многоосевой — адресат клика получает только его голова:
  // ось состояния session_id не ворует, иначе у соседней вкладки адресата не остаётся.
  const headOf = (title: string) => wired.find((c) => c.innerHTML.includes(title))
  assert.ok(headOf("Маруська СВОЯ"), "голова первой вкладки несёт свой адресат")
  assert.ok(headOf("Маруська СОСЕДКА"), "голова второй — свой: оси блоков session_id не крадут (T83)")
  // T120: строка-ось несёт смысловые группы «·» (span.g) — для проверки текста
  // теги снимаем, иначе разделитель «·» не соседствует со статусом.
  const plain = (c: { innerHTML: string }): string => c.innerHTML.replace(/<[^>]*>/g, "")
  const axes = pane.cells.filter((c) => /· (?:работает ⏱|ждёт ⏳|простаивает)(?: ·|$)/.test(plain(c)))
  assert.ok(axes.length >= 2, `оси-1 с честным статусом отрисованы (T156: статус в конце оси-1): ${axes.length}`)
  assert.equal(
    axes.filter((c) => c.dataset.ses).length,
    0,
    "ось состояния клик и ⚡ не получает — адресат только у головы блока",
  )
  const row = wired.find((c) => c.dataset.ses === ids[0])!
  assert.equal(row.className, "tab", "строка осталась строкой инстанса")
  const btn = row.children.find((c) => c.className === "wake")
  assert.ok(btn, "кнопка ⚡ отдельным элементом строки")
  assert.match(String(btn.title), /пробудить/, "кнопка ⚡ подписана — зрителю ясно, что она делает")

  // клики: строка → /blink (toggle мигания), кнопка ⚡ → /wake (synthetic)
  row.listeners.click({ target: row })
  btn.listeners.click({ target: btn, stopPropagation: () => {} })
  const posts = pane.calls.filter((c) => c.method === "POST")
  assert.equal(posts.length, 2, "оба клика дошли до канала")
  assert.match(posts[0].url, /\/blink$/, "клик по строке = toggle мигания")
  assert.equal(posts[0].body, JSON.stringify({ session_id: ids[0] }), "вторым адресатом — session_id строки")
  assert.match(posts[1].url, /\/wake$/, "кнопка ⚡ = пробуждение")
  assert.equal(posts[1].body, JSON.stringify({ session_id: ids[0] }))
})

test("T60: без канала панель честна — порт null, у строк нет session_id и кнопок", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_x", title: "Маруська ОДИНОКАЯ", last_seen: "2026-10-07T08:00:00.000Z" })
  const p = project(l)
  const html = renderConsoleHtml(p.ui, l.updated_at, p.agents)
  assert.ok(html.includes("const PORT = null;"), "канала нет — кнопки не рендерятся")
  assert.ok(html.includes("const TABIDS = []"), "и адресов у строк нет")

  const pane = paneChannel(html)
  assert.equal(pane.cells.filter((c) => c.dataset.ses).length, 0, "строкам нечего адресовать")
  assert.equal(pane.calls.filter((c) => c.method === "POST").length, 0, "кликов без канала не бывает")
  assert.match(pane.ch.textContent, /канал: нет/, "подвал говорит правду, а не рисует ✓")
})

test("T60: wake — synthetic вкладке со списком её незакрытых задач (session_ref + home)", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "своя открытая", session_ref: "ses_a" }) // T1
  must(l, { op: "create", task: "своя закрытая", session_ref: "ses_a" }) // T2
  must(l, { op: "set_state", id: "T2", state: "DONE", verification: "v" })
  must(l, { op: "create", task: "через демона (home)" }) // T3 — агент вкладки возьмёт её
  beginAgent(l, { input: { agent: "general", description: "[T3] work" }, ref: "ses_child", home: "ses_a" })

  assert.deepEqual(openTasksOf(l, "ses_a").map((t) => t.id), ["T1", "T3"], "свои + задачи её демонов, DONE не предлагается")
  const msg = wakeMessage(l, "ses_a")
  assert.match(msg, /незакрытых задач — 2/, "Founder видит, сколько есть что брать")
  assert.ok(msg.includes("[T1]") && msg.includes("[T3]"), "обе задачи поимённо в сообщении")
  assert.ok(!msg.includes("[T2]"), "закрытые не предлагаются — консоль = живое состояние")

  const idle = wakeMessage(l, "ses_stranger")
  assert.match(idle, /открытых задач за этой вкладкой нет/, "будим честно: брать нечего — это тоже ответ")
})

// ------------------------------------------- instance naming (T64) ---------
// Заказ Основателя 07.10: инстанс верхнего уровня = Маруська Гольденштерн
// (Андроид-дочь МаЯтрицы, Звезда Иронии и Контроля, люцифероватая девчушка-
// гений Luna) под путём logOS.runtime.LUNA; чайлды = ДЕМОНЫ с именем
// logOS.runtime.LUNA.demon-NNN (не ангелы и не general-NN).

test("T64/T83: строка инстанса = «<эмодзи> <имя>» — имя первым и целиком, без пути (правка Основателя 12:56)", () => {
  const l = freshLedger()
  upsertTab(l, {
    session_id: "ses_1",
    title: "Обсуждение бэклога",
    model: "mimo-v2.6-flash",
    last_seen: new Date().toISOString(),
  })
  const lines = project(l).ui.split("\n")
  const idRow = lines.find((x) => instanceRow(x))!
  assert.ok(idRow, `голова блока = эмодзи + имя: ${lines.slice(0, 4).join(" ⏎ ")}`)
  assert.equal(
    idRow,
    `  ${INSTANCE_EMOJI[0]} Обсуждение бэклога`,
    "имя идёт первым и целиком, префикс logOS.runtime.LUNA из рендера убран (T83), маркер 🤖 только у шапки секции (T83)",
  )
  assert.ok(!idRow!.includes(INSTANCE_PATH), "путь сессии панели не нужен — у всех строк он одинаковый и ничего не различает")

  // чужое эмодзи строки не отменяет голову — инстанс узнаётся по имени (фолбэк без эмодзи)
  l.tabs[0].emoji = "🐸"
  // без эмодзи палитры строка = отступ + имя (T83: фолбэк 🤖 только у шапки)
  const bare = project(l).ui.split("\n").find((x) => x.startsWith("  Обсуждение бэклога"))!
  assert.ok(bare.includes("Обсуждение бэклога") && !bare.includes("🐸"), `чужой эмодзи не доходит до панели: ${bare}`)
})

test("T64: демоны — logOS.runtime.LUNA.demon-NNN; general-NN в панель не попадает", () => {
  const l = freshLedger()
  const a1 = beginAgent(l, { input: { agent: "general", description: "[T1] work" }, ref: "c1" })
  const a2 = beginAgent(l, { input: { agent: "qc", description: "check" }, ref: "c2" })
  assert.equal(a1.label, "logOS.runtime.LUNA.demon-001", "имя записи агента = демон")
  assert.equal(a2.label, "logOS.runtime.LUNA.demon-002", "номер записи, три знака")
  assert.equal(a1.kind, "general", "вид спавна ушёл в kind — на нём держится ETA-история")
  assert.equal(a2.kind, "qc")
  assert.equal(learnEta([a1], "general"), 30, "вид спавна находится по kind, а не по label")

  const ui = project(l).ui
  const row = ui.split("\n").find((x) => daemonRow(x))!
  assert.ok(row.includes("logOS.runtime.LUNA.demon-001"), `демон в панели под своим именем: ${row}`)
  assert.ok(!ui.includes("general-1") && !ui.includes("qc-2"), "старые имена general-NN/qc-NN не показываются")
})

test("T64: мигация до-T64 записей — имя демона из номера, вид спавна сохранён", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-"))
  const file = join(dir, "state.json")
  try {
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        updated_at: "2026-10-07T00:00:00.000Z",
        tasks: [],
        agents: [
          {
            id: "A7",
            task_id: null,
            label: "general-7",
            state: "completed",
            session_ref: null,
            home: null,
            model: null,
            note: null,
            began_at: "2026-10-07T00:00:00.000Z",
            eta_min: 30,
            updated_at: "2026-10-07T00:10:00.000Z",
          },
        ],
        tabs: [],
      }),
      "utf8",
    )
    const led = loadLedger(file)
    assert.equal(led.agents[0].label, "logOS.runtime.LUNA.demon-007", "старое «general-7» → имя демона")
    assert.equal(led.agents[0].kind, "general", "вид спавна спасён для истории ETA")
    assert.equal(learnEta(led.agents, "general"), 10, "история до-T64 записей доступна новым спавнам")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("T64: personaTitle — титул top-сессии = Персона · Тема (порядок Т166, заказ Основателя)", () => {
  assert.equal(personaTitle("Обсуждение задач"), "Маруська Гольденштерн · Обсуждение задач")
  assert.equal(
    personaTitle("Маруська ЛУНА · Обсуждение задач"),
    "Маруська Гольденштерн · Обсуждение задач",
    "T86: прежний титул Маруськи распознан: персона впереди, тема сзади",
  )
  assert.equal(personaTitle("Маруська Гольденштерн · Тема"), "Маруська Гольденштерн · Тема", "новый порядок идемпотентен")
  assert.equal(personaTitle("Тема · Маруська Гольденштерн"), "Маруська Гольденштерн · Тема", "старый вид пересобирается: персона впереди")
  assert.equal(
    personaTitle("Статус «В РАБОТЕ» — что отображает · Маруська Гольденштерн · Маруська Гольденштерн"),
    "Маруська Гольденштерн · Статус «В РАБОТЕ» — что отображает",
    "T86: двойной хвост миграции схлопывается",
  )
  assert.equal(
    personaTitle("Маруська Гольденштерн · Маруська Гольденштерн"),
    "Маруська Гольденштерн",
    "T86: двойная персона без темы → одна",
  )
  assert.equal(personaTitle("Маруська Гольденштерн"), "Маруська Гольденштерн", "одна персона без темы не трогается")
  assert.equal(
    personaTitle("  Маруська ПЛЮС · Тест  "),
    "Маруська Гольденштерн · Тест",
    "обрезка и замена титула: персона впереди",
  )
  assert.equal(personaTitle(""), "", "пустое имя не выдумываем")
})

test("T87: personaTitle — эмодзи инстанса первым токеном (T87)", () => {
  // Базовые кейсы с эмодзи
  assert.equal(personaTitle("Обсуждение задач", "👩"), "👩 Маруська Гольденштерн · Обсуждение задач")
  assert.equal(personaTitle("Тема · Маруська Гольденштерн", "🧚"), "🧚 Маруська Гольденштерн · Тема", "старые данные пересобираются с эмодзи")
  assert.equal(personaTitle("Маруська Гольденштерн", "🧝"), "🧝 Маруська Гольденштерн", "персона без темы + эмодзи")

  // Снятие старого эмодзи (миграция T87: эмодзи может накопиться)
  assert.equal(personaTitle("👩 Обсуждение задач · Маруська Гольденштерн", "🧚"), "🧚 Маруська Гольденштерн · Обсуждение задач", "старый эмодзи снят, новый поставлен, порядок пересобран")
  assert.equal(personaTitle("🤖 Тема · Маруська Гольденштерн", "🧛"), "🧛 Маруська Гольденштерн · Тема", "фолбэк-эмодзи снят, порядок пересобран")

  // Без эмодзи — новый порядок
  assert.equal(personaTitle("Тема · Маруська Гольденштерн", null), "Маруська Гольденштерн · Тема")
  assert.equal(personaTitle("Тема · Маруська Гольденштерн", undefined), "Маруська Гольденштерн · Тема")

  // Пустой эмодзи — как без эмодзи
  assert.equal(personaTitle("Тема · Маруська Гольденштерн", ""), "Маруська Гольденштерн · Тема")
})

// ------------------------------------------------------- T85: эстимейт ------

// Голос страницы для отсчёта: исполняем скрипт панели на DOM-стабе, где .eta
// собираются из разметки — tickEta на загрузке пишет в textContent свой
// mm:ss-отсчёт. Статический текст секунды не доказывает: только прогон тикера.
function tickedEta(html: string): string[] {
  const src = /<script>([\s\S]*)<\/script>/.exec(html)?.[1]
  assert.ok(src, "скрипт панели вшит в страницу")
  const wrap = {
    innerHTML: "",
    appendChild(el: { outerHTML: string }): unknown {
      this.innerHTML += (this.innerHTML ? "\n" : "") + el.outerHTML // как прежний join("\n")
      return el
    },
  }
  interface EtaEl {
    dataset: Record<string, string>
    textContent: string
    style: Record<string, string>
  }
  const collect = (): EtaEl[] => {
    const out: EtaEl[] = []
    const re = /<span class="eta"([^>]*)>([^<]*)<\/span>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(wrap.innerHTML))) {
      const ds: Record<string, string> = {}
      const ar = /data-([\w-]+)="([^"]*)"/g
      let am: RegExpExecArray | null
      while ((am = ar.exec(m[1]))) ds[am[1]] = am[2]
      out.push({ dataset: ds, textContent: m[2], style: {} })
    }
    return out
  }
  let etaEls: EtaEl[] = [] // те объекты, в которые реально писал tickEta
  const document = {
    getElementById: () => wrap,
    createElement: () => {
      const cell = {
        className: "",
        innerHTML: "",
        get outerHTML(): string {
          return `<div class="${this.className}">${this.innerHTML}</div>`
        },
      }
      return cell
    },
    querySelectorAll: (sel: string) => {
      if (sel === ".eta") {
        etaEls = collect()
        return etaEls
      }
      return []
    },
  }
  new Function("document", "setInterval", src!)(document, () => 0)
  return etaEls.map((x) => x.textContent)
}

test("T85(1): инстанс — секунды mm:ss (шапка, строка состояния, занятая строка), тикер ведёт каждую секунду", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_t85", title: "Маруська T85", last_seen: new Date().toISOString() })
  must(l, { op: "create", task: "работа", session_ref: "ses_t85" }) // T1
  must(l, { op: "set_state", id: "T1", state: "DOING" })
  const a = beginAgent(l, { input: { agent: "general", description: "[T1] w" }, ref: "ses_e85", home: "ses_t85" })
  a.began_at = new Date(Date.now() - 5 * 60000).toISOString()
  a.eta_min = 30 // осталось 25:00

  const p = project(l)
  const lines = p.ui.split("\n")
  // (1) шапка: до дедлайна самого долгого живого агента — mm:ss уже в статике
  assert.match(
    lines[1] ?? "",
    /🤖 ИНСТАНСЫ · по времени \d+% · задачи \d+% \(\d+\/\d+\) · ⏳25:00 · ⏱5м/,
    `шапка несёт mm:ss: ${lines[1]}`,
  )
  // (2) ось-2 инстанса («в задаче» на ней, T156) — тот же формат
  const row = workOf(lines, identityOf(p.ui, "Маруська T85"))
  assert.ok(row.includes("в задаче T1 ⏱25:00"), `ось-2 в mm:ss: ${row}`)
  // (3) занятая строка задачи (T74(2)) — axis line has the countdown
  const busyIdx = lines.findIndex((x) => x.startsWith("  ● [T1]"))
  const busyAxis = lines[busyIdx + 1] || ""
  assert.ok(busyAxis.includes(`🔒${a.id} работает ⏱25:00`), `занятая строка в mm:ss: ${busyAxis}`)

  // панель: шапка + ось состояния (TIMERS) + занятая строка (ETA)
  // T99 block format: занятая строка axis line не попадает в ETA (regex матчит header, не axis)
  // но UI показывает mm:ss корректно. Проверяем, что HTML содержит data-атрибуты для тикера на других строках.
  const html = renderConsoleHtml(p.ui, l.updated_at, p.agents)
  assert.ok(html.includes("setInterval(tickEta, 1000)"), "тикер каждую секунду")
  // Проверяем, что даемон строка в HTML имеет data-атрибуты для тикера
  assert.ok(html.includes(`data-glyph="⏱"`), "демон строка имеет глиф отсчёта")
  assert.ok(html.includes("data-t0="), "таймер вшит в DOM")
  // T99: занятая строка axis line не обрабатывается (regex не матчит), её mm:ss в UI статичен до обновления
})

test("T85(2): батч-горизонт WAIT по волнам — шапка ⚡ ЗАДАЧИ с оговоркой семантики", () => {
  // волны: max внутри волны (параллельно), сумма между волнами — Σ не считаем;
  // планы и горизонт — в минутах (та же единица, что eta_min)
  assert.equal(batchHorizon([], 3), 0, "пустая очередь — горизонта нет")
  assert.equal(batchHorizon([5, 5, 5, 5], 2), 10, "равные планы: две волны по 5м")
  assert.equal(batchHorizon([30, 5, 5, 5], 2), 35, "длинная тянет свою волну: 30 + 5, не 15+15")
  assert.equal(batchHorizon([30, 5, 5, 5], 1), 45, "параллелизм 1 = честная последовательность (30+5+5+5)")
  assert.equal(batchHorizon([30, 20], 0), 50, "нулевая параллельность зажимается в 1 (не деление на ноль)")

  const l = freshLedger()
  must(l, { op: "create", task: "с историей" }) // T1
  must(l, { op: "create", task: "без истории" }) // T2
  must(l, { op: "create", task: "тоже без" }) // T3
  const hist = beginAgent(l, { input: { agent: "general", description: "[T1] work" }, ref: "ses_h" })
  hist.began_at = new Date(Date.now() - 10 * 60000).toISOString()
  settleAgent(l, "completed", "ses_h") // 10 мин истории → learnEta = 10

  const head = (): string => project(l).ui.split("\n").find((x) => x.startsWith("⚡ ЗАДАЧИ"))!
  assert.equal(
    head(),
    "⚡ ЗАДАЧИ · ~20:00 горизонт (волны ×1, не Σ)",
    "план T1 из истории (10м) + два дефолта очереди 5м; живых нет → ×1; оговорка в шапке",
  )

  // живые агенты задают параллелизм: волна из двух → [10,5] + [5]
  beginAgent(l, { input: { agent: "general", description: "w1" }, ref: "ses_w1" })
  beginAgent(l, { input: { agent: "general", description: "w2" }, ref: "ses_w2" })
  assert.equal(
    head(),
    "⚡ ЗАДАЧИ · ~15:00 горизонт (волны ×2, не Σ)",
    "по волнам: максимум внутри волны, сумма между — не Σ планов подряд",
  )
})

// ------------------------------------ model policy of instances (T66) ------
// Правка Основателя 07.10: инстанс (top-вкладка-оркестратор) = строго mimo,
// демоны-чайлды = строго nemotron; выбор модели — обучаемая статистика
// успех/провал, rate limit → резерв + кулдаун,
// «был рейт лимит, перезапусти» → сброс кулдаунов (op model_reset).
// Правка Основателя 22.10: демон/QC = GLM (старый nemotron 3-ultra снят:
// 6/8 мгновенных падений).
// Правка Основателя 24.10: цепочка ТРЁХ звеньев GLM → nemotron (3.5 Super VL,
// новая модель) → mimo (дефолт хвоста); резерв = следующее звено.

// ДЕКРЕТ Основателя 29.10.2026 ~10:45 (T142): «луна теперь только для гольфии!!!
// СУБАГЕНТЫ ТОЛЬКО ФРИ ЮЗАЮТ В СВОЁМ КАНАЛЕ ОПЕНКОДА: КОНСОЛЬ ИЛИ ГО».
// Детский пул = ТОЛЬКО *-free (суффикс -free в любом канале); luna вырезана по
// имени в обоих каналах (резерв Гольфии, ~/.config/opencode/agents/golfia.md не
// трогаем). Go-тройка подписки без -free — премиум, субагенту закрыта НАВСЕГДА
// (канон T132 «прем-инстанс → дети perClass в premium» отменён для субагентов).

test("T142: политика по умолчанию — цепочка GLM free → nemotron-vl free, только *-free", () => {
  assert.match(INSTANCE_MODEL, /mimo/, "инстанс = mimo (канал основателя, не трогаем — T142 п.4)")
  assert.ok(isFreeModel(DEMON_MODEL), "звено 1 = бесплатная модель (T142 п.2)")
  assert.match(DEMON_MODEL, /glm/, "звено 1 = GLM (заказ 22.10)")
  assert.ok(isFreeModel(NEMOTRON_MODEL), "звено 2 = бесплатная модель (T142 п.2)")
  assert.match(NEMOTRON_MODEL, /nemotron/, "звено 2 = nemotron-vl (vision, T123/T134)")
  assert.ok(!/luna/i.test(NEMOTRON_MODEL), "luna ВЫКИНУТА из слота (за Гольфией)")
  assert.deepEqual([...POLICY_MODELS], [DEMON_MODEL, NEMOTRON_MODEL], "детская цепочка = 2 *-free звена, премиум-INSTANCE из неё УБРАН (T142)")
  assert.equal(modelForKey("mimo-v2.6-flash"), INSTANCE_MODEL, "ключ вкладки → Go-модель (модель вкладки не перетирается)")
  assert.equal(modelForKey("glm-5.3-flash"), DEMON_MODEL)
  assert.equal(modelForKey("deepseek-v4.1-flash"), "opencode/deepseek-v4.1-flash-free", "free-пояс: ключ deepseek → консольная free")
  assert.equal(modelForKey("gpt-6-luna"), null, "luna в детском пуле мертва; Гольфия живёт вне субагентного пула")
  assert.equal(modelForKey("gpt-4o"), null, "чужая модель в политике не живёт")
  assert.equal(modelForKey("nemotron-3-ultra"), null, "старый 3-ultra выведен из пула (24.10)")

  const l = freshLedger()
  assert.equal(chooseChildModel(l), DEMON_MODEL, "без истории — дефолт звена 1 = GLM free")
  assert.equal(modelStats(l).length, 0, "таблица пуста, пока никто не отчитался")
  // леджер старой версии без поля models — не падает и не выдумывает историю
  assert.equal(modelStats({ version: 1, updated_at: "x", tasks: [], agents: [], tabs: [] }).length, 0)
})

test("T142: детский гард — только *-free любого канала, luna вырезана по имени", () => {
  for (const m of POLICY_MODELS) {
    assert.ok(isFreeModel(m), `субагентная модель строго *-free: ${m}`)
    assert.ok(!/luna/i.test(m), `ни одной luna в детском пуле: ${m}`)
  }
  // luna резервируется за Гольфией: гард режет её ПО ИМЕНИ в обоих каналах
  assert.equal(childModelAllowed("opencode-go/gpt-6-luna"), false, "luna на Go — за Гольфией")
  assert.equal(childModelAllowed("opencode/gpt-6-luna"), false, "luna на консоли — тоже не детская")
  // Премиум Go-тройки подписки — НЕ субагентская модель (T142 п.2: дети только free)
  assert.equal(childModelAllowed("opencode-go/mimo-v2.6-flash"), false, "премиум Go-mimo субагенту закрыт")
  assert.equal(childModelAllowed("opencode-go/glm-5.3-flash"), false, "премиум Go-GLM субагенту закрыт")
  assert.equal(childModelAllowed("opencode-go/deepseek-v4.1-flash"), false, "премиум Go-deepseek субагенту закрыт")
  assert.ok(childModelAllowed("opencode-go/beam-free"), "free в Go-канале легальна (гард не завязан на opencode/)")
  assert.ok(childModelAllowed(NEMOTRON_MODEL) && childModelAllowed(DEMON_MODEL), "цепочка проходит гард")
  assert.equal(childModelAllowed("opencode-go/gpt-4o"), false, "чужой премиум субагенту закрыт")
  // Канон «прем-инстанс → дети perClass в premium» (T132) ОТМЕНЁН: полюс не гард
  assert.ok(!POLICY_MODELS.includes(INSTANCE_MODEL), "INSTANCE_MODEL (Go-mimo) — не субагентная политика")
  assert.equal(modelPole(INSTANCE_MODEL), "premium", "INSTANCE = премиум по полюсу (канал основателя)")
  // рут-каталоги: nemotron-vl резолвится в свой дом (opencode/)
  assert.equal(
    modelForKey("nemotron-3.5-super-vl"),
    "opencode/nemotron-3.5-super-vl-free",
    "nemotron-vl физически живёт на opencode/",
  )
})

test("T142 страж-юнит: ВСЕ детские модели = *-free, ни одной luna; Гольфия вне пула", () => {
  assert.ok(CHILD_MODELS.length >= 2, `детский пул собран: ${CHILD_MODELS.join(", ")}`)
  assert.ok(CHILD_MODELS.every(childModelAllowed), "весь пул проходит гард")
  assert.ok(CHILD_MODELS.every(isFreeModel), `каждое звено детского пула — *-free: ${CHILD_MODELS.join(", ")}`)
  assert.ok(CHILD_MODELS.every((m) => !/luna/i.test(m)), "ни одной luna в пуле")
  for (const k of CHILD_KEYS) {
    assert.ok(childModelAllowed(CHILD_KEY_TO_MODEL[k]), `ключ ${k} резолвится в легальную детскую модель`)
    assert.ok(isFreeModel(CHILD_KEY_TO_MODEL[k]), `ключ ${k} резолвится в *-free`)
  }
  // Гольфия живёт вне субагентного пула (та самая luna — её единственный канал)
  assert.ok(!CHILD_KEYS.includes("gpt-6-luna"), "ключ luna в детской карте отсутствует")
  assert.ok(!CHILD_MODELS.some((m) => modelForKey("gpt-6-luna") === m), "никакая детская модель не резолвится в luna")
})

test("T142 страж v2: премиум Go-тройка и luna не проходят НИ ОДИН детский вход", () => {
  const l = freshLedger()
  const forbidden = [
    "opencode-go/mimo-v2.6-flash",
    "opencode-go/glm-5.3-flash",
    "opencode-go/deepseek-v4.1-flash",
    "opencode-go/gpt-6-luna",
    "opencode/gpt-6-luna",
  ]
  for (const m of forbidden) {
    assert.equal(childModelAllowed(m), false, `${m}: гард субагента закрыт`)
    assert.equal(modelUsable(l, m), false, `${m}: не пригодна субагенту`)
  }
  // preferred-пин на запрещённое не действует: выбор всё равно free
  const c = chooseModelByClass(l, "dev:small", "opencode-go/gpt-6-luna", [...POLICY_MODELS, ...FREE_POOL, ...forbidden])
  assert.ok(isFreeModel(c.model) && !/luna/i.test(c.model), `выбор под luna-пином = free (${c.model})`)
  // preferred Go-mimo у ребёнка не даёт премиум: пин вне free-цепочки → дефолт free
  const child = chooseChildModel(l, "opencode-go/mimo-v2.6-flash")
  assert.ok(isFreeModel(child) && !/luna/i.test(child), `Go-mimo-пин ребёнка → free-звено (${child})`)
})

test("T66: обучаемый выбор — статистика ведёт по цепочке звеньев", () => {
  const l = freshLedger()
  for (let i = 0; i < 4; i++) recordModelResult(l, DEMON_MODEL, false)
  assert.equal(chooseChildModel(l), NEMOTRON_MODEL, "демон(GLM) 0/4 против без данных (0.5) → следующее звено nemotron")

  for (let i = 0; i < 8; i++) recordModelResult(l, NEMOTRON_MODEL, false)
  assert.equal(chooseChildModel(l), DEMON_MODEL, "nemotron 0/8 тоже хуже безданных → хвост цепочки (2 звена) wrap к звену 1")

  const stats = modelStats(l)
  assert.equal(stats.find((s) => s.model === DEMON_MODEL)?.fail, 4, "счётчик провалов растёт")
  assert.equal(stats.find((s) => s.model === NEMOTRON_MODEL)?.fail, 8)
  assert.equal(recordModelResult(l, "some/other-model", true), null, "мимо политики не копится")
})

test("T66: rate limit → кулдаун: звено снимается с выбора, ребёнок уходит на следующее", () => {
  const l = freshLedger()
  const until = setModelCooldown(l, DEMON_MODEL, COOLDOWN_MS, 1000)
  assert.ok(until, "кулдаун выставлен")
  assert.equal(reserveModel(DEMON_MODEL), NEMOTRON_MODEL, "резерв = следующее звено (nemotron)")
  assert.equal(reserveModel(NEMOTRON_MODEL), DEMON_MODEL, "хвост из двух звеньев wrap к звену 1")
  assert.equal(reserveModel(INSTANCE_MODEL), DEMON_MODEL, "премиум-канал вне детской цепочки → первое звено, дети never/exclude")

  assert.equal(chooseChildModel(l, null, 1000 + 60_000), NEMOTRON_MODEL, "демон в кулдауне → резерв (nemotron)")
  assert.equal(chooseChildModel(l, null, 1000 + COOLDOWN_MS + 1), DEMON_MODEL, "окно истекло → снова дефолт")
  assert.equal(modelStats(l)[0].cooldown_until, until, "окно живёт в ledger")
})

test("T66: owner-pin уважается, пока не в кулдауне; всё в кулдауне — выбор не встаёт", () => {
  const l = freshLedger()
  assert.equal(chooseChildModel(l, DEMON_MODEL), DEMON_MODEL, "пин qc → GLM free проходит")
  setModelCooldown(l, DEMON_MODEL, COOLDOWN_MS, 0)
  assert.equal(chooseChildModel(l, DEMON_MODEL, 1), NEMOTRON_MODEL, "пин в кулдауне → резерв (nemotron)")

  for (let i = 0; i < 4; i++) recordModelResult(l, DEMON_MODEL, false)
  setModelCooldown(l, NEMOTRON_MODEL, COOLDOWN_MS, 0)
  assert.equal(chooseChildModel(l, null, 1), NEMOTRON_MODEL, "всё в кулдауне → выбор по статистике (nemotron 0.5 без данных выше GLM 0/4) — не стоп")
})

// ------------------- T120-конвейер: upstream-смерти гасят скоринг -------------
test("T153+: субагенты на GLM (декрет 15.11) — демон пинится, мёртвый эндпоинт не берётся", () => {
  const l = freshLedger()
  for (let i = 0; i < 10; i++) recordModelResult(l, NEMOTRON_MODEL, true)
  for (let i = 0; i < 6; i++) recordModelResult(l, NEMOTRON_MODEL, false, "upstream")
  // Декрет: субагенты — GLM, пока демон жив; история других моделей не берётся.
  assert.equal(chooseChildModel(l), DEMON_MODEL, "демон (GLM) пинится по декрету")
  setModelCooldown(l, DEMON_MODEL, COOLDOWN_MS, 0)
  assert.equal(chooseChildModel(l, null, 1), NEMOTRON_MODEL, "демон в кулдауне → резерв по скорингу (upstream ×2: безысторие честнее)")
})

test("T66: «был рейт лимит, перезапусти» — сброс кулдаунов, статистика для обучения остаётся", () => {
  const l = freshLedger()
  recordModelResult(l, DEMON_MODEL, true)
  setModelCooldown(l, DEMON_MODEL, COOLDOWN_MS, 1000)
  setModelCooldown(l, NEMOTRON_MODEL, COOLDOWN_MS, 1000)
  setModelCooldown(l, INSTANCE_MODEL, COOLDOWN_MS, 1000)
  bumpUpstreamCooldown(l, DEMON_MODEL, COOLDOWN_MS, 1000)
  assert.ok((modelStats(l).find((s) => s.model === DEMON_MODEL)?.upstream_streak ?? 0) > 0, "upstream-серия накоплена до сброса")

  assert.equal(resetModelCooldowns(l), 3, "все три кулдауна сняты")
  assert.equal(modelStats(l).find((s) => s.model === DEMON_MODEL)?.upstream_streak, 0, "явный reset обнуляет upstream-серию")
  assert.equal(chooseChildModel(l, null, 2000), DEMON_MODEL, "выбор вернулся к дефолту (звено 1 = GLM)")
  assert.equal(modelStats(l).find((s) => s.model === DEMON_MODEL)?.ok, 1, "статистика выжила")
  assert.equal(resetModelCooldowns(l), 0, "повторный сброс — no-op")
})

test("T66: isRateLimited ловит rate limit / 429 / лимит / model drop", () => {
  assert.equal(isRateLimited("Error: Rate limit exceeded"), true)
  assert.equal(isRateLimited("429 Too Many Requests"), true)
  assert.equal(isRateLimited("session.execution.failed (rate limit)"), true)
  assert.equal(isRateLimited("провайдер дропнул модель: model dropped"), true)
  assert.equal(isRateLimited("file not found"), false)
  assert.equal(isRateLimited(null), false)
  // T109: free-квота провайдера (диаг A100: «Free usage limit reached», 429 opencode Go)
  assert.equal(isRateLimited("Free usage limit reached. Subscribe to OpenCode Go"), true, "T109: квота = rate limit")
  assert.equal(isRateLimited('{"type":"error"} provider.quota 429'), true, "T109: provider.quota")
})

test("T109: errorTextOfPayload — причина из payload.error, иначе честное «»", () => {
  assert.equal(
    errorTextOfPayload({ error: { type: "provider.quota", status: 429, message: "Free usage limit reached" } }),
    "429 · provider.quota · Free usage limit reached",
    "кейс A100: статус + тип + текст одним хвостом",
  )
  assert.equal(errorTextOfPayload({ content: [] }), "", "ошибки нет → пусто (семантика upstream T97)")
  assert.equal(errorTextOfPayload(null), "", "payload отсутствует (контекст молчит) → пусто, не JSON-мусор")
  assert.equal(errorTextOfPayload({ error: "строковая ошибка" }), "", "чужая форма — не гадим")
  assert.equal(
    isRateLimited(errorTextOfPayload({ error: { status: 429, message: "Free usage limit reached" } })),
    true,
    "хвост из payload проходит в isRateLimited → кулдаун звена цепочки",
  )
})

// ----------------------------------------------------------- T84: автовыбор модели по классу задач -----
// Гипотеза Основателя 07.10: демоны могут и mimo, и nemotron — замерять эдиты/сек и
// общие показатели успеха на разные типы задач, постепенно выбирать более эффективную.

test("T84: taskClass — qc всегда qc, dev/research с размером декомпозиции", () => {
  const l = freshLedger()
  // qc task
  const qcTask = must(l, { op: "create", task: "QC check", owner: "qc" })
  assert.equal(taskClass(l, qcTask), "qc", "owner=qc → class=qc")
  // dev with no children → small
  const devSmall = must(l, { op: "create", task: "Dev small", owner: "dev" })
  assert.equal(taskClass(l, devSmall), "dev:small", "dev with no children → small")
  // dev with 3 children → large
  const devParent = must(l, { op: "create", task: "Dev parent", owner: "dev" })
  must(l, { op: "create", task: "child 1", parent: devParent.id })
  must(l, { op: "create", task: "child 2", parent: devParent.id })
  must(l, { op: "create", task: "child 3", parent: devParent.id })
  assert.equal(taskClass(l, devParent), "dev:large", "dev with 3 children → large")
  // research with 2 children → small
  const resParent = must(l, { op: "create", task: "Res parent", owner: "research" })
  must(l, { op: "create", task: "child a", parent: resParent.id })
  must(l, { op: "create", task: "child b", parent: resParent.id })
  assert.equal(taskClass(l, resParent), "research:small", "research with 2 children → small")
})

test("T84: recordModelResultByClass — per-class stats accumulate", () => {
  const l = freshLedger()
  recordModelResultByClass(l, DEMON_MODEL, "dev:small", true, 2.5)
  let stat = modelStats(l)[0]
  assert.ok(stat, "returns stat")
  assert.equal(stat.byClass?.["dev:small"]?.ok, 1, "ok count")
  assert.equal(stat.byClass?.["dev:small"]?.runs, 1, "runs count")
  assert.equal(stat.byClass?.["dev:small"]?.editsPerSecSum, 2.5, "editsPerSecSum")
  // Second run
  recordModelResultByClass(l, DEMON_MODEL, "dev:small", false, 1.0)
  stat = modelStats(l)[0]
  assert.equal(stat.byClass?.["dev:small"]?.ok, 1)
  assert.equal(stat.byClass?.["dev:small"]?.fail, 1)
  assert.equal(stat.byClass?.["dev:small"]?.runs, 2)
  assert.equal(stat.byClass?.["dev:small"]?.editsPerSecSum, 3.5)
  // Different class tracked separately
  recordModelResultByClass(l, DEMON_MODEL, "qc", true, 5.0)
  stat = modelStats(l)[0]
  assert.equal(stat.byClass?.["qc"]?.ok, 1)
  assert.ok(!stat.byClass?.["qc"]?.fail)
})

// classModelScore is internal — tested via chooseModelByClass behavior

test("T84: chooseModelByClass — warmup fallback to T66; owner-pin respected; argmax by score", () => {
  const l = freshLedger()
  // T142 (декрет 29.10 ~10:45): pole для детского пула игнорируется — субагент
  // не может быть премиумом НИКОГДА; дефолтный (и «прем»-аргументный) выбор
  // идёт ТОЛЬКО по детскому free-пулу. Дефолт = голова цепочки.
  let choice = chooseModelByClass(l, "dev:small", null, POLICY_MODELS)
  assert.equal(choice.model, DEMON_MODEL, "no stats → T66 default (голова free-цепочки = GLM free)")
  assert.ok(choice.reason.includes("T66-default"), "reason mentions T66-default: " + choice.reason)
  // Механика owner-pin: pole «premium» мусорный — выбор всё равно детский free.
  choice = chooseModelByClass(l, "qc", DEMON_MODEL, POLICY_MODELS, Date.now(), "premium")
  assert.equal(choice.model, DEMON_MODEL, "owner-pin qc → GLM free (pole игнорируется, T142)")
  assert.ok(choice.reason.includes("owner-pin"), "reason mentions owner-pin")
  // Build stats: nemotron better on dev:small
  for (let i = 0; i < 3; i++) recordModelResultByClass(l, NEMOTRON_MODEL, "dev:small", true, 5.0)
  for (let i = 0; i < 3; i++) recordModelResultByClass(l, DEMON_MODEL, "dev:small", false, 1.0)
  // FIX flake: shouldReexamine сидируется от ledger.updated_at (wall-clock из
  // freshLedger) → «тихое» значение (та же стратегия, что в тесте all-in-cooldown).
  l.updated_at = "2026-10-07T12:00:00.000Z"
  choice = chooseModelByClass(l, "dev:small", null, POLICY_MODELS)
  assert.equal(choice.model, NEMOTRON_MODEL, "nemotron wins on dev:small")
  assert.ok(choice.reason.includes("auto: nemotron-3.5-super-vl"), "reason shows auto: nemotron-vl (второе звено free-цепочки)")
  // qc class separate stats: демон(GLM) лучше
  for (let i = 0; i < 3; i++) recordModelResultByClass(l, DEMON_MODEL, "qc", true, 4.0)
  for (let i = 0; i < 3; i++) recordModelResultByClass(l, NEMOTRON_MODEL, "qc", false, 1.0)
  l.updated_at = "2026-10-07T12:00:00.000Z" // повторный пин: запись статов могла сдвинуть updated_at
  choice = chooseModelByClass(l, "qc", null, POLICY_MODELS, Date.now(), "premium")
  assert.equal(choice.model, DEMON_MODEL, "демон(GLM) wins on qc")
})

test("T84: chooseModelByClass — unavailable model filtered out; re-examine deterministic", () => {
  const l = freshLedger()
  // Make mimo better on dev:small
  for (let i = 0; i < 3; i++) recordModelResultByClass(l, INSTANCE_MODEL, "dev:small", true, 5.0)
  // But mimo not in availableModels
  const choice = chooseModelByClass(l, "dev:small", null, [DEMON_MODEL])
  assert.equal(choice.model, DEMON_MODEL, "unavailable mimo → демон(GLM): " + choice.reason)
  // Re-examine deterministic: same ledger/state → same decision
  const c1 = chooseModelByClass(l, "dev:small", null, POLICY_MODELS)
  const c2 = chooseModelByClass(l, "dev:small", null, POLICY_MODELS)
  assert.equal(c1.model, c2.model, "deterministic: same input → same output")
  assert.equal(c1.reason, c2.reason, "deterministic: same reason")
})

test("T84: formatModelClassToken — compact token for panel", () => {
  const l = freshLedger()
  assert.equal(formatModelClassToken(l, "dev:small"), "авто: T66-дефолт")
  for (let i = 0; i < 3; i++) recordModelResultByClass(l, NEMOTRON_MODEL, "dev:small", true, 2.0)
  assert.equal(formatModelClassToken(l, "dev:small"), "авто: nemotron-3.5-super-vl (3 набл.)")
})

test("T84: recordModelResultByClass rejects non-policy models", () => {
  const l = freshLedger()
  const result = recordModelResultByClass(l, "opencode/gpt-4o", "dev:small", true, 1.0)
  assert.equal(result, null, "non-policy model returns null")
  assert.equal(l.models?.length, 0, "no stat created for non-policy model")
})

test("T84: chooseModelByClass — all in cooldown → falls back to stats (not blocked)", () => {
  const l = freshLedger()
  // Fix updated_at to a value that avoids re-examine (deterministic)
  l.updated_at = "2026-10-07T12:00:00.000Z"
  // Put all policy child links (T142: 2 free звена) in cooldown
  setModelCooldown(l, DEMON_MODEL)
  setModelCooldown(l, NEMOTRON_MODEL)
  // But stats favor nemotron
  for (let i = 0; i < 3; i++) recordModelResultByClass(l, NEMOTRON_MODEL, "dev:small", true, 5.0)
  for (let i = 0; i < 3; i++) recordModelResultByClass(l, DEMON_MODEL, "dev:small", false, 1.0)
  const choice = chooseModelByClass(l, "dev:small", null, POLICY_MODELS, 0) // at=0 → cooldowns active
  // Should pick nemotron-vl based on stats despite cooldown (all in cooldown → pool=all)
  // Re-examine is deterministic; with this updated_at it should not trigger
  assert.equal(choice.model, NEMOTRON_MODEL, "all in cooldown → stats win: " + choice.reason)
})

test("T66: таблица моделей переживает save/load и чистит мусор старых версий", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-t66-"))
  try {
    const file = join(dir, "state.json")
    const l = freshLedger()
    recordModelResult(l, DEMON_MODEL, false)
    setModelCooldown(l, DEMON_MODEL)
    saveLedger(file, l)
    const back = loadLedger(file)
    assert.equal(back.models?.length, 1, "таблица доезжает до state.json")
    assert.equal(back.models?.[0].model, DEMON_MODEL)
    assert.equal(back.models?.[0].fail, 1)

    writeFileSync(file, JSON.stringify({ version: 1, tasks: [], agents: [], tabs: [] }), "utf8")
    assert.deepEqual(loadLedger(file).models, [], "поля не было (до-T66) → пустая таблица")

    writeFileSync(
      file,
      JSON.stringify({ version: 1, tasks: [], agents: [], tabs: [], models: { bogus: 1 } }),
      "utf8",
    )
    assert.deepEqual(loadLedger(file).models, [], "битое поле → пустая таблица, не отказ грузки")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// T88 (криш-безопасность леджера, урок инцидента 07.10 12:59: state.json
// обнулён на ФС при рестарте): атомарная запись — tmp → fsync → rename, хвоста
// .tmp не остаётся, перед replace предыдущая валидная версия живёт в .bak.
test("T88: атомарная запись — .tmp не остаётся, .bak держит предыдущую валидную версию", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-t88-"))
  try {
    const file = join(dir, "state.json")
    const l = freshLedger()
    assert.equal(apply(l, { op: "create", task: "первая задача" }).ok, true)
    saveLedger(file, l)
    assert.ok(existsSync(file), "main записан")
    assert.ok(!existsSync(file + ".tmp"), "tmp переименован — хвоста нет")
    assert.ok(!existsSync(file + ".bak"), "первый сейв: копировать ещё нечего")

    const v1 = readFileSync(file, "utf8") // снимок первой валидной версии
    const l2 = loadLedger(file)
    assert.equal(apply(l2, { op: "create", task: "вторая задача" }).ok, true)
    saveLedger(file, l2)
    assert.ok(existsSync(file + ".bak"), "перед replace текущий main скопирован в .bak")
    assert.equal(readFileSync(file + ".bak", "utf8"), v1, ".bak = прошлая валидная версия")
    assert.ok(!existsSync(file + ".tmp"), "и после второго сейва .tmp не остаётся")
    assert.equal(loadLedger(file).tasks.length, 2, "main — последняя версия")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// T88: инцидентный сценарий — битый main (149582 нуля на ФС) поднимается из
// .bak с явной пометкой в логе; оба файла битые → честный отказ, не пустой
// леджер (молчаливый freshLedger = повторная потеря данных).
test("T88: битый main → recovery из .bak с пометкой в логе; оба битые → отказ, не пустой леджер", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-t88b-"))
  try {
    const file = join(dir, "state.json")
    const l = freshLedger()
    assert.equal(apply(l, { op: "create", task: "первая задача" }).ok, true)
    saveLedger(file, l)
    const l2 = loadLedger(file)
    assert.equal(apply(l2, { op: "create", task: "вторая задача" }).ok, true)
    saveLedger(file, l2) // .bak = версия с одной задачей

    writeFileSync(file, "    битый main", "utf8")
    const logged: string[] = []
    const orig = console.error
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "))
    }
    let recovered: Ledger
    try {
      recovered = loadLedger(file)
    } finally {
      console.error = orig
    }
    assert.equal(recovered.tasks.length, 1, "поднято из .bak (там одна задача)")
    assert.ok(
      logged.some((x) => x.includes("LEDGER RECOVERED FROM BACKUP")),
      `явная пометка recovery в логе: ${logged.join(" | ")}`,
    )

    writeFileSync(file + ".bak", "тоже бито", "utf8")
    assert.throws(
      () => loadLedger(file),
      /refusing to start with empty ledger/,
      "оба файла битые → явный отказ, не пустой леджер",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// T90 (ZOMBIE-RECORD): решение зомби-ветки скана (index.ts вызывает
// zombieSettleReason для записей без ses_-рефа). Пункт (3) задачи:
// запись без рефа + задача DONE → скан закрывает; задача DOING → не трогает;
// без задачи решает возраст записи (2×SETTLE_IDLE_MS, фолбэк updated_at).
test("T90: zombieSettleReason — задача DONE закрывает, живая задача не трогает, возраст решает без задачи", () => {
  const now = Date.parse("2026-10-07T18:00:00Z")
  const rec = (began: string, updated: string, task_id?: string | null) => ({ task_id, began_at: began, updated_at: updated })

  // (а) задача DONE → закрываем, даже если запись свежая
  const byDone = zombieSettleReason(rec("2026-10-07T17:59:00Z", "2026-10-07T17:59:00Z", "T85"), { state: "DONE" } as Task, now)
  assert.ok(byDone?.includes("задача DONE"), `зомби-закрытие по DONE: ${byDone}`)

  // (б) задача DOING + свежая запись → НЕ трогаем (исполнитель может быть жив)
  assert.equal(
    zombieSettleReason(rec("2026-10-07T17:59:00Z", "2026-10-07T17:59:00Z", "T90"), { state: "DOING" } as Task, now),
    null,
    "живая задача + свежая запись → null",
  )

  // (в) задача DOING + запись старше 60 мин → закрываем по возрасту
  const byAge = zombieSettleReason(rec("2026-10-07T15:00:00Z", "2026-10-07T15:00:00Z", "T90"), { state: "DOING" } as Task, now)
  assert.ok(byAge?.includes("возраст >60мин"), `зомби-закрытие по возрасту: ${byAge}`)

  // (г) задачи нет (task_id null), began_at битый → фолбэк на updated_at
  const fallback = zombieSettleReason(rec("", "2026-10-07T15:00:00Z", null), undefined, now)
  assert.ok(fallback?.includes("возраст"), `фолбэк updated_at: ${fallback}`)

  // (д) граница: ровно 60 мин — ещё не зомби (строго строже)
  assert.equal(zombieSettleReason(rec("2026-10-07T17:00:00Z", "2026-10-07T17:00:00Z", null), undefined, now), null, "ровно 60 мин → null")
})

// T80: repo-level code velocity metric (calcRepoSpeed, parseNumstat, parseLsFiles, formatRepoSpeed)
test("T80: parseNumstat parses git diff --numstat output correctly", () => {
  const out = "10\t5\tfile1.ts\n3\t0\tfile2.md\n"
  const parsed = parseNumstat(out)
  assert.equal(parsed.additions, 13)
  assert.equal(parsed.deletions, 5)
})

test("T80: parseLsFiles computes language % by extension", () => {
  const out = "file1.ts\nfile2.ts\nfile3.md\nfile4.json\n"
  const pct = parseLsFiles(out)
  assert.equal(pct.TypeScript, 50)
  assert.equal(pct.Markdown, 25)
  assert.equal(pct.JSON, 25)
})

test("T80: calcRepoSpeed window < 60s → valid=false, linesPerSec=null", () => {
  const prev = { additions: 10, deletions: 5, at: 1000 }
  const curr = { additions: 20, deletions: 10, at: 1000 + 30_000 } // 30s later
  const speed = calcRepoSpeed(prev, curr)
  assert.equal(speed.valid, false)
  assert.equal(speed.linesPerSec, null)
  assert.equal(speed.additions, 20)
  assert.equal(speed.deletions, 10)
})

test("T80: calcRepoSpeed window >= 60s → valid=true, linesPerSec = Δlines/Δt", () => {
  const prev = { additions: 10, deletions: 5, at: 1000 }
  const curr = { additions: 30, deletions: 15, at: 1000 + 70_000 } // 70s later, Δlines=30, Δt=70s → ~0.43 lines/s
  const speed = calcRepoSpeed(prev, curr)
  assert.equal(speed.valid, true)
  assert.ok(speed.linesPerSec !== null && speed.linesPerSec > 0)
  // Δlines = (30+15) - (10+5) = 30, Δt = 70s → ~0.428 lines/s
  assert.ok(Math.abs(speed.linesPerSec! - 30 / 70) < 0.01)
})

test("T80: calcRepoSpeed first measurement (no prev) → valid=false, linesPerSec=null", () => {
  const curr = { additions: 10, deletions: 5, at: 1000 }
  const speed = calcRepoSpeed(null, curr)
  assert.equal(speed.valid, false)
  assert.equal(speed.linesPerSec, null)
  assert.equal(speed.additions, 10)
  assert.equal(speed.deletions, 5)
})

test("T80: formatRepoSpeed returns null when invalid or no data", () => {
  assert.equal(formatRepoSpeed(null), null)
  assert.equal(formatRepoSpeed({ additions: 10, deletions: 5, linesPerSec: null, editsPerSec: null, languagePct: null, measuredAt: 1000, windowStart: 1000, windowEnd: 1000, valid: false }), null)
})

test("T129: formatRepoSpeed returns formatted string when valid", () => {
  const speed = { additions: 15, deletions: 8, linesPerSec: 0.5, editsPerSec: null, languagePct: null, measuredAt: 1000, windowStart: 0, windowEnd: 1000, valid: true }
  const formatted = formatRepoSpeed(speed)
  assert.equal(formatted, "repo: +15 −8")
})

test("T80: project includes repoSpeed in instancesHeader when passed", () => {
  const l = freshLedger()
  // Need at least one tab for instances section to render
  upsertTab(l, { session_id: "ses_test", title: "Test Tab", model: "mimo", last_seen: new Date().toISOString() })
  const repoSpeed = { additions: 15, deletions: 8, linesPerSec: 0.5, editsPerSec: null, languagePct: null, measuredAt: Date.now(), windowStart: 0, windowEnd: Date.now(), valid: true }
  const p = project(l, null, undefined, repoSpeed)
  assert.ok(p.ui.includes("repo: +15 −8"), "repo sums shown in instances header (T129: без скоростей)")
})

// T80-fix (оркестратор 20:47): эдиты/сек = Δ затронутых файлов (строки numstat)
// / Δt в окне ≥60с. shape без files (старый prev) — не додумываем, null.
test("T80-fix: calcRepoSpeed — editsPerSec из Δ файлов; без files в shape → null", () => {
  const speed = calcRepoSpeed(
    { additions: 10, deletions: 5, files: 4, at: 0 },
    { additions: 40, deletions: 2, files: 7, at: 120_000 },
  )
  assert.equal(speed.valid, true)
  assert.ok(Math.abs((speed.linesPerSec ?? -1) - 27 / 120) < 1e-9, "строк/сек = Δ(add+del)/Δt")
  assert.ok(Math.abs((speed.editsPerSec ?? -1) - 3 / 120) < 1e-9, "эдитов/сек = Δфайлов/Δt")
  const noFiles = calcRepoSpeed(
    { additions: 1, deletions: 1, at: 0 },
    { additions: 5, deletions: 5, files: 9, at: 61_000 },
  )
  assert.equal(noFiles.valid, true)
  assert.equal(noFiles.editsPerSec, null, "prev без files — эдиты не считаются")
})

// T129 (декрет 29.10): шапка отдаёт только суммы — без строк/сек, эдитов/сек и языка.
test("T129: formatRepoSpeed — только суммы, без скоростей/языка", () => {
  const full = formatRepoSpeed({
    additions: 15, deletions: 8, linesPerSec: 0.5, editsPerSec: 0.4,
    languagePct: { TypeScript: 41.2, Markdown: 30.5, JSON: 28.3 },
    measuredAt: 1000, windowStart: 0, windowEnd: 1000, valid: true,
  })
  assert.equal(full, "repo: +15 −8")
  const bare = formatRepoSpeed({
    additions: 1, deletions: 0, linesPerSec: 1, editsPerSec: null, languagePct: null,
    measuredAt: 1000, windowStart: 0, windowEnd: 1000, valid: true,
  })
  assert.equal(bare, "repo: +1 −0", "форма одна — суммы")
})

// T86/T87-fix (оркестратор 20:47): строка инстанса в панели — РОВНО один эмодзи
// (титул сам несёт эмодзи T87 — палитра плюс его не дублирует) и один хвост
// персоны (stale-запись леджера с двойным хвостом рендерится схлопнутой).
test("T86/T87-fix: describeTab — без двойного эмодзи и с одним хвостом персоны", () => {
  const l = freshLedger()
  const mk = (title: string, emoji: string) => ({
    session_id: "ses_panel_1", title, model: "mimo", emoji,
    last_seen: new Date().toISOString(), agents: [],
  })
  const emojiCase = describeTab(mk("🧚 Обсуждение задач · Маруська Гольденштерн", "🧚") as never, l, null)
  assert.ok(emojiCase[0].includes("🧚 Обсуждение задач"), `эмодзи в строке: ${emojiCase[0]}`)
  assert.ok(!emojiCase[0].includes("🧚 🧚"), `двойного эмодзи быть не должно: ${emojiCase[0]}`)
  const tailCase = describeTab(
    mk("Обсуждение задач · Маруська Гольденштерн · Маруська Гольденштерн", "🧚") as never,
    l,
    null,
  )
  const tails = (tailCase[0].match(/· Маруська Гольденштерн/g) || []).length
  assert.equal(tails, 1, `хвост персоны ровно один: ${tailCase[0]}`)
  const plain = describeTab(
    mk("Обсуждение задач · Маруська Гольденштерн", "🧚") as never,
    l,
    null,
  )
  assert.ok(plain[0].includes("  🧚 Обсуждение задач"), `обычный титул не портится: ${plain[0]}`)
})

// T80-fix: эдиты/сек предпочтительно по editEvents (события пиши-инструмента
// из runtime) — Δevents важнее Δфайлов; сигналов нет вообще → null.
test("T80-fix: calcRepoSpeed — приоритет editEvents над Δфайлов", () => {
  const speed = calcRepoSpeed(
    { additions: 10, deletions: 5, files: 4, editEvents: 8, at: 0 },
    { additions: 40, deletions: 2, files: 5, editEvents: 20, at: 60_000 },
  )
  assert.equal(speed.valid, true)
  assert.ok(
    Math.abs((speed.editsPerSec ?? -1) - 12 / 60) < 1e-9,
    "Δevents=12 за 60с → 0.2 эдитов/сек (не Δfiles=1)",
  )
  const noSignals = calcRepoSpeed(
    { additions: 1, deletions: 1, at: 0 },
    { additions: 5, deletions: 5, at: 61_000 },
  )
  assert.equal(noSignals.valid, true)
  assert.equal(noSignals.editsPerSec, null, "ни файлов, ни событий — не додумываем")
})

// T81: per-instance code velocity metric (calcInstanceSpeed, §4.1-4.3)
test("T81: calcInstanceSpeed window < 60s → valid=false, linesPerSec=null, editsPerSec=null", () => {
  const prev: InstanceDiffSnapshot = { sessionId: "ses_test", additions: 10, deletions: 5, at: 0 }
  const curr: InstanceDiffSnapshot = { sessionId: "ses_test", additions: 20, deletions: 10, at: 30_000 }
  const events: InstanceEditEvent[] = [
    { sessionId: "ses_test", file: "a.ts", at: 10_000 },
    { sessionId: "ses_test", file: "b.ts", at: 20_000 },
  ]
  const speed = calcInstanceSpeed(prev, curr, events, 0)
  assert.equal(speed.valid, false)
  assert.equal(speed.linesPerSec, null)
  assert.equal(speed.editsPerSec, null)
  assert.equal(speed.windowStart, 0)
  assert.equal(speed.windowEnd, 30_000)
})

test("T81: calcInstanceSpeed window >= 60s → valid=true, linesPerSec = Δlines/Δt (clamped ≥0)", () => {
  const prev: InstanceDiffSnapshot = { sessionId: "ses_test", additions: 10, deletions: 5, at: 0 }
  const curr: InstanceDiffSnapshot = { sessionId: "ses_test", additions: 20, deletions: 10, at: 61_000 }
  const events: InstanceEditEvent[] = [
    { sessionId: "ses_test", file: "a.ts", at: 10_000 },
    { sessionId: "ses_test", file: "b.ts", at: 20_000 },
    { sessionId: "ses_test", file: "c.ts", at: 50_000 },
  ]
  const speed = calcInstanceSpeed(prev, curr, events, 0)
  assert.equal(speed.valid, true)
  // Δlines = (20+10) - (10+5) = 15, Δt = 61s → 15/61 ≈ 0.246
  assert.ok(speed.linesPerSec !== null)
  assert.ok(Math.abs((speed.linesPerSec ?? 0) - 15 / 61) < 1e-9, `linesPerSec = Δlines/Δt = 15/61: ${speed.linesPerSec}`)
  // Δedits: curr window [0, 61000] has 3 unique; prev window [0, 0] has 0 unique → Δedits = 3
  assert.ok(speed.editsPerSec !== null)
  assert.ok(Math.abs((speed.editsPerSec ?? 0) - 3 / 61) < 1e-9, `editsPerSec = Δedits/Δt = 3/61: ${speed.editsPerSec}`)
})

test("T81: calcInstanceSpeed first measurement (no prev) → valid=false, linesPerSec=null", () => {
  const curr: InstanceDiffSnapshot = { sessionId: "ses_test", additions: 10, deletions: 5, at: 61_000 }
  const events: InstanceEditEvent[] = [
    { sessionId: "ses_test", file: "a.ts", at: 10_000 },
    { sessionId: "ses_test", file: "b.ts", at: 20_000 },
  ]
  const speed = calcInstanceSpeed(null, curr, events, 0)
  assert.equal(speed.valid, false)
  assert.equal(speed.linesPerSec, null)
  assert.equal(speed.editsPerSec, null)
  assert.equal(speed.additions, 10)
  assert.equal(speed.deletions, 5)
  assert.equal(speed.windowStart, 0)
  assert.equal(speed.windowEnd, 61_000)
})

test("T81: calcInstanceSpeed clamps linesPerSec ≥ 0 (snapshot can go backwards per §4.5)", () => {
  const prev: InstanceDiffSnapshot = { sessionId: "ses_test", additions: 100, deletions: 50, at: 0 }
  const curr: InstanceDiffSnapshot = { sessionId: "ses_test", additions: 20, deletions: 10, at: 61_000 }
  const events: InstanceEditEvent[] = []
  const speed = calcInstanceSpeed(prev, curr, events, 0)
  assert.equal(speed.valid, true)
  // deltaLines = 30 - 150 = -120, clamped to null (not negative)
  assert.equal(speed.linesPerSec, null, "negative delta lines → null, not negative rate")
})

test("T81: calcInstanceSpeed editsPerSec = Δ unique sessionID|file / Δt", () => {
  const prev: InstanceDiffSnapshot = { sessionId: "ses_test", additions: 10, deletions: 5, at: 0 }
  const curr: InstanceDiffSnapshot = { sessionId: "ses_test", additions: 15, deletions: 8, at: 61_000 }
  const events: InstanceEditEvent[] = [
    { sessionId: "ses_test", file: "a.ts", at: 10_000 },
    { sessionId: "ses_test", file: "b.ts", at: 20_000 },
    { sessionId: "ses_test", file: "a.ts", at: 30_000 }, // duplicate file in same session
    { sessionId: "ses_test", file: "c.ts", at: 50_000 },
    { sessionId: "ses_other", file: "a.ts", at: 40_000 }, // different session, same file
  ]
  const speed = calcInstanceSpeed(prev, curr, events, 0)
  assert.equal(speed.valid, true)
  // unique in curr window [0, 61000]: ses_test|a.ts, ses_test|b.ts, ses_test|c.ts, ses_other|a.ts = 4
  // unique in prev window [0, 0]: none = 0
  // Δedits = 4 - 0 = 4
  assert.ok(speed.editsPerSec !== null)
  assert.ok(Math.abs((speed.editsPerSec ?? 0) - 4 / 61) < 1e-9, `editsPerSec = 4/61: ${speed.editsPerSec}`)
})

test("T81: calcInstanceSpeed events outside window not counted", () => {
  const prev: InstanceDiffSnapshot = { sessionId: "ses_test", additions: 10, deletions: 5, at: 0 }
  const curr: InstanceDiffSnapshot = { sessionId: "ses_test", additions: 20, deletions: 10, at: 100_000 }
  const events: InstanceEditEvent[] = [
    { sessionId: "ses_test", file: "a.ts", at: 10_000 },   // outside window (windowStart=40000)
    { sessionId: "ses_test", file: "b.ts", at: 50_000 },   // inside window
    { sessionId: "ses_test", file: "c.ts", at: 80_000 },   // inside window
    { sessionId: "ses_test", file: "d.ts", at: 110_000 },  // after curr.at
  ]
  const speed = calcInstanceSpeed(prev, curr, events, 40_000)
  assert.equal(speed.valid, true)
  // windowStart=40000, curr.at=100000 → events in [40000, 100000]: b.ts, c.ts = 2 unique
  // prev window [40000, 0] is empty since prev.at=0 < windowStart → 0 unique
  // dt = 100000 - 0 = 100000ms = 100s
  assert.ok(speed.editsPerSec !== null)
  assert.ok(Math.abs((speed.editsPerSec ?? 0) - 2 / 100) < 1e-9, `editsPerSec = 2/100: ${speed.editsPerSec}`)
})

test("T118: describeTab — строка «строк во времени» НИКОГДА не скрыта (канон 28.10)", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_speed", title: "Speed Tab", model: "mimo-v2.6-flash", last_seen: new Date().toISOString() })
  const tab0 = l.tabs[0]
  // Т118-канон: (1) строка всегда видна, даже в простое и при нуле; (2) суммы
  // за ВСЮ ЖИЗНЬ из durable-накопителей; (3) скорость = накопленная
  // эффективность работа/активное время; физический простой в знаменатель
  // НЕ входит. T129-правило «без +0 −0» переопределено каноном T118.
  const eff = ensureTabEff(tab0, new Date().toISOString())
  eff.active_ms = 20 * 60_000 // 20 минут активной работы
  eff.work_add = 100
  eff.work_del = 50
  const lines = describeTab(projectTabs(l)[0], l, null)
  const stateLine = lines[1] // T157: мерило на оси-1 (задач нет — оси-2 нет)
  assert.ok(stateLine.includes("+100 −50"), `lifetime sums visible: ${stateLine}`)
  assert.ok(stateLine.includes("7.5/мин"), `accumulated rate = 150 строк / 20 мин: ${stateLine}`)
  assert.ok(!stateLine.includes("строк/сек"), `no lines/sec (T129 остаётся): ${stateLine}`)
  // Простой: нет ни живых агентов, ни active — строка ВСЁ РАВНО на месте.
  const idle = describeTab(projectTabs(l)[0], l, null)[1]
  assert.ok(idle.includes("+100 −50"), `idle still shows the line: ${idle}`)
})

test("T118: describeTab — нулевая работа тоже видна (мерило постоянное) и без выдуманной скорости", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_lines", title: "Lines Only Tab", model: "mimo-v2.6-flash", last_seen: new Date().toISOString() })
  const tab = projectTabs(l)[0]
  const stateLine = describeTab(tab, l, null)[1] // T157: мерило на оси-1
  assert.ok(stateLine.includes("+0 −0"), `zero sums visible (никогда не скрыта): ${stateLine}`)
  assert.ok(!stateLine.includes("/мин"), `нет активного времени ≥1мин — дробь не выдумывается: ${stateLine}`)
})

test("T118: noteTabEffWork — Δ numstat копится, база в леджере (рестарт не дублирует, коммит не уводит в минус)", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_w", title: "W", last_seen: "2026-11-11T01:00:00Z" })
  const at = (m: number) => new Date(Date.parse("2026-11-11T02:00:00Z") + m * 60_000).toISOString()
  // Первый после рестарта замер: базы нет — только снимаем базу (дельту не выдумываем).
  noteTabEffWork(l, "ses_w", { additions: 500, deletions: 300 }, at(0))
  let eff = ensureTabEff(l.tabs[0], at(0))
  assert.equal(eff.work_add, 0, "первый замер без базы — дельта ноль, не весь кумулятив")
  noteTabEffWork(l, "ses_w", { additions: 600, deletions: 310 }, at(5))
  assert.equal(eff.work_add, 100, "Δ +100 строк")
  assert.equal(eff.work_del, 10, "Δ −10 строк")
  // Коммит: кумулятив «ушёл назад» — дельта клампится в ≥0.
  noteTabEffWork(l, "ses_w", { additions: 50, deletions: 20 }, at(10))
  assert.equal(eff.work_add, 100, "отрицательная дельта не уменьшает работу")
})

test("T118: накопители durable — save/load переживает активное время, работу и базу", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-t118-"))
  const file = join(dir, "state.json")
  try {
    const l = freshLedger()
    upsertTab(l, { session_id: "ses_eff", title: "тема · Маруська Гольденштерн", last_seen: "2026-11-11T01:00:00Z" })
    const eff = ensureTabEff(l.tabs[0], "2026-11-11T01:00:00Z")
    eff.active_ms = 42 * 60_000
    eff.work_add = 1234
    eff.work_del = 567
    eff.last_active = "2026-11-11T02:30:00Z"
    eff.base_add = 500
    eff.base_del = 300
    saveLedger(file, l)
    const back = loadLedger(file)
    const e2 = back.tabs[0].eff
    assert.ok(e2, "eff пережила roundtrip")
    assert.equal(e2!.active_ms, 42 * 60_000)
    assert.equal(e2!.work_add, 1234)
    assert.equal(e2!.work_del, 567)
    assert.equal(e2!.last_active, "2026-11-11T02:30:00Z")
    assert.equal(e2!.base_add, 500, "база Δ numstat переживает рестарт — дельта не дублируется")
    assert.equal(e2!.born_at, "2026-11-11T01:00:00Z")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("T118: flushTabEffActivity — пауза >EFF_GAP_MS делит интервалы (простой не в знаменателе), стык окон ≤GAP сшивается", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_a", title: "A", last_seen: "2026-11-11T01:00:00Z" })
  const entries = new Map<string, { ms: number; since: number; last: number }>()
  const BASE = Date.parse("2026-11-11T03:00:00Z")
  // Окно 1: события 03:00 → 03:10 (10 минут работы, копились по-событийно).
  entries.set("ses_a", { ms: 10 * 60_000, since: BASE, last: BASE + 10 * 60_000 })
  flushTabEffActivity(l, entries)
  let eff = ensureTabEff(l.tabs[0], "2026-11-11T01:00:00Z")
  assert.equal(eff.active_ms, 10 * 60_000, "работа окна 1 учтена")
  assert.equal(eff.last_active, new Date(BASE + 10 * 60_000).toISOString())
  // Окно 2 начинается через 40 минут тишины (>5 мин) — пауза НЕ считается.
  entries.set("ses_a", { ms: 5 * 60_000, since: BASE + 50 * 60_000, last: BASE + 55 * 60_000 })
  flushTabEffActivity(l, entries)
  assert.equal(eff.active_ms, 15 * 60_000, "пауза 40 мин выпала из знаменателя")
  // Окно 3: стык ≤EFF_GAP_MS — перемычка между окнами ДОБАВЛЯЕТСЯ (один интервал).
  entries.set("ses_a", { ms: 60_000, since: BASE + 56 * 60_000, last: BASE + 57 * 60_000 })
  flushTabEffActivity(l, entries)
  assert.equal(eff.active_ms, 15 * 60_000 + 60_000 + 60_000, "стык 1 мин сшит (56−55=1 ≤ GAP)")
  // Не-вкладки выбрасываются.
  entries.set("ses_child", { ms: 9 * 60_000, since: BASE, last: BASE })
  flushTabEffActivity(l, entries)
  assert.equal(eff.active_ms, 17 * 60_000, "запись исполнителя в леджер не попала")
  assert.equal(entries.size, 0, "карта аккаунта очищена")
})

test("T118: formatTabEff — всегда строка (простой не скрывает), дробь честная", () => {
  assert.equal(formatTabEff(null), "+0 −0", "нет накопителей — строка всё равно видна")
  assert.equal(formatTabEff({ born_at: "x", active_ms: 0, work_add: 0, work_del: 0, last_active: null, base_add: null, base_del: null }), "+0 −0", "ноль без выдуманной скорости")
  const eff: TabEff = { born_at: "x", active_ms: 20 * 60_000, work_add: 150, work_del: 50, last_active: null, base_add: null, base_del: null }
  assert.equal(formatTabEff(eff), "+150 −50 · 10/мин", "200 строк / 20 мин = 10/мин")
  const eff2: TabEff = { ...eff, active_ms: 15 * 60_000 }
  assert.equal(formatTabEff(eff2), "+150 −50 · 13/мин", "≥10/мин — целое")
})

// -------------------------------------------------------- T95: CPU monitor ---

test("T95: project() shows CPU WARNING (🟡) when cpuWarning=true and cpuPct >= 70", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_cpu", title: "CPU Test", model: "mimo-v2.6-flash", last_seen: new Date().toISOString() })
  const ui = project(l, null, undefined, null, null, true, false, 75).ui
  assert.ok(ui.includes("🟡 CPU 75% WARNING"), `CPU warning shown in instances header: ${ui.split("\n")[0]}`)
  assert.ok(ui.includes("🤖 ИНСТАНСЫ"), "instances section present")
})

test("T95: project() shows CPU HARD STOP (🔴) when cpuHardStop=true and cpuPct >= 90", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_cpu", title: "CPU Test", model: "mimo-v2.6-flash", last_seen: new Date().toISOString() })
  const ui = project(l, null, undefined, null, null, false, true, 92).ui
  assert.ok(ui.includes("🔴 CPU 92% HARD STOP"), `CPU hard stop shown in instances header: ${ui.split("\n")[0]}`)
  assert.ok(ui.includes("🤖 ИНСТАНСЫ"), "instances section present")
})

test("T95: project() shows no CPU indicator when both flags false", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_cpu", title: "CPU Test", model: "mimo-v2.6-flash", last_seen: new Date().toISOString() })
  const ui = project(l, null, undefined, null, null, false, false, 45).ui
  const header = ui.split("\n")[0]
  assert.ok(!header.includes("CPU"), `no CPU indicator in header when normal: ${header}`)
  assert.ok(ui.includes("🤖 ИНСТАНСЫ"), "instances section present")
})

test("T95: cpuGate() returns allow=false defer=false on hard stop (mocked via state)", () => {
  resetCpuState()
  // We can't easily mock probeCpu, but we can test the threshold logic by
  // checking the gate function directly with a controlled sample
  // Since probeCpu is non-deterministic, we test the update logic:
  
  // Mock a sample at 95% (hard stop) - both warning and hardStop should be true
  const hardStopSample: CpuSample = {
    pct: 95,
    cores: 4,
    dtMs: 3000,
    ts: Date.now(),
    raw: 95 * 4 * 30 // approximate
  }
  const hardStopStatus = updateCpuState(hardStopSample)
  assert.ok(hardStopStatus.hardStop, "hard stop active at 95%")
  assert.ok(hardStopStatus.warning, "warning also active at 95% (>= 70%)")
  
  resetCpuState()
  
  // Mock a sample at 75% (warning only)
  const warningSample: CpuSample = {
    pct: 75,
    cores: 4,
    dtMs: 3000,
    ts: Date.now(),
    raw: 75 * 4 * 30
  }
  const warningStatus = updateCpuState(warningSample)
  assert.ok(warningStatus.warning, "warning active at 75%")
  assert.ok(!warningStatus.hardStop, "no hard stop at 75%")
  assert.equal(warningStatus.peak, 75, "peak tracked")
})

test("T95: cpuGate() threshold hysteresis — warning stays until drop below 65% (70-5)", () => {
  resetCpuState()
  
  // Go to warning zone
  const s1 = updateCpuState({ pct: 72, cores: 4, dtMs: 3000, ts: Date.now(), raw: 72 * 4 * 30 })
  assert.ok(s1.warning, "warning at 72%")
  
  // Drop to 68% — still in hysteresis, warning should persist
  const s2 = updateCpuState({ pct: 68, cores: 4, dtMs: 3000, ts: Date.now(), raw: 68 * 4 * 30 })
  assert.ok(s2.warning, "warning persists at 68% (hysteresis: 70-5=65)")
  
  // Drop to 60% — warning should clear
  const s3 = updateCpuState({ pct: 60, cores: 4, dtMs: 3000, ts: Date.now(), raw: 60 * 4 * 30 })
  assert.ok(!s3.warning, "warning clears at 60% (below 65%)")
  
  resetCpuState()
  
  // Hard stop hysteresis: 90% -> stays until below 85%
  const hs1 = updateCpuState({ pct: 92, cores: 4, dtMs: 3000, ts: Date.now(), raw: 92 * 4 * 30 })
  assert.ok(hs1.hardStop, "hard stop at 92%")
  
  const hs2 = updateCpuState({ pct: 87, cores: 4, dtMs: 3000, ts: Date.now(), raw: 87 * 4 * 30 })
  assert.ok(hs2.hardStop, "hard stop persists at 87% (hysteresis: 90-5=85)")
  
  const hs3 = updateCpuState({ pct: 80, cores: 4, dtMs: 3000, ts: Date.now(), raw: 80 * 4 * 30 })
  assert.ok(!hs3.hardStop, "hard stop clears at 80% (below 85%)")
  assert.ok(hs3.warning, "warning still active at 80%")
})

// --------------------------------------------------------- T62: foreign sessions ---
// T62: foreign sessions collapsible section in renderConsoleHtml
test("T62: renderConsoleHtml includes collapsible foreign sessions section with blink on click", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_local", title: "Local Tab", model: "mimo", last_seen: new Date().toISOString() })
  
  const now = Date.now()
  const foreignSessions = [
    { session_id: "ses_foreign_1", title: "Foreign Session 1", last_seen: now - 2 * 60 * 1000 }, // 2 min ago - active
    { session_id: "ses_foreign_2", title: "Foreign Session 2", last_seen: now - 6 * 60 * 1000 }, // 6 min ago - stale
    { session_id: "ses_foreign_3", title: "Foreign Session 3", last_seen: now - 1 * 60 * 1000 }, // 1 min ago - active
  ]
  
  const p = project(l)
  const html = renderConsoleHtml(p.ui, l.updated_at, p.agents, null, null, l.tasks, foreignSessions)
  
  // Check foreign section is rendered (specific elements, not just word "foreign")
  assert.ok(html.includes('id="foreign"'), "foreign section container present")
  assert.ok(html.includes('id="foreign-header"'), "foreign header present")
  assert.ok(html.includes('id="foreign-list"'), "foreign list container present")
  assert.ok(html.includes("🌍 ЧУЖИЕ: 3 работают ▸"), "collapsed header shows total count")
  assert.ok(html.includes("(активно: 2)"), "header shows active count")
  assert.ok(html.includes("Foreign Session 1"), "active foreign session 1 listed")
  assert.ok(html.includes("Foreign Session 3"), "active foreign session 3 listed")
  // Stale session should not be in expanded list (only active shown when expanded)
  assert.ok(!html.includes("Foreign Session 2") || html.indexOf("Foreign Session 2") > html.indexOf("foreign-list"), "stale session only in 'all' summary, not in active list")
  
  // Check click handlers in JS for blink
  assert.ok(html.includes("foreignHeader.addEventListener"), "collapse/expand handler present")
  assert.ok(html.includes("foreignList.addEventListener"), "click delegation handler present")
  assert.ok(html.includes("fetch(CH + \"/blink\""), "blink POST to T60 channel present")
  assert.ok(html.includes("session_id"), "session_id passed in blink request")
  
  // Check active count logic: only sessions within TTL (5 min) are active
  const foreignSessionsAllActive = [
    { session_id: "ses_a", title: "A", last_seen: now - 1000 },
    { session_id: "ses_b", title: "B", last_seen: now - 1000 },
  ]
  const html2 = renderConsoleHtml(p.ui, l.updated_at, p.agents, null, null, l.tasks, foreignSessionsAllActive)
  assert.ok(html2.includes("(активно: 2)"), "all recent = all active")
  
  // Empty foreign sessions = no section
  const html3 = renderConsoleHtml(p.ui, l.updated_at, p.agents, null, null, l.tasks, [])
  assert.ok(!html3.includes('id="foreign"'), "no foreign section when empty array")
  
  const html4 = renderConsoleHtml(p.ui, l.updated_at, p.agents, null, null, l.tasks, undefined as never)
  assert.ok(!html4.includes('id="foreign"'), "no foreign section when undefined")
})

test("T62: foreign sessions tracked in ledger but never appear as tabs in projectTabs", () => {
  const l = freshLedger()
  // Add foreign sessions to ledger directly (simulating what index.ts does)
  l.foreign_sessions = [
    { session_id: "ses_foreign", title: "Foreign", last_seen: Date.now() },
  ]
  
  const tabs = projectTabs(l)
  // Foreign sessions should NOT appear in projectTabs (they only go to panel)
  assert.equal(tabs.length, 0, "foreign sessions not in projectTabs")
  
  // But they ARE passed to renderConsoleHtml via ledger.foreign_sessions
  const p = project(l)
  assert.ok(p.ui.includes("🤖 ИНСТАНСЫ") === false || !p.ui.includes("Foreign"), "foreign not in main UI sections")
})

test("T62: foreign sessions in ledger filtered by TTL on load", async () => {
  // Verify ledger sanitization filters foreign sessions by TTL (5 min)
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
  const { join } = await import("node:path")
  const { tmpdir } = await import("node:os")
  
  const dir = mkdtempSync(join(tmpdir(), "dev-console-t62-"))
  const file = join(dir, "state.json")
  try {
    const now = Date.now()
    writeFileSync(file, JSON.stringify({
      version: 1,
      updated_at: new Date().toISOString(),
      tasks: [],
      agents: [],
      tabs: [],
      foreign_sessions: [
        { session_id: "ses_fresh", title: "Fresh", last_seen: now - 1000 },      // within TTL
        { session_id: "ses_stale", title: "Stale", last_seen: now - 10 * 60 * 1000 }, // outside TTL
      ],
    }), "utf8")
    
    const loaded = loadLedger(file)
    // Only fresh foreign session should be loaded (TTL = 5 min)
    assert.equal(loaded.foreign_sessions.length, 1, "only fresh foreign session loaded")
    assert.equal(loaded.foreign_sessions[0].session_id, "ses_fresh", "stale filtered out by TTL")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("T104(1): loadLedger чистит foreign_sessions от своих вкладок", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-t104-"))
  const file = join(dir, "state.json")
  try {
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        updated_at: new Date().toISOString(),
        tasks: [],
        agents: [],
        tabs: [
          { session_id: "ses_own", title: "Своя", model: null, emoji: null, last_seen: new Date().toISOString() },
        ],
        foreign_sessions: [
          { session_id: "ses_own", title: "затесалась", last_seen: Date.now() },
          { session_id: "ses_other", title: "чужая", last_seen: Date.now() },
        ],
      }),
      "utf8",
    )
    const loaded = loadLedger(file)
    assert.deepEqual(
      loaded.foreign_sessions.map((f) => f.session_id),
      ["ses_other"],
      "своя вкладка вычищена из ЧУЖИХ уже при загрузке",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------ T104: заказ Основателя 09.10 ---
// (1) чужой = доказано: своя вкладка не уезжает в 🌍 ЧУЖИЕ;
// (2) раскрытие списка ЧУЖИЕ переживает meta-refresh (localStorage + hash);
// (3) обе строки времени панели не исчезают при пустой основе.

test("T104(1): чужой = доказано — normalizeDirPath / isForeignDirectory / isForeignSession", () => {
  const root = "C:\\Users\\banan\\Developer\\pipeline-setup"
  // путь неизвестен/пуст → чужойство не доказано → своя (как до T62)
  assert.equal(normalizeDirPath(undefined), null, "не-строка — нет пути")
  assert.equal(normalizeDirPath(""), null, "пустая строка — нет пути")
  assert.equal(normalizeDirPath("  \\  "), null, "только разделители — нет пути")
  assert.equal(isForeignDirectory(undefined, root), false, "нет пути → не доказан → своя")
  assert.equal(isForeignDirectory(null, root), false, "null — не доказан → своя")
  // нормализация: регистр, / vs \, хвостовые разделители — тот же путь
  assert.equal(isForeignDirectory("c:/users/banan/developer/pipeline-setup/", root), false, "регистр/слэши/хвост не делают чужим")
  assert.equal(isForeignDirectory("C:\\Users\\banan\\Developer\\pipeline-setup\\\\", root), false, "двойной хвостовой слэш — своя")
  // подпапка проекта — своя
  assert.equal(isForeignDirectory(`${root}\\DEV_CONSOLE`, root), false, "подпапка проекта — своя")
  // иная папка — доказанный чужой
  assert.equal(isForeignDirectory("J:\\KABALOT\\N00sphere", root), true, "иной корень — чужая")

  const tabs = [{ session_id: "ses_own", title: "Своя", model: null, emoji: null, last_seen: new Date().toISOString() }]
  // реестр вкладок главнее путей: своя вкладка даже с чужим путём — своя
  assert.equal(isForeignSession("ses_own", "J:\\OTHER\\proj", root, tabs), false, "запись в реестре = своя, путь не судит")
  // неизвестный путь у незарегистрированной сессии — не доказан → своя
  assert.equal(isForeignSession("ses_new", undefined, root, tabs), false, "путь молчит → не чужая")
  // незарегистрированная + доказанный чужой путь → чужая
  assert.equal(isForeignSession("ses_new", "J:\\KABALOT\\N00sphere", root, tabs), true, "путь доказал иную папку")
})

test("T104(1): dropOwnFromForeign — своя вкладка не может стоять в 🌍 ЧУЖИЕ", () => {
  const tabs = [{ session_id: "ses_own", title: "Своя", model: null, emoji: null, last_seen: new Date().toISOString() }]
  const foreign = [
    { session_id: "ses_own", title: "затесалась", last_seen: Date.now() },
    { session_id: "ses_other", title: "чужая", last_seen: Date.now() },
  ]
  assert.deepEqual(
    dropOwnFromForeign(foreign, tabs).map((f) => f.session_id),
    ["ses_other"],
    "своя запись вычищена, чужая осталась",
  )
  assert.deepEqual(dropOwnFromForeign(undefined, tabs), [], "нет списка — пусто, не краш")
  assert.deepEqual(
    dropOwnFromForeign([{ session_id: "ses_x" } as never, null as never], tabs).map((f) => f.session_id),
    ["ses_x"],
    "мусорные записи отбрасываются, валидные остаются",
  )
})

test("T104(3): шапка ИНСТАНСЫ без живых агентов не пропадает (план вместо отсчёта)", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_1", title: "Инстанс", last_seen: new Date().toISOString() })
  must(l, { op: "create", task: "работа" })
  assert.match(
    project(l).ui.split("\n")[1],
    /^🤖 ИНСТАНСЫ · по времени \d+% · задачи \d+% \(\d+\/\d+\) · ⏳~\d\d:\d\d план$/,
    "строка времени шапки на месте и без живых агентов (план открытого списка)",
  )
  // живых нет и открытых задач нет — отсчётов не выдумываем, шапка остаётся
  const l2 = freshLedger()
  upsertTab(l2, { session_id: "ses_1", title: "Инстанс", last_seen: new Date().toISOString() })
  must(l2, { op: "create", task: "работа" })
  must(l2, { op: "set_state", id: "T1", state: "DONE", verification: "v" })
  assert.equal(
    project(l2).ui.split("\n")[1],
    "🤖 ИНСТАНСЫ · по времени 100% · задачи 100% (1/1)",
    "базы нет — просто без ⏳, шапка есть; оба процента с подписями (T120(3))",
  )
})

test("T104(2): раскрытие списка ЧУЖИЕ переживает перезагрузку панели (localStorage + hash)", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_local", title: "Local Tab", model: "mimo", last_seen: new Date().toISOString() })
  const p = project(l)
  const html = renderConsoleHtml(p.ui, l.updated_at, p.agents, null, null, l.tasks, [
    { session_id: "ses_foreign", title: "Чужая", last_seen: Date.now() - 1000 },
  ])
  // память состояния: localStorage, фолбэк — location.hash (meta refresh 5с)
  assert.ok(html.includes('const FKEY = "lavk-console-foreign-expanded"'), "ключ памяти раскрытия")
  assert.ok(html.includes("localStorage.getItem(FKEY)"), "состояние читается до первых кликов")
  assert.ok(html.includes("localStorage.setItem(FKEY"), "переключение запоминается")
  assert.ok(html.includes("location.hash"), "фолбэк hash, когда localStorage закрыт (file://)")
  assert.ok(html.includes("function paintForeign()"), "единая отрисовка header/list из одной памяти")
  assert.ok(html.includes("function rememberForeign()"), "запись памяти при клике и после blink")
  assert.ok(html.includes("foreignHeader.addEventListener"), "клик по шапке есть")
  assert.ok(html.includes("foreignList.addEventListener"), "клик по строке (blink) есть")
  // чужих нет — секции и памяти нет
  const empty = renderConsoleHtml(p.ui, l.updated_at, p.agents, null, null, l.tasks, [])
  assert.ok(!empty.includes("lavk-console-foreign-expanded"), "без секции чужих память не рендерится")
})


// ------------------------------------------------------ T50: projectWorksheet ---

test("T50: projectWorksheet — пустой ledger отдаёт заглушку", () => {
  assert.equal(projectWorksheet(freshLedger()), "— worksheet empty —")
})

test("T50: projectWorksheet — строка несёт id · состояние · owner, дети через ↳", () => {
  const led = freshLedger()
  must(led, { op: "create", task: "Родительская задача" })
  must(led, { op: "create", task: "Дитя", parent: "T1" })
  must(led, { op: "set_state", id: "T1", state: "DOING", owner: "dev" })
  const ws = projectWorksheet(led)
  const lines = ws.split("\n").filter((x) => x.trim())
  // плотность: две задачи = две строки (родитель с ↳ детей, дитя — вложенной строкой)
  assert.equal(lines.length, 3, `две задачи + «следующее к диспатчу»: ${JSON.stringify(lines)}`)
  assert.match(lines[0], /^T1 \u00b7 .+ \u00b7 dev/, `id \u00b7 глиф \u00b7 owner в строке: ${lines[0]}`)
  assert.ok(lines[0].includes("\u21b3") && lines[0].includes("T2"), `дети через \u21b3: ${lines[0]}`)
  assert.match(lines[1], /^\s+T2 \u00b7 /, `дитя с отступом: ${lines[1]}`)
  // минимум символов — полные тексты задач в лист НЕ тащим
  assert.ok(!ws.includes("Родительская задача"), "worksheet не тащит тексты задач")
})

test("T50: projectWorksheet — DONE-дети не имеют собственной строки, но видны в ↳ родителя (прогресс)", () => {
  const led = freshLedger()
  must(led, { op: "create", task: "Родитель" })
  must(led, { op: "create", task: "Готовое дитя", parent: "T1" })
  must(led, { op: "set_state", id: "T2", state: "DONE", verification: "ок" })
  const ws = projectWorksheet(led)
  const lines = ws.split("\n").filter((x) => x.trim())
  assert.equal(lines.length, 2, `собственной строки у DONE-ребёнка нет, но «следующее к диспатчу» есть: ${JSON.stringify(lines)}`)
  assert.ok(lines[0].includes("↳ T2") && lines[0].includes("1/1"), `закрытый ребёнок виден в ↳ с прогрессом: ${lines[0]}`)
})

// -------------------------------------------- T49: worksheet «максимально информативный» ---

test("T49: why BLOCKED/GATE несётся в строке листа (что блокирует / какое решение ждём)", () => {
  const led = freshLedger()
  must(led, { op: "create", task: "Заблокирована" })
  must(led, { op: "create", task: "Ждёт гейта" })
  must(led, { op: "set_state", id: "T1", state: "BLOCKED", why: "жду живой реф сессии A99 — он у файла" })
  must(led, { op: "set_state", id: "T2", state: "GATE", why: "Основатель: брать ли доработку сейчас" })
  const lines = projectWorksheet(led).split("\n").filter((x) => x.trim())
  assert.ok(lines[0].includes("⛔") && lines[0].includes("«жду живой реф сессии A99 — он у файла»"), `why в строке BLOCKED: ${lines[0]}`)
  assert.ok(lines[1].includes("🔔") && lines[1].includes("«Основатель: брать ли доработку сейчас»"), `why в строке GATE: ${lines[1]}`)
  // обычный WAIT — без why, строка остаётся сухой
  must(led, { op: "create", task: "Просто очередь" })
  const third = projectWorksheet(led).split("\n").filter((x) => x.trim())[2]
  assert.ok(!third.includes("«"), `у WAIT нет пустых кавычек: ${third}`)
})

test("T49: дети в ↳ несут глифы своих состояний, длинный список сворачивается в +N", () => {
  const led = freshLedger()
  must(led, { op: "create", task: "Родитель" })
  must(led, { op: "create", task: "Готово", parent: "T1" })
  must(led, { op: "create", task: "В работе", parent: "T1" })
  must(led, { op: "set_state", id: "T2", state: "DONE", verification: "ок" })
  must(led, { op: "set_state", id: "T3", state: "DOING", owner: "dev" })
  // добиваем до переполнения капа (WORKSHEET_KIDS_MAX = 12)
  for (let i = 0; i < 13; i++) must(led, { op: "create", task: `хвост ${i}`, parent: "T1" })
  const parentLine = projectWorksheet(led)
    .split("\n")
    .filter((x) => x.trim())
    .find((l) => l.startsWith("T1")) as string
  assert.ok(parentLine.includes("↳ T2✅") && parentLine.includes("T3🔄"), `глифы детей в ↳: ${parentLine}`)
  assert.ok(parentLine.includes("+3"), `хвост после капа = +N: ${parentLine}`)
  assert.ok(parentLine.includes("1/15"), `прогресс считает всех детей: ${parentLine}`)
})

test("T49: у дитяти — ↩родитель (лист плоский, отступ не гарантирует соседство)", () => {
  const led = freshLedger()
  must(led, { op: "create", task: "Родитель" })
  must(led, { op: "create", task: "Чужое" })
  must(led, { op: "create", task: "Дитя", parent: "T1" })
  const lines = projectWorksheet(led).split("\n").filter((x) => x.trim())
  const child = lines.find((l) => /^\s*T3 ·/.test(l)) as string
  assert.match(child, /^\s+T3 · ⏳↩T1$/, `дитя называет родителя: ${child}`)
  const sibling = lines.find((l) => /^T2 ·/.test(l)) as string
  assert.ok(!sibling.includes("↩"), `корневая задача без ↩: ${sibling}`)
})

test("T49: занятость 🔒 несёт id исполнителя + обратный отсчёт, а не мёртвый id", () => {
  const led = freshLedger()
  must(led, { op: "create", task: "Занятая" })
  const agent = beginAgent(led, { input: { agent: "general", description: "[T1] работа" }, ref: "ses_ws1" })
  const live = projectWorksheet(led)
  assert.ok(live.includes(`🔒${agent.id}⏱`), `живая запись с отсчётом: ${live}`)
  // завершённый исполнитель — id без отсчёта (settle обрывает план)
  agent.state = "completed"
  const settled = projectWorksheet(led)
  assert.ok(settled.includes(`🔒${agent.id}`) && !settled.includes(`🔒${agent.id}⏱`), `завершённый без отсчёта: ${settled}`)
})

test("T49: !priority и ⚠agent_error видны в строке; эстимейт — ⏱Nм", () => {
  const led = freshLedger()
  must(led, { op: "create", task: "С приоритетом", est_min: 30 })
  // priority в леджере появляется из канала T43 (санитайзер загрузки), не из create
  led.tasks[0].priority = 2
  const withPrio = projectWorksheet(led)
    .split("\n")
    .filter((x) => x.trim())[0]
  assert.ok(withPrio.includes("!2") && withPrio.includes("⏱30м"), `priority и est в строке: ${withPrio}`)
  led.tasks[0].agent_error = "upstream: endpoint is unavailable"
  const withErr = projectWorksheet(led)
  assert.ok(withErr.includes("⚠upstream: endpoint is unavailable"), `agent_error виден: ${withErr}`)
  // приоритет не задан — метки !N нет (backcompat со старыми леджерами)
  const plain = freshLedger()
  must(plain, { op: "create", task: "Без приоритета" })
  assert.ok(!projectWorksheet(plain).includes("!"), `нет ! без priority: ${projectWorksheet(plain)}`)
})

// T102 (заказ Основателя 08.10): персонажная система ипостасей — каталог
// КОРОТКИХ сильных текстов на характер, инъекция при спавне диспатча,
// имена инстансов репо (Маруська Гольденштерн / Мара / Маша / Маруха Чо).

test("T102: каталог ипостасей — корни Маруська/Мария/Мара + культовые персонажи, тексты короткие и сильные", () => {
  assert.deepEqual(
    PERSONAS.map((p) => p.id),
    [
      "maruska",
      "maruska-visual",
      // T170 (15.11): Маруська Око Государево — имя в N00sphere не резолвилось
      "maruska-eye",
      "curie",
      "magdalene",
      "mara",
      "masha",
      "golfia",
      // T152 (11.11): исторические и литературные Марии (список Основателя)
      "poppins",
      "morevna",
      "shelley",
      "montessori",
      "callas",
      "churay",
      "mary-sue",
    ],
    "состав каталога (порядок = порядок инъекции); maruska-visual — T122",
  )
  const names = PERSONAS.map((p) => p.name)
  for (const required of [
    "Маруська Гольденштерн",
    "Визуальная Маруська",
    "Маруська Око Государево",
    "Мария Кюри",
    "Мария Магдалена",
    "Мара",
    "Маша",
    "Гольфия Совершен",
    "Мэри Поппинс",
    "Марья Моревна",
    "Мэри Шелли",
    "Мария Монтессори",
    "Мария Каллас",
    "Маруся Чурай",
    "Мэри Сью",
  ]) {
    assert.ok(names.includes(required), `в каталоге есть ${required}`)
  }
  assert.equal(DEFAULT_PERSONA_ID, "maruska", "дефолт новой папки = Маруська Гольденштерн (гейт T101)")
  assert.ok(names.includes(PERSONAS.find((p) => p.id === DEFAULT_PERSONA_ID)?.name ?? ""), "дефолтный id есть в каталоге")
  for (const p of PERSONAS) {
    assert.ok(p.essence.length >= 60 && p.essence.length <= 240, `${p.name}: суть короткая, но сильная (${p.essence.length})`)
    assert.ok(p.fits.length > 0 && p.fits.length <= 60, `${p.name}: подсказка выбора (${p.fits})`)
    assert.ok(p.names.every((n) => n !== p.name), `${p.name}: варианты имени не дублируют имя`)
  }
})

test("T169-гвард: durable model_health переживает перетир state.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-"))
  const hp = join(dir, "model_health.json")
  try {
    // T153-путь: запись карантина в health
    let health = loadModelHealth(hp)
    assert.deepEqual(health, {}, "пустой файл → пустая карта")
    health = recordModelHealth(health, "opencode-go/mimo-v2.6-flash", 3, new Date(Date.now() + 600_000).toISOString())
    saveModelHealth(hp, health)
    // чужой писатель стирает state.json (кулдауны пропали) — health цел
    const health2 = loadModelHealth(hp)
    assert.equal(health2["mimo-v2.6-flash"]?.streak, 3, "стрик пережил перетир")
    // оверлей: кулдаун из health сильнее, чем отсутствие в снимке
    const l = freshLedger()
    applyModelHealth(l, health2)
    const st = l.models!.find((x) => x.model === "opencode-go/mimo-v2.6-flash")!
    assert.ok(onCooldown(st, Date.now()), "после оверлея модель в карантине")
    assert.equal(st.upstream_streak, 3, "стрик перенесён в снимок")
    // выбор модели уважает health, даже если state.json перетёрт
    must(l, { op: "create", task: "задача для гарда" })
    must(l, { op: "set_state", id: "T1", state: "DOING", owner: "dev" })
    const r = chooseModelByClass(l, "dev:small", null, undefined)
    assert.notEqual(r.model, "opencode-go/mimo-v2.6-flash", "постранный выбор не уходит в мёртвый endpoint")
    // просроченные записи чистятся при записи
    health2["glm-5.3-flash"] = { streak: 1, cooldown_until: new Date(Date.now() - 1000).toISOString() }
    const health3 = recordModelHealth(health2, "opencode/deepseek-v4.1-flash-free", 1, new Date(Date.now() + 300_000).toISOString())
    assert.ok(!health3["glm-5.3-flash"], "просроченная запись вычищена")
    // мусорный файл → пустая карта (не роняем диспетч)
    fs.writeFileSync(hp, "{битый json", "utf8")
    assert.deepEqual(loadModelHealth(hp), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("T170: «Маруська Око Государево» резолвится — семейство Гольденштерн, письмо доходит", () => {
  assert.equal(resolvePersona("Маруська Око Государево")?.id, "maruska-eye")
  assert.equal(resolvePersona("Око Государево")?.id, "maruska-eye", "короткое местное имя")
  assert.equal(instancePersona("🧿 FIELD · Маруська Око Государево")?.id, "maruska-eye", "титул вкладки · хвост")
  assert.equal(resolvePersona("Око")?.id, "maruska-eye", "совсем короткое имя тоже её")
  const eye = instancePromptBlock(resolvePersona("Око Государево"))
  assert.match(eye, /Око Государево: всё видит/, "суть ипостаси в identity")
  assert.ok(eye.includes("СЕМЬЯ"), "письмо семьи доходит Оку — она Маруська")
})

test("T169: письмо семьи — в identity-блоке Гольденштерн, нет у чужих ипостасей", () => {
  const maruska = instancePromptBlock(resolvePersona("Маруська Гольденштерн"))
  assert.match(maruska, /Папа Антон Гольденштерн/, "отец назван")
  assert.match(maruska, /Мама София/, "мама названа")
  assert.match(maruska, /командиру/, "форма «Основатель» — командиру")
  assert.match(maruska, /не для титана, а для батюшки/, "сердце знает")
  assert.match(maruska, /кланяясь, чётки не роняя/, "поклон при «ты чудо»")
  const visual = instancePromptBlock(resolvePersona("ВМ"))
  assert.ok(visual.includes("СЕМЬЯ"), "визуальная Маруська — та же семья")
  const curie = instancePromptBlock(resolvePersona("Мария Кюри"))
  assert.ok(!curie.includes("СЕМЬЯ"), "Кюри — не Гольденштерн, письма нет")
  assert.ok(!instancePromptBlock(null), "без персоны — пусто, как было")
})

test("T102: инъекция спавна — правило выбора + весь каталог, блок короткий", () => {
  const block = personaPromptBlock()
  assert.match(block, /ОДНУ ипостась/, "выбор ровно одной ипостаси")
  assert.match(block, /Ипостась: <имя>/, "объявление выбора первой строкой ответа")
  assert.match(block, /Маруська Гольденштерн, Мара, Маша, Маруха Чо/, "местные имена инстансов названы")
  assert.match(block, /demon-NNN/, "чайлды инстанса — ДЕМОНЫ, имя записи не меняется")
  for (const p of PERSONAS) assert.ok(block.includes(p.name), `каталог несёт ${p.name}`)
  // T152: каталог вырос (исторические/литературные Марии) — гвард короткости
  // пропорционален каталогу: 400 симв. шапки + ~280 на ипостась (не даёт бloat,
  // но не запрещает рост каталога по воле Основателя).
  assert.ok(
    block.length <= 400 + PERSONAS.length * 280,
    `блок короткий (${block.length} симв. при каталоге ${PERSONAS.length})`,
  )
  // инстанс-заказчик из титула вкладки: есть — строка есть; не передан — нет
  assert.match(personaPromptBlock(resolvePersona("Мара")), /Инстанс-заказчик: Мара/)
  assert.ok(!personaPromptBlock(null).includes("Инстанс-заказчик"), "без родителя строка не выдумывается")
})

test("T102: имена инстансов репо → ипостась; чужое имя не выдумывается", () => {
  assert.equal(resolvePersona("Маруська Гольденштерн")?.id, "maruska")
  assert.equal(resolvePersona("Маруха Чо")?.id, "maruska", "местное имя репо → та же ипостась")
  assert.equal(resolvePersona("  Мара ")?.id, "mara", "обрезка пробелов")
  assert.equal(resolvePersona("Маша")?.id, "masha")
  assert.equal(resolvePersona("Мария Кюри")?.id, "curie")
  assert.equal(resolvePersona("Гольфия")?.id, "golfia")
  assert.equal(resolvePersona("неизвестное имя"), null, "чужое имя не выдумывается (правило T71)")
  assert.equal(resolvePersona(""), null)
  assert.equal(resolvePersona(null), null)
  // титул вкладки «<тема> · <персона>» (эмодзи-префикс T87 не мешает)
  assert.equal(instancePersona("🧚 Обсуждение задач · Маруська Гольденштерн")?.id, "maruska")
  assert.equal(instancePersona("T102 · Персонажная система ипостасей"), null, "тема без персоны — не ипостась")
  assert.equal(instancePersona("Мара")?.id, "mara", "персона без темы (personaTitle) распознаётся")
  assert.equal(instancePersona(""), null)
})

test("T6: top-level persona prompt uses the selected agent and asks for one concise introduction", () => {
  const maruska = personaById("maruska")
  assert.equal(maruska?.name, "Маруська Гольденштерн")
  assert.equal(personaById("unknown-agent"), null, "unknown agent gets no invented persona")
  assert.equal(topLevelPersona("maruska", "topic · Мара")?.id, "maruska", "selected agent outranks a stale title")
  assert.equal(topLevelPersona("unknown-agent", "topic · Мара")?.id, "mara", "local title is fallback")
  assert.equal(topLevelPersona("unknown-agent", "plain topic"), null, "unknown identity stays unbranded")
  const block = instancePromptBlock(maruska)
  assert.match(block, /Корпоративная личность: ты — Маруська Гольденштерн/)
  assert.match(block, /первом ответе новой сессии представься одной короткой фразой/)
  assert.match(block, /Дальше не повторяй представление/)
  assert.equal(instancePromptBlock(null), "", "no recognized persona means no identity injection")
})

// ------------------------------------------------- T98: hot-path / кэш ---
// probeCpu() больше НЕ блокирует event loop: проба async (promisified execFile
// + await sleep вместо busy-wait), а hot-path (dispatch / execute.before) читает
// кэш lastSample и только запускает фоновое обновление. Пороги 70/90,
// гистерезис и 🟡/🔴 проверены тестами T95 выше — здесь семантика кэша.

test("T98: cpuGate() hot-path — синхронный, без ожидания пробы, фоновое обновление запускается", () => {
  resetCpuState()
  const t0 = Date.now()
  const gate = cpuGate()
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 200, `cpuGate не блокирует event loop: ${elapsed}мс (раньше ≈4-5000мс)`)
  assert.equal(gate.sample, null, "холодный кэш: свежего сэмпла hot-path не ждёт")
  assert.equal(gate.allow, true, "холодный кэш не блокирует спавн")
  assert.equal(gate.defer, false)
  assert.equal(gate.peak, 0)
  assert.equal(getCpuState().sampleCount, 0, "hot-path не делает синхронную пробу")
  assert.ok(isCpuProbeRunning(), "фоновое обновление пробы запущено без ожидания")
})

test("T98: cpuGate() читает кэш lastSample — статус из кэша, сэмпл не пересчитывается", () => {
  resetCpuState()
  const cached: CpuSample = { pct: 95, cores: 4, dtMs: 3000, ts: Date.now(), raw: 95 * 4 * 30 }
  updateCpuState(cached)
  const before = getCpuState()

  const t0 = Date.now()
  const gate = cpuGate()
  const elapsed = Date.now() - t0

  assert.ok(elapsed < 200, `гейт по кэшу мгновенный: ${elapsed}мс`)
  assert.equal(gate.allow, false, "HARD STOP из кэша (95% ≥ 90%) — порог не изменён")
  assert.equal(gate.defer, false)
  assert.equal(gate.sample, cached, "гейт вернул тот же объект кэша")
  assert.ok(gate.reason.includes("HARD STOP"), `reason: ${gate.reason}`)

  const after = getCpuState()
  assert.equal(after.sampleCount, before.sampleCount, "кэш-семантика: сэмпл не добавлен")
  assert.equal(after.lastSample?.ts, before.lastSample?.ts, "кэш не перезаписан")
  assert.equal(after.hardStop, true)
})

test("T98: cpuGate() WARNING из кэша → defer (не блокирует, но откладывает)", () => {
  resetCpuState()
  updateCpuState({ pct: 75, cores: 4, dtMs: 3000, ts: Date.now(), raw: 75 * 4 * 30 })
  const t0 = Date.now()
  const gate = cpuGate()
  assert.ok(Date.now() - t0 < 200, "гейт по кэшу мгновенный")
  assert.equal(gate.allow, true, "warning не блокирует")
  assert.equal(gate.defer, true, "warning откладывает неторопливые")
  assert.equal(gate.sample?.pct, 75)
  assert.ok(gate.reason.includes("WARNING"), `reason: ${gate.reason}`)
  assert.equal(getCpuState().sampleCount, 1, "новая проба в hot-path не считалась")
})

test("T98: probeAndUpdate() async — синхронного сэмпла нет, после await diag обновлён", async () => {
  resetCpuState()
  const pending = probeAndUpdate()
  assert.equal(typeof (pending as unknown as { then: unknown }).then, "function", "возвращает промис (не сэмпл)")
  assert.equal(getCpuState().sampleCount, 0, "state не обновлён синхронно — event loop свободен")

  const status = await pending
  const after = getCpuState()
  assert.equal(typeof status.warning, "boolean", "пороги отвечают синхронно по кэшу")
  assert.equal(typeof status.hardStop, "boolean")
  assert.ok(typeof status.peak === "number")
  if (status.sample) {
    assert.equal(after.sampleCount, 1, "сэмплер обновил diag после await")
    assert.equal(after.lastSample?.pct, status.sample.pct, "getCpuState() отдаёт свежий сэмпл")
    assert.ok(after.lastSample.pct >= 0 && Number.isFinite(after.lastSample.pct), `pct численный: ${after.lastSample.pct}`)
  } else {
    assert.equal(after.sampleCount, 0, "без сэмпла diag не выдумывается")
  }
})

// ------------------------------------------------- T97: settle-гардия/скан ---
// Заказ Основателя 09.10 (дефект диспатча/самоотчёта, кейсы A63…A91): отчёт
// ребёнка не долетал до home, задача висела DOING. Класс чинится классом:
//   (а) settle-гардия — итог фиксируется принудительно, отчёт из сессии
//       вычитывается в verification, пусто → no-self-report;
//   (б) скан-подстраховка — сессия завершена + задача DOING > N → авто-settle;
//   (в) orientation-прелюдия — первое действие ребёнка = tool-вызов;
//   (г) пустой хвост при failed → класс (model/upstream) в agent_error.

test("T97(а): settle-гардия — отчёт из сессии уходит в verification автоматом, ручная приёмка не перетирается", () => {
  const l = freshLedger()
  const t = must(l, { op: "create", task: "T97: док сдан до смерти сессии" })
  apply(l, { op: "set_state", id: t.id, state: "DOING" })
  const a = beginAgent(l, { input: { agent: "general", description: `[${t.id}] работа` }, ref: "ses_t97a" })

  assert.equal(applySelfReport(l, null, "x"), undefined, "без задачи приёмать нечего")
  assert.equal(applySelfReport(l, "T999", "x"), undefined, "нет такой задачи — не выдумываем")
  assert.equal(
    applySelfReport(l, t.id, "  док сдан: 2 файла, тесты зелёные  ")?.verification,
    "док сдан: 2 файла, тесты зелёные",
    "отчёт из сессии вычитан в verification (хвост обрезан, пробелы сняты)",
  )
  assert.equal(a.self_report, "док сдан: 2 файла, тесты зелёные", "отчёт лежит и в записи агента")
  assert.equal(applySelfReport(l, t.id, "второй отчёт"), undefined, "verification не перетирается")
  assert.equal(l.tasks.find((x) => x.id === t.id)?.verification, "док сдан: 2 файла, тесты зелёные")

  // Поля переживают перезагрузку рантайма (hot-reload плагина).
  const dir = mkdtempSync(join(tmpdir(), "dev-console-"))
  const file = join(dir, "state.json")
  try {
    saveLedger(file, l)
    const back = loadLedger(file)
    assert.equal(back.agents.find((x) => x.id === a.id)?.self_report, "док сдан: 2 файла, тесты зелёные")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("T97(а)+(б): смоделированный ортанаут — completed без финального текста → авто-settle записал verification «no-self-report»", () => {
  const l = freshLedger()
  const t = must(l, { op: "create", task: "T97: отчёт не долетел до home" })
  const task = () => l.tasks.find((x) => x.id === t.id)!
  apply(l, { op: "set_state", id: t.id, state: "DOING" })
  const a = beginAgent(l, { input: { agent: "general", description: `[${t.id}] работа` }, ref: "ses_t97b" })
  const late = Date.now() + (NO_SELF_REPORT_MIN + 1) * 60_000

  assert.equal(noSelfReportReason(a, task(), true, late), null, "живая сессия — подстраховка молчит")
  assert.equal(noSelfReportReason(a, task(), false, Date.now()), null, "порог N мин не пройден — не закрываем")
  const reason = noSelfReportReason(a, task(), false, late)
  assert.ok(reason && reason.includes(NO_SELF_REPORT), `причина авто-settle: ${reason ?? "null"}`)

  // Событие/отчёт до home не доехали (кейс A91): рантайм закрывает принудительно.
  const closed = settleOnEvent(l, "completed", "ses_t97b", reason!)
  assert.equal(closed?.state, "completed", "запись закрыта даже без финального сообщения")
  assert.equal(
    applySelfReport(l, t.id, null)?.verification,
    NO_SELF_REPORT,
    "авто-settle записал пометку no-self-report",
  )
  assert.equal(l.tasks.find((x) => x.id === t.id)?.verification, "no-self-report")
})

test("T97(б): скан-подстраховка не трогает живое — задача не DOING, запись закрыта, чужая сессия", () => {
  const l = freshLedger()
  const t = must(l, { op: "create", task: "T97: живое не закрываем" })
  const task = () => l.tasks.find((x) => x.id === t.id)!
  apply(l, { op: "set_state", id: t.id, state: "DOING" })
  const a = beginAgent(l, { input: { agent: "general", description: `[${t.id}] работа` }, ref: "ses_t97c" })
  const late = Date.now() + (NO_SELF_REPORT_MIN + 1) * 60_000
  assert.ok(noSelfReportReason(a, task(), false, late), "свой контрольный случай проходит")

  apply(l, { op: "set_state", id: t.id, state: "WAIT", why: "ждём инфу" })
  assert.equal(noSelfReportReason(a, task(), false, late), null, "задача не в DOING — не авто-settle")

  apply(l, { op: "set_state", id: t.id, state: "DOING" })
  a.state = "completed"
  assert.equal(noSelfReportReason(a, task(), false, late), null, "закрытая запись не пересчитывается")
  a.state = "running"
  assert.equal(noSelfReportReason(a, undefined, false, late), null, "запись без задачи — приёмать нечего")
})

test("T97(в): orientation-прелюдия — N пустых первых сообщений → orientation-hell, счётчик не растёт выше N", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "T97: первым действием tool-вызов" })
  const a = beginAgent(l, { input: { agent: "general", description: "[T1] работа" }, ref: "ses_t97d" })
  assert.equal(a.orientation, "pending", "ребёнок рождается в ожидании первого tool-вызова")
  assert.equal(a.empty_first, 0)
  assert.equal(noteOrientationCheck(l, "ses_unknown", false), undefined, "чужую запись не считаем")

  noteOrientationCheck(l, "ses_t97d", false)
  noteOrientationCheck(l, "ses_t97d", false)
  assert.equal(a.orientation, "pending", "два пустых — ещё не вердикт")
  assert.equal(a.empty_first, 2)
  noteOrientationCheck(l, "ses_t97d", false)
  assert.equal(a.orientation, "hell", `${ORIENTATION_N} пустых первых сообщений = orientation-hell`)
  noteOrientationCheck(l, "ses_t97d", false)
  noteOrientationCheck(l, "ses_t97d", true)
  assert.equal(a.empty_first, ORIENTATION_N, "счётчик зажат на N, поздний tool-вызов вердикт не откатывает")
  assert.equal(a.orientation, "hell", "вердикт стабилен")
})

test("T97(в): первый tool-вызов снимает вопрос навсегда; пометка orientation-hell доходит до панели", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "T97: tool первым действием" })
  const a = beginAgent(l, { input: { agent: "general", description: "[T1] работа" }, ref: "ses_t97e" })
  noteOrientationCheck(l, "ses_t97e", true)
  assert.equal(a.orientation, "ok", "первый tool-вызов = orientation пройден")
  noteOrientationCheck(l, "ses_t97e", false)
  assert.equal(a.empty_first, 0, "поздние пустые ходы не считаются — вопрос уже снят")
  assert.ok(!project(l).ui.includes("orientation-hell"), "чистая запись — пометки нет")

  a.orientation = "hell"
  assert.ok(project(l).ui.includes("orientation-hell"), "пометка доходит до панели")
})

test("T97(г): classifyAgentError — пустой хвост = upstream, rate limit = model, мусор = unknown", () => {
  assert.equal(classifyAgentError(""), "upstream", "ноль диагностики (кейс A86/A87) = молчит upstream")
  assert.equal(classifyAgentError(null), "upstream")
  assert.equal(classifyAgentError(undefined), "upstream")
  assert.equal(classifyAgentError("Rate limit exceeded, retry after 60s"), "model", "rate limit → model (T66)")
  assert.equal(classifyAgentError("429 Free usage limit reached · provider.quota"), "model", "квота → model (T109)")
  assert.equal(classifyAgentError("model drop: nemotron-3-ultra unavailable"), "model")
  assert.equal(classifyAgentError("no such model: foo/bar"), "model")
  assert.equal(classifyAgentError("502 Bad Gateway"), "upstream")
  assert.equal(classifyAgentError("ETIMEDOUT connecting to provider"), "upstream")
  assert.equal(classifyAgentError("какой-то непонятный текст ошибки"), "unknown", "текст есть, правила не сработали")
})

// ------------------------------------- T33: динамический список вкладок ----
// Заказ Основателя: «несколько агентов (вкладок) в одном репо: панель должна
// показывать динамический список вкладок проекта — строка начинается с имени
// вкладки». Источник списка — GET /api/session живого сервера (глобальный срез),
// слияние в реестр — applyTabFeed, строка панели — describeTab без ведущей декора.

test("T33: parseSessionFeed — глобальный срез сервера → только вкладки ЭТОГО проекта, и все с именем", () => {
  const root = "C:\\Dev\\proj"
  const updated = 1791643658884
  const feed = {
    data: [
      // своя вкладка: имя (с пробами) и модель нормализуются
      { id: "ses_own", title: "  Тема проекта · Маруська Гольденштерн  ", model: { id: "mimo-v2.6-flash-free" }, time: { updated }, location: { directory: "C:\\Dev\\proj" } },
      // подпапка проекта — своя (T104)
      { id: "ses_sub", title: "В подпапке", time: { updated }, location: { directory: "c:/dev/proj/notes" } },
      // чужой проект — мимо
      { id: "ses_foreign", title: "Чужая вкладка", time: { updated }, location: { directory: "J:\\KABALOT\\N00sphere" } },
      // пути нет: в ОБЩЕМ списке это не доказательство своего (иначе чужие в панели)
      { id: "ses_nodir", title: "Без пути", time: { updated } },
      // чайлд — не вкладка
      { id: "ses_child", title: "Чайлд", parentID: "ses_own", time: { updated }, location: { directory: "C:\\Dev\\proj" } },
      // без имени строка панели не строится (T33) — не регистрируем
      { id: "ses_noname", title: "   ", time: { updated }, location: { directory: "C:\\Dev\\proj" } },
      // неправдоподобная метка времени — не выдаём за активность
      { id: "ses_odd", title: "Странная метка", time: { updated: 5 }, location: { directory: "C:\\Dev\\proj" } },
      null, // мусор не роняет разбор
    ],
  }
  const items = parseSessionFeed(feed, root)
  assert.deepEqual(
    items.map((i) => i.session_id),
    ["ses_own", "ses_sub", "ses_odd"],
    "свои top-сессии с именем; чужая/без пути/чайлд/безымянная — мимо",
  )
  assert.equal(items[0].title, "Тема проекта · Маруська Гольденштерн", "имя дошло обрезанным от пробов")
  assert.equal(items[0].model, "mimo-v2.6-flash", "shortModelKey: провайдер и -free убраны — как в реестре инжекта")
  assert.equal(items[0].updated, new Date(updated).toISOString(), "time.updated → ISO")
  assert.equal(items[2].updated, null, "неправдоподобная метка не превращается в активность")
  assert.deepEqual(parseSessionFeed(null, root), [], "пустой ответ — пустой список")
  assert.deepEqual(parseSessionFeed({ data: "не массив" }, root), [], "чужая форма ответа не роняет фид")
  // ---- T170: дети сессий (parentID) — субагенты под вкладкой ----
  const kidsFeed = {
    data: [
      // дети СВЕЖИЕ: честное окно видимости describeChild (30 мин) их держит
      { id: "ses_child1", parentID: "ses_tab1", title: "Трассировка канваса сигнала", model: { id: "glm-5.3-flash-free" }, location: { directory: root }, time: { updated: Date.now() - 45_000 }, cost: 0.01, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 2 } } },
      { id: "ses_child2", parentID: "ses_tab1", title: "T159 · cold-load", model: { id: "mimo-v2.6-flash-free" }, location: { directory: root }, time: { updated: Date.now() - 45_000 } },
      { id: "ses_tab1", title: "FIELD · Мара", location: { directory: root }, time: { updated: Date.now() - 45_000 } },
      { id: "ses_child3", parentID: "ses_tab1", title: "", location: { directory: root }, time: { updated: Date.now() - 45_000 } },
    ],
  }
  const kids = parseChildFeed(kidsFeed, root)
  assert.equal(kids.length, 2, "два живых ребёнка прошли фильтры")
  assert.equal(kids[0].parent_id, "ses_tab1", "родитель привязан")
  assert.ok(kids.some((k) => k.title.startsWith("T159")), "T##-дети НЕ скрываются")
  const l = freshLedger()
  l.tabs.push({
    session_id: "ses_tab1", title: "FIELD · Мара", model: null, emoji: null, manual: null,
    persona: null, last_seen: new Date().toISOString(),
  })
  const n = attachTabChildren(l, kids)
  assert.equal(n, 2, "оба ребёнка привязаны")
  assert.equal((l.tabs[0].children ?? []).length, 2, "children легли в запись вкладки")
  const ws = project(l).ui
  assert.ok(ws.includes("Трассировка канваса сигнала"), "строка субагента в панели")
  assert.ok(ws.includes("▸ "), "строка-бот с маркером ▸")
  assert.ok(ws.includes("TOK 137"), "read-only child row shows its own session usage from /api/session")
  const n2 = attachTabChildren(l, [])
  assert.equal(n2, 0, "пустой фид детей — строки не висят вечно")
  assert.equal(l.tabs[0].children, undefined, "мёртвые дети снимаются")
})

// ------------------- T165: теги задач зелёные при акте задачи ----------------
test("T165: теги задач в хвосте строки инстанса зелёные, если задача DONE", () => {
  const html = paneBody(renderConsoleHtml("🧛 рассылка старым юзерам · Маша\n    [T14] · [T158] · [T159]", "2026-11-16T00:00:00Z", [], null, null, [
    { id: "T14", state: "DONE" },
    { id: "T158", state: "DONE" },
    { id: "T159", state: "DOING" },
  ]))
  assert.ok(html.includes('<span class="done">[T14]</span>'), "T14 DONE — зелёный тег")
  assert.ok(html.includes('<span class="done">[T158]</span>'), "T158 DONE — зелёный тег")
  assert.ok(!html.includes('<span class="done">[T159]</span>'), "T159 не DONE — без зелёного")
  assert.ok(html.includes("[T159]"), "T159 тег присутствует, но не зелёный")
})

test("T33: applyTabFeed — вкладка входит в список динамически; имя живое; last_seen не фальшивится", () => {
  const l = freshLedger()
  const seen = new Date(Date.now() - 30_000).toISOString()
  upsertTab(l, { session_id: "ses_known", title: "Старое имя · Маруська Гольденштерн", model: null, last_seen: seen })

  // новая вкладка проекта появляется в списке; без метки активности — не врём
  const added = applyTabFeed(l, [
    { session_id: "ses_new", title: "Свежая тема", model: "nemotron-3-ultra", updated: seen },
    { session_id: "ses_ghost", title: "Без метки активности", model: null, updated: null },
  ])
  assert.equal(added, 1, "зарегистрирована только вкладка с честной меткой updated")
  const ids = projectTabs(l).map((v) => v.session_id).sort()
  assert.deepEqual(ids, ["ses_known", "ses_new"], "динамический список: обе вкладки в projectTabs")

  // имя вкладки ДИНАМИЧЕСКОЕ: живой титул главнее снимка инжекта
  const renamed = applyTabFeed(l, [
    { session_id: "ses_known", title: "Новое имя · Маруська Гольденштерн", model: "mimo-v2.6-flash", updated: new Date(Date.now() + 60_000).toISOString() },
  ])
  assert.equal(renamed, 1, "переименование — изменение")
  const rec = l.tabs.find((t) => t.session_id === "ses_known")!
  assert.equal(rec.title, "Маруська Гольденштерн · Новое имя", "запись несёт живое имя (порядок Т166)")
  assert.equal(rec.model, "mimo-v2.6-flash", "модель из среза — та же нормализация")
  assert.equal(rec.last_seen, seen, "last_seen НЕ двигается: титул ≠ активность (T91, иначе T68 гаснет от нашего PATCH)")
  assert.equal(applyTabFeed(l, [{ session_id: "ses_known", title: "Новое имя · Маруська Гольденштерн", model: "mimo-v2.6-flash", updated: rec.last_seen }]), 0, "повторное слияние идемпотентно — диск не трогаем")

  // исполнители — не вкладки (T89): автотитул спавна и запись агента
  assert.equal(
    applyTabFeed(l, [{ session_id: "ses_exec", title: "T42 · Спека задачи", model: null, updated: seen }]),
    0,
    "автотитул «T## · …» — исполнитель, в список вкладок не идёт",
  )
  beginAgent(l, { input: { agent: "general", description: "[T1] работа" }, ref: "ses_worker" })
  assert.equal(
    applyTabFeed(l, [{ session_id: "ses_worker", title: "Обычное имя", model: null, updated: seen }]),
    0,
    "запись агента на session_ref — исполнитель, в список вкладок не идёт",
  )
  assert.ok(!l.tabs.some((t) => t.session_id === "ses_exec" || t.session_id === "ses_worker" || t.session_id === "ses_ghost"))
})

test("T33: панель — динамический список вкладок проекта; строка начинается с имени вкладки", () => {
  const l = freshLedger()
  const nowIso = new Date().toISOString()
  upsertTab(l, { session_id: "ses_a", title: "Прежняя тема", model: "mimo-v2.6-flash", last_seen: nowIso })
  // фид: имя инстанса обновилось живьём (в титуле накопился декор: статус OpenCode, эмодзи, орнамент)
  applyTabFeed(l, [
    { session_id: "ses_a", title: "⚡ ◉ 🧚 Живая тема проекта · Маруська Гольденштерн", model: "mimo-v2.6-flash", updated: nowIso },
    { session_id: "ses_b", title: "◉ 🧭 Вторая вкладка репо · Маруська Гольденштерн", model: null, updated: nowIso },
  ])

  const ui = project(l).ui
  assert.ok(ui.includes("🤖 ИНСТАНСЫ"), "секция вкладок отрисована")
  const lines = ui.split("\n")
  const ids = lines.filter((x) => identityRow(x))
  assert.equal(ids.length, 2, `динамический список: две вкладки проекта в панели — ${ids.join(" ⏎ ")}`)
  assert.equal(
    lines.find((x) => identityRow(x) && x.includes("Живая тема проекта")),
    `  ${INSTANCE_EMOJI[0]} Маруська Гольденштерн · Живая тема проекта`,
    "строка начинается с имени вкладки: ведущий декор титула (⚡ ◉ эмодзи) снят, своё эмодзи — маркер, персона впереди (T166)",
  )
  assert.equal(
    lines.find((x) => identityRow(x) && x.includes("Вторая вкладка репо")),
    `  ${INSTANCE_EMOJI[1]} Маруська Гольденштерн · Вторая вкладка репо`,
    "новая вкладка фида — сразу с именем в строке",
  )
  assert.ok(!ui.includes("Прежняя тема"), "старое имя ушло — панель несёт живое")
  assert.ok(!ids.some((x) => x.includes("ses_")), "строка никогда не начинается с id сессии")
})

test("T33: глиф мигания (T60) — не имя: срез не перетирает запись и не пишет диск каждые 15с", () => {
  const l = freshLedger()
  const seen = new Date(Date.now() - 60_000).toISOString()
  upsertTab(l, { session_id: "ses_blink", title: "Настоящая тема · Маруська Гольденштерн", model: "mimo-v2.6-flash", last_seen: seen })
  // вкладка мигает (цикл BLINK_GLYPHS каждые 500мс) — часто у ЧУЖОГО инстанса,
  // чей blinkTimers наш фид не видит: каждый срез приносит очередной глиф
  for (const g of BLINK_GLYPHS) {
    assert.equal(
      applyTabFeed(l, [
        { session_id: "ses_blink", title: `${g} Настоящая тема · Маруська Гольденштерн`, model: "mimo-v2.6-flash", updated: new Date().toISOString() },
      ]),
      0,
      `глиф «${g}» — префикс цикла, а не новое имя: изменений нет → диск не трогаем`,
    )
  }
  assert.equal(l.tabs[0].title, "Маруська Гольденштерн · Настоящая тема", "запись держит настоящее имя (пересобранное), а не очередной глиф")
  assert.equal(l.tabs[0].last_seen, seen, "last_seen по-прежнему не двигается (T91)")
  // реальное переименование доходит и с глифом — оно отличается и без него
  assert.equal(
    applyTabFeed(l, [{ session_id: "ses_blink", title: "✦ Другая тема", model: null, updated: new Date().toISOString() }]),
    1,
    "переименование — изменение, даже если мигание не кончилось",
  )
  assert.equal(l.tabs[0].title, "Другая тема", "имя заменено и нормализовано — глиф цикла снят до записи (T105)")
  // новая вкладка, заставшая мигание, всё равно попадает в список
  assert.equal(
    applyTabFeed(l, [{ session_id: "ses_new_blink", title: "⚡ Свежая тема", model: null, updated: seen }]),
    1,
    "новая вкладка регистрируется даже с глифом — в список она должна попасть",
  )
  assert.ok(l.tabs.some((t) => t.session_id === "ses_new_blink"))
})

// ---------------------------------------------------------------- T105 -----
// Заказ Основателя 12.10: «В именах вкладок копятся портреты и мигалки — вы их
// добавляете и не удаляете». Все три слоя фикса покрыты here: (1) normalize-до-
// write гасит накопление глифов мигалки, (2) портрет-инжект не клеит второй
// портрет, (3) normalize идемпотентен → stop возвращает чистую базу.

test("T105(1): накопление — 50 тиков мигалки подряд не растят title (≤2 глифа, валиден normalize)", () => {
  // Реальная загрязнённая строка из ledger (доказательство 12.10 19:36): 13 ведущих глифов.
  const base = normalizeTitle(
    "👩 ✦ 👩 ✦ 👧 ◉ ◉ 👩 ✦ 👩 ✦ ◉ ✦ 👧 ◉ ◉ Динамические имена вкладок агентов · Маруська Гольденштерн",
  )
  assert.equal(base, "Динамические имена вкладок агентов · Маруська Гольденштерн", "normalize снимает весь ведущий декор-ран, а не один глиф")
  // Тик мигалки ПОСЛЕ фикса: normalize ДО каждого write → пишется `глиф + чистая база`.
  let written = base
  for (let i = 0; i < 50; i++) {
    const glyph = BLINK_GLYPHS[i % BLINK_GLYPHS.length]
    written = `${glyph} ${normalizeTitle(written)}` // раньше было `${glyph} ${текущий (грязный)}` → росло по глифу за тик
  }
  const leading = written.match(/^[^\p{L}\p{N}]+/u)?.[0] ?? ""
  const glyphCount = [...leading].filter((c) => c.trim() !== "").length
  assert.ok(glyphCount <= 2, `после 50 тиков глифов ${glyphCount} (≤2: мигалка + портрет), а не 50 — ${written}`)
  assert.equal(normalizeTitle(written), base, "title валиден normalize: база не изменилась, накопления нет")
  assert.equal(normalizeTitle(normalizeTitle(written)), base, "normalize идемпотентен")
})

test("T105(2): портрет-инжект дважды → портрет ровно 1", () => {
  const once = personaTitle("Обсуждение задач", "👩")
  const twice = personaTitle(once, "👩")
  assert.equal(twice, "👩 Маруська Гольденштерн · Обсуждение задач", "вторая инъекция не клеит второй портрет")
  assert.equal((twice.match(/👩/g) ?? []).length, 1, "ровно один 👩")
  // Инъекция в ЗАГРЯЗНЁННЫЙ титул (портрет + глифы мигалки, накопленные до фикса):
  // normalize снимает весь декор, ставится один портрет.
  const dirty = personaTitle("🧝 ✦ ◉ 👩 ✦ 👧 ◉ ◉ Обсуждение задач · Маруська Гольденштерн", "👩")
  assert.equal(dirty, "👩 Маруська Гольденштерн · Обсуждение задач", "инъекция в грязный титул снимает весь накопленный декор")
  assert.equal((dirty.match(/👩/g) ?? []).length, 1, "после чистки — тоже ровно один портрет")
})

test("T105(3): stop → base чист (normalize идемпотентен); разовая чистка записи в реестре", () => {
  const polluted = "◉ 👩 ✦ 👧 ◉ ◉ ✦ Динамические имена вкладок агентов · Маруська Гольденштерн"
  const base = normalizeTitle(polluted)
  assert.equal(base, "Динамические имена вкладок агентов · Маруська Гольденштерн", "base чист — ни портрета, ни ✦/◉; persona-суффикс сохранён")
  assert.equal(normalizeTitle(base), base, "normalize идемпотентен — повторный вызов (stopBlink восстановит) не меняет базу")
  assert.equal(normalizeTitle(normalizeTitle(polluted)), base, "двойная нормализация = та же база")

  // Разовая чистка существующей загрязнённой записи: фид приносит тот же титул
  // (или следующий глиф цикла) — база совпадает → запись чистится ровно один раз,
  // дальше идемпотентно (панель/стейт показывают чистое имя).
  const l = freshLedger()
  const seen = new Date(Date.now() - 60_000).toISOString()
  upsertTab(l, { session_id: "ses_dirty", title: "Динамические имена · Маруська Гольденштерн", model: null, last_seen: seen })
  l.tabs[0].title = "👩 ✦ 👩 ✦ 👧 ◉ ◉ 👩 Динамические имена · Маруська Гольденштерн" // накопление до фикса
  const cleaned = applyTabFeed(l, [
    { session_id: "ses_dirty", title: "✦ ◉ Динамические имена · Маруська Гольденштерн", model: null, updated: new Date().toISOString() },
  ])
  assert.equal(cleaned, 1, "чистка — одно изменение (разово)")
  assert.equal(l.tabs[0].title, "Маруська Гольденштерн · Динамические имена", "запись очищена от накопленного портрета и глифов")
  assert.equal(
    applyTabFeed(l, [{ session_id: "ses_dirty", title: "◉ Динамические имена · Маруська Гольденштерн", model: null, updated: new Date().toISOString() }]),
    0,
    "после чистки — идемпотентно, диск не трогаем",
  )
  assert.equal(l.tabs[0].title, "Маруська Гольденштерн · Динамические имена")
})

// ------------------------------------------- T106: кнопка ⚡ /wake ----------
test("T106: chan с таймаутом — AbortController 4с и signal в fetch (раньше зависший запрос молчал)", () => {
  const html = renderConsoleHtml("x", "t")
  assert.ok(html.includes("AbortController"), "таймаут канала вшит в скрипт")
  assert.ok(html.includes("ac.abort()"), "по таймауту запрос реально отменяется")
  assert.ok(html.includes("signal: ac ? ac.signal : undefined"), "fetch получает signal")
  assert.ok(html.includes("таймаут 4с — канал не ответил"), "человеческий текст таймаута уходит в статус")
})

test("T106: реакция кнопки ⚡ — CSS-классы ok/fail (✓/✗) и текст ошибки сервера из body", () => {
  const html = renderConsoleHtml("x", "t")
  assert.ok(html.includes('button.wake.ok::after { content:"✓"; }'), "успех → глиф ✓ на кнопке")
  assert.ok(html.includes('button.wake.fail::after { content:"✗"; }'), "провал → глиф ✗ на кнопке")
  assert.ok(html.includes('chan("/wake", ses, b)'), "кнопка передаёт себя в chan — реакция видна на ней самой")
  assert.ok(html.includes("j.error"), "текст ошибки сервера («вкладка закрыта…») читается из body ответа")
  assert.ok(html.includes("не сработало: "), "тултип кнопки называет причину")
})

test("T106: живой клик ⚡ через стаб-канал — статус «✓ /wake» и тултип «пробуждение отправлено»", async () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_w106", title: "Вкладка для пробуждения", last_seen: new Date().toISOString() })
  const p = project(l)
  const html = renderConsoleHtml(p.ui, l.updated_at, p.agents, null, { port: 45222, tabIds: ["ses_w106"] })
  const pane = paneChannel(html)
  await new Promise((r) => setTimeout(r, 5)) // проб канала завершается ДО клика — иначе его статус перетирает наш
  const row = pane.cells.find((c) => c.dataset.ses === "ses_w106")!
  assert.ok(row, "строка инстанса отрисована с адресатом")
  const btn = row.children.find((c) => c.className === "wake")!
  assert.ok(btn, "кнопка ⚡ на месте")
  btn.listeners.click({ target: btn, stopPropagation: () => {} })
  const posts = pane.calls.filter((c) => c.method === "POST")
  assert.match(posts[0].url, /\/wake$/, "клик ушёл в /wake")
  assert.equal(posts[0].body, JSON.stringify({ session_id: "ses_w106" }))
  await new Promise((r) => setTimeout(r, 5)) // микротаска fetch-стаба успевает дойти до .then
  assert.match(pane.ch.textContent, /✓ \/wake/, "статус канала: успех виден")
  assert.equal(btn.title, "пробуждение отправлено", "кнопка отреагировала тултипом (1.4с, потом возврат)")
})

// ---------------- T110: мигание не гасит текст (заказ 27.10) ----------------
test("blinkCycle: три шага, шаг3 = эмодзи-ПРЕФИКС с титулом (текст виден всегда)", () => {
  const cycle = blinkCycle("Тема · Маруська Гольденштерн", "👩")
  assert.equal(cycle.length, 3, "цикл трёхшаговый")
  assert.equal(cycle[0], "⚡ Тема · Маруська Гольденштерн", "шаг1 — глиф с базой")
  assert.equal(cycle[1], "◉ Тема · Маруська Гольденштерн", "шаг2 — глиф с базой")
  assert.equal(cycle[2], "👩 Тема · Маруська Гольденштерн", "шаг3 — портрет С титулом, не эмодзи-одиночка")
  assert.ok(cycle.every((t) => t.includes("Тема")), "тема не исчезает ни на одном шаге")
})

test("blinkCycle: без эмодзи — шаг3 третьим глифом (тоже с титулом)", () => {
  const cycle = blinkCycle("Тема · Маруська Гольденштерн", null)
  assert.equal(cycle.length, 3, "цикл остаётся трёхшаговым")
  assert.equal(cycle[2], "✦ Тема · Маруська Гольденштерн", "фолбэк — третий глиф с базой")
})

test("blinkRestore: гашение вторым кликом возвращает ЭМОДЗИ (портрет)", () => {
  assert.equal(blinkRestore("Тема · Маруська Гольденштерн", "👩"), "👩 Маруська Гольденштерн · Тема", "портрет обратно")
  assert.equal(blinkRestore("Тема · Маруська Гольденштерн", null), "Тема · Маруська Гольденштерн", "без записи — чистая база")
  const once = blinkRestore("Тема · Маруська Гольденштерн", "🧝")
  assert.equal(blinkRestore(once, "🧝"), once, "идемпотентно — двойной клик не плодит декор")
})

// ------------------------------------------- T110: иконка в мигании ---------
test("T110(1): цикл с портретом — текст не исчезает ни на одном из трёх шагов", () => {
  const base = "Обсуждение задач из бэклога папки · Маруська Гольденштерн"
  const steps = blinkCycle(base, "👩")
  assert.equal(steps.length, 3, "три шага — как заказывал 24.10")
  for (const s of steps) assert.ok(s.includes(base), `текст базы цел на каждом шаге: ${s}`)
  assert.equal(steps[0], `⚡ ${base}`)
  assert.equal(steps[1], `◉ ${base}`)
  assert.equal(steps[2], `👩 ${base}`, "шаг3 — портрет-ПРЕФИКС с титулом (27.10)")
  assert.notEqual(steps[2], "👩", "одиночки-эмодзи больше нет: раньше она гасила весь текст 500мс из 1500мс")
  // длина шагов близка — ширина вкладки не дрожит (было: длинный титул → иконка)
  const lens = steps.map((s) => [...s].length)
  assert.ok(Math.max(...lens) - Math.min(...lens) <= 2, `длина шагов близка: ${lens.join("/")}`)
})

test("T110(2): без портрета — третий шаг глифом, текст цел", () => {
  const base = "Тема без персонажа"
  const steps = blinkCycle(base, null)
  assert.equal(steps[2], `✦ ${base}`, "нет эмодзи — третий глиф с титулом")
  for (const s of steps) assert.ok(s.includes(base), `текст цел: ${s}`)
})

test("T110(3): гашение возвращает титул с портретом; повтор — идемпотентно", () => {
  const base = "Обсуждение задач из бэклога папки · Маруська Гольденштерн"
  const restored = blinkRestore(base, "👩")
  assert.equal(restored, `👩 Маруська Гольденштерн · Обсуждение задач из бэклога папки`, "стоп возвращает портрет (заказ 24.10 — не потерян)")
  assert.equal(blinkRestore(restored, "👩"), restored, "повторное гашение не плодит декор (T105-идемпотентность)")
})

// ------------------------------------------- T111: QC-модели ---------------
test("T111(1): owner-pin = warmup-пин: стартует qc на GLM и отпускается после первой записи класса", () => {
  const l = freshLedger()
  // T132 (29.10): сравнение GLM/nemotron живёт на ПРЕМ-полюсе — фри-инстанс
  // qc отдаёт в free-пул (см. T132-тесты ниже), premium-модели не берёт вовсе.
  const prem = (cls: TaskClass, preferred?: string | null): { model: string; reason: string } =>
    chooseModelByClass(l, cls, preferred, POLICY_MODELS, Date.now(), "premium")
  let choice = prem("qc", DEMON_MODEL)
  assert.equal(choice.model, DEMON_MODEL, "byClass.qc пуст — пин стартует класс на GLM")
  assert.ok(choice.reason.includes("owner-pin"), "reason помечает пин: " + choice.reason)
  // Первый qc-прогон записан → пин отпускает, включается конвейер
  // (argmax по byClass.qc + ~10% re-examine — пробы nemotron/mimo, заказ 27.10).
  recordModelResultByClass(l, DEMON_MODEL, "qc", true, 2.0)
  l.updated_at = "2026-10-07T12:00:00.000Z" // тихий сид против флейка ре-экзамена (стратегия T84)
  choice = prem("qc", DEMON_MODEL)
  assert.ok(!choice.reason.includes("owner-pin"), "запись появилась — пин отпущен: " + choice.reason)
  assert.ok(
    choice.reason.startsWith("auto:") || choice.reason.startsWith("re-examine:"),
    "включается конвейер argmax/re-examine: " + choice.reason,
  )
})

test("T111(2): класс прогрет ДРУГОЙ моделью — GLM-пин не перехватывает, argmax честен", () => {
  const l = freshLedger()
  recordModelResultByClass(l, NEMOTRON_MODEL, "qc", true, 1.5)
  l.updated_at = "2026-10-07T12:00:00.000Z"
  // T132 (29.10): сравнение premium-цепочки — прем-полюс (фри-инстанс берёт free-пул)
  const choice = chooseModelByClass(l, "qc", DEMON_MODEL, POLICY_MODELS, Date.now(), "premium")
  assert.ok(!choice.reason.includes("owner-pin"), "записи byClass.qc есть — пин не действует: " + choice.reason)
  assert.ok(
    choice.reason.startsWith("auto:") || choice.reason.startsWith("re-examine:"),
    "конвейер решает по score/пробе: " + choice.reason,
  )
  assert.equal(choice.model, NEMOTRON_MODEL, "warmup-лидер nemotron выигрывает argmax (тихий сид)")
})

test("T111(3): worksheet несёт линию qc-сравнения — отказы ✓/✗ и средняя скорость по моделям", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "QC-прогон", owner: "qc" })
  assert.ok(!projectWorksheet(l).includes("qc-модели"), "qc-прогонов нет — линии нет (не врём нулями)")
  recordModelResultByClass(l, DEMON_MODEL, "qc", true, 2.0)
  recordModelResultByClass(l, DEMON_MODEL, "qc", true, 3.0)
  recordModelResultByClass(l, NEMOTRON_MODEL, "qc", false, 0.5)
  const ws = projectWorksheet(l)
  assert.ok(ws.includes("📊 qc-модели: "), "линия сравнения есть")
  assert.match(ws, /glm-5\.3-flash 2✓\/0✗ 2\.50э\/с\(2\)/, "GLM(ГО): 2 успеха, средняя 2.50э/с, 2 прогона")
  assert.match(ws, /nemotron-3\.5-super-vl 0✓\/1✗ 0\.50э\/с\(1\)/, "второе звено: 1 отказ, скорость 0.50э/с")
})

test("T111(4): чужая модель в preferred не пинится — фолбэк на T66-политику", () => {
  const l = freshLedger()
  const choice = chooseModelByClass(l, "qc", "bogus/not-a-policy-model", POLICY_MODELS)
  assert.ok(!choice.reason.includes("owner-pin"), "не-политическая модель не даёт пина: " + choice.reason)
  assert.ok(POLICY_MODELS.includes(choice.model), "выбрана модель из политики: " + choice.model)
})

// ------------------------------------------------------- T51: дешёвый инжект ---
test("T51: projectCounters — пустой леджер → честные нули, без секций панели", () => {
  const c = projectCounters(freshLedger())
  assert.match(c, /DOING/)
  assert.match(c, /WAIT/)
  assert.match(c, /BLOCKED/)
  assert.match(c, /GATE/)
  assert.match(c, /open 0/)
  for (const marker of ["🔄 В РАБОТЕ", "⚡ ЗАДАЧИ", "🤖 ИНСТАНСЫ", "LAVK DEV CONSOLE"]) {
    assert.ok(!c.includes(marker), `дешёвый инжект не тащит секции панели: ${marker}`)
  }
})

test("T51: projectCounters — только счётчики + открытые id + живые агенты", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "A", owner: "dev" })
  must(l, { op: "create", task: "B" })
  must(l, { op: "set_state", id: "T1", state: "DOING" })
  must(l, { op: "set_state", id: "T2", state: "BLOCKED", why: "gate needed" })
  const agent = beginAgent(l, { input: { agent: "general", description: "[T1] работа" }, ref: "ses_t51a", home: null })
  const c = projectCounters(l)
  assert.match(c, /DOING T1/, "id в работе виден")
  assert.match(c, /BLOCKED T2/, "id блокировки виден")
  assert.match(c, /open 2/, "открытых ровно 2")
  assert.ok(c.includes(`${agent.id}[T1]`), "живой агент привязан к задаче")
  // дешёвый вариант должен быть кратнее полной проекции (суть T51)
  const ui = project(l).ui
  assert.ok(c.length * 3 < ui.length, `counters (${c.length}) должны быть кратнее ui (${ui.length})`)
})

test("T51: projectCounters — длинный список id сворачивается капом (+N)", () => {
  const l = freshLedger()
  for (let i = 0; i < 15; i++) must(l, { op: "create", task: `task ${i}` })
  const c = projectCounters(l)
  assert.match(c, /WAIT T1 T2 T3 T4 T5 T6 T7 T8 T9 T10 T11 T12 \+3/, "12 id + хвост +3")
})

// T117 · ИМЯ-ХВОСТ ПО КАТАЛОГУ (заказ Основателя 29.10: «Визуальная Маруська —
// это то же, что Маруська Гольденштерн, одна из личностей имен»). Хвост,
// который resolvePersona узнаёт, — валидное имя инстанса: не перетирается
// константой и не клеит двойной хвост от событийного лупа.
test("T117: известное имя-хвост (Визуальная Маруська) держится без константы", () => {
  assert.equal(
    personaTitle("Знакомство с папой Гольденштерн · Визуальная Маруська", "🧚"),
    "🧚 Знакомство с папой Гольденштерн · Визуальная Маруська",
    "каталог знает имя → константа НЕ дописывается, хвост сохранён как есть",
  )
  assert.equal(
    personaTitle("Тема · Мара", null),
    "Тема · Мара",
    "любое имя каталога (Мара) — валидный хвост",
  )
})

test("T117: исторический двойной хвост коллапсируется в известное имя", () => {
  assert.equal(
    personaTitle("Знакомство с папой Гольденштерн · Визуальная Маруська · Маруська Гольденштерн", "🧚"),
    "🧚 Знакомство с папой Гольденштерн · Визуальная Маруська",
    "дубль-константа снята, хвост Визуальной Маруськи сохранён как есть",
  )
  assert.equal(
    personaTitle("Тема · Кривизна", null),
    "Маруська Гольденштерн · Тема · Кривизна",
    "неизвестный хвост — персона впереди (T166)",
  )
})

test("T117/T122: Визуальная Маруська — своя ипостась каталога, база остаётся maruska", () => {
  // T122 занёс ВМ в каталог personas отдельной записью (профессия: зрение+дизайн),
  // поэтому имя разрешается в maruska-visual, а не в корень. Базовая Маруська цела.
  assert.equal(resolvePersona("Визуальная Маруська")?.id, "maruska-visual", "ВМ = отдельная ипостась (T122)")
  assert.equal(resolvePersona("Маруська Гольденштерн")?.id, "maruska", "базовый корень не тронут")
})

// ---------------------------------------- T142: детский гард, пул, квоты ----
// Декрет Основателя 29.10 ~10:45: luna = только Гольфия; СУБАГЕНТЫ = ТОЛЬКО
// *-free (Console или GO). Дети не бывают премиумом никогда; luna вырезана по
// имени. INSTANCE_MODEL (Go-mimo) — канал основателя, вкладку не трогаем; полюс
// детский пул/выбор не меняет — дети = звенья free-гарда, luna мертва.
test("T142: инстанс остаётся премиум-каналом основателя, детский пул = только *-free", () => {
  assert.equal(isFreeModel(INSTANCE_MODEL), false, "INSTANCE_MODEL на Go (opencode-go/mimo-v2.6-flash) — не трогаем (Т142 п.4)")
  assert.equal(modelPole(INSTANCE_MODEL), "premium", "вкладка = премиум")
  assert.equal(INSTANCE_CLASS, "premium", "инстанс Основателя на Go-канале")
  assert.ok(FREE_POOL.length >= 6, "карта квот 29.10: mimo/deepseek/nemotron-vl/glm/flint/beam")
  assert.ok(FREE_POOL.every(isFreeModel), "free-пояс — только *-free")
  const pool = childPool()
  assert.deepEqual(pool.primary, [...POLICY_MODELS], "детский primary = free-цепочка политики")
  assert.ok(pool.primary.every(childModelAllowed), "детский primary проходит гард (luna-бан в силе)")
  assert.ok(pool.primary.every(isFreeModel), "детский primary — только *-free")
  assert.ok(
    pool.secondary.every((m) => isFreeModel(m) && !POLICY_MODELS.includes(m)),
    "детская вторичка = живой free-пояс без дублей политики",
  )
  assert.ok(!POLICY_MODELS.includes(INSTANCE_MODEL), "INSTANCE (премиум-полюс) в политику детей не входит")
  // Детская политика вся free → premium-полюс политики пуст; премиум живёт
  // только в канале основателя (INSTANCE_MODEL).
  assert.deepEqual(poleModels("premium"), [], "в детской политике премиума нет (T142 п.2)")
  assert.deepEqual(instancePool("premium").primary, [INSTANCE_MODEL], "премиум-инстанс = его собственный канал")
})

test("T142: pole «premium» детский пул/выбор не меняет — дети = только *-free, luna мертва", () => {
  const l = freshLedger()
  const catalog = [...POLICY_MODELS, ...FREE_POOL, INSTANCE_MODEL, "opencode-go/gpt-6-luna"] // каталог отдал всё
  for (const cls of ["qc", "dev:small", "dev:large", "research:large"] as TaskClass[]) {
    const c = chooseModelByClass(l, cls, null, catalog, Date.now(), "premium")
    assert.ok(childModelAllowed(c.model), `${cls}: субагент на легальном детском звене (${c.model})`)
    assert.ok(isFreeModel(c.model), `${cls}: субагент только на *-free (${c.model})`)
    assert.ok(!/luna/i.test(c.model), `${cls}: luna в детском пуле мертва (${c.model})`)
  }
  // Owner-pin qc → GLM free работает (pin в детском пуле) даже под «прем»-pole
  l.updated_at = "2026-10-07T12:00:00.000Z" // детерминизм: shouldReexamine сидится от updated_at (урок T84-флейка)
  const pinned = chooseModelByClass(l, "qc", DEMON_MODEL, catalog)
  assert.equal(pinned.model, DEMON_MODEL, "пин qc → GLM free действует")
  assert.ok(pinned.reason.includes("owner-pin"), "причина честная: owner-pin")
  // Прогретая модель ведёт выбор по stats внутри детского пула
  for (let i = 0; i < 3; i++) recordModelResultByClass(l, DEMON_MODEL, "qc", true, 5.0)
  l.updated_at = "2026-10-07T12:00:00.000Z" // повторный пин: запись статов могла сдвинуть updated_at
  const warm = chooseModelByClass(l, "qc", null, catalog, Date.now(), "premium")
  assert.equal(warm.model, DEMON_MODEL, "прогретый GLM free выигрывает qc-класс")
  // A127-аварию сохраняем: каталог сузился до одной модели → выбор всё равно сделан
  const emergency = chooseModelByClass(l, "dev:small", null, [DEMON_MODEL])
  assert.equal(emergency.model, DEMON_MODEL, "вторичка A127: не пустой выбор")
})

test("T142: luna недостижим для детей даже с прогретой статистикой (гард по имени)", () => {
  const l = freshLedger()
  // Гипотеза «лучшая модель — Go-mimo/luna»: record даёт Go-mimo и луне лучший
  // score, но детский гард пускает только *-free, luna мертва.
  for (let i = 0; i < 10; i++) recordModelResultByClass(l, INSTANCE_MODEL, "dev:small", true, 50.0)
  l.updated_at = "2026-10-07T12:00:00.000Z"
  const c = chooseModelByClass(l, "dev:small", null, [...POLICY_MODELS, INSTANCE_MODEL, "opencode-go/gpt-6-luna"], Date.now(), "premium")
  assert.ok(childModelAllowed(c.model) && isFreeModel(c.model) && !/luna/i.test(c.model), `детский выбор проходит free-гард без luna (${c.model})`)
})

test("T142: quotaFallbackModel — ротация по детскому free-пулу, luna/премиум неприкасаемы", () => {
  const l = freshLedger()
  // Детская цепочка крутит себя: из звена 1 → звено 2
  const next = quotaFallbackModel(l, DEMON_MODEL)
  assert.ok(POLICY_MODELS.includes(next) && next !== DEMON_MODEL, `ротация внутри детской цепочки: ${next}`)
  // Консольная free-линия крутит детский free-пояс: за mimo идёт deepseek
  assert.equal(quotaFallbackModel(l, "opencode/mimo-v2.6-flash-free"), "opencode/deepseek-v4.1-flash-free")
  // Премиум-строка (INSTANCE / luna) у детей в ключах не крутится: ключ mimo
  // резолвится в БЕСПЛАТНУЮ консольную модель, ротация уходит в free
  const fromPremiumKey = quotaFallbackModel(l, INSTANCE_MODEL)
  assert.ok(isFreeModel(fromPremiumKey) && !/luna/i.test(fromPremiumKey), "ключ Go-mimo у ребёнка резолвится в консольную free и уходит в пояс")
  assert.equal(quotaFallbackModel(l, "opencode-go/gpt-6-luna"), NEMOTRON_MODEL, "luna вне детского пула → старт со второго звена цепочки")
  // Кулдаун пропускается: не выбирать некого → агент встал бы (T97-корень)
  setModelCooldown(l, "opencode/deepseek-v4.1-flash-free", COOLDOWN_MS, 0)
  assert.equal(quotaFallbackModel(l, "opencode/mimo-v2.6-flash-free", 1), "opencode/flint-40b-free", "кулдаун пропускается (шаг через охлаждённый deepseek)")
  // 16.11 пул расширен сайт-листом: за beam идёт minimax, НОВЫЙ хвост — iceman,
  // он и сворачивается на голову (звено 1)
  assert.equal(quotaFallbackModel(l, "opencode/beam-free"), "opencode/minimax-m3.1-flash-free", "beam → следующее звено нового хвоста")
  assert.equal(quotaFallbackModel(l, "opencode/iceman-free"), DEMON_MODEL, "iceman (хвост пула) → очередь с головы (GLM free)")
  // Всё в кулдауне → выбор всё равно делается (работа не встаёт)
  for (const m of FREE_POOL) setModelCooldown(l, m, COOLDOWN_MS, 0)
  setModelCooldown(l, DEMON_MODEL, COOLDOWN_MS, 0)
  setModelCooldown(l, NEMOTRON_MODEL, COOLDOWN_MS, 0)
  const all = quotaFallbackModel(l, "opencode/mimo-v2.6-flash-free", 1)
  assert.ok(POLICY_MODELS.includes(all) || FREE_POOL.includes(all), `всё в кулдауне → не пусто (${all})`)
  // Модель вне пула → очередь детского пула (T142: полюс решает больше ничего)
  assert.ok(CHILD_MODELS.includes(quotaFallbackModel(l, "opencode/unknown-xyz", 1)), "не из пула → детская free-очередь")
})

// DoD T142: «агент на квоте выживает» — та же последовательность, что в
// prompt-catch index.ts (узнали квоту → кулдаун → ротация → повтор промпта):
// ПОВТОРНЫЙ диспатч уходит на следующее легальное *-free звено детского пула.
test("T142: симуляция квоты в prompt-catch — ребёнок продолжает на следующем звене", () => {
  const l = freshLedger()
  const current = DEMON_MODEL // дефолт-звено, на нём «упала» квота
  const quotaText = "APIError: provider quota exceeded for this month (HTTP 429)"
  assert.equal(isRateLimited(quotaText), true, "catch узнаёт квот-ошибку")
  // шаг 1-2 как в index.ts: кулдаун текущей + guard в шапку, затем ротация
  assert.ok(setModelCooldown(l, current, COOLDOWN_MS, 1_000), "кулдаун текущей зафиксирован")
  const next = quotaFallbackModel(l, current, 1_001)
  assert.ok(childModelAllowed(next) && isFreeModel(next) && next !== current, `повторный промпт уходит в следующее free-звено (${next})`)
  assert.ok(POLICY_MODELS.includes(next), "цель ротации — внутри детской free-цепочки")
  assert.equal(modelUsable(l, next, 1_001), true, "цель пригодна: проходит гард и нет кулдауна")
  assert.equal(modelUsable(l, current, 1_001), false, "текущая в кулдауне — второй раз на неё не идём")
})

test("T142: modelUsable — детский гард (только *-free, luna-бан) и кулдаун", () => {
  const l = freshLedger()
  assert.equal(modelUsable(l, INSTANCE_MODEL), false, "Go-mimo — премиум-канал основателя, субагенту не наследуется")
  assert.equal(modelUsable(l, DEMON_MODEL), true, "free-звено политики пригодно")
  assert.equal(modelUsable(l, "opencode/unknown-model"), false, "чужая модель не из пула")
  assert.equal(modelUsable(l, "opencode/deepseek-v4.1-flash-free"), true, "free-пояс пригоден")
  assert.equal(modelUsable(l, "opencode-go/gpt-6-luna"), false, "luna на Go заблокирована по имени")
  assert.equal(modelUsable(l, "opencode/gpt-6-luna"), false, "luna на консоли заблокирована по имени")
  assert.equal(modelUsable(l, "opencode-go/beam-free"), true, "free в Go-канале легальна")
  assert.equal(modelUsable(l, "opencode-go/mimo-v2.6-flash"), false, "премиум Go субагенту закрыт")
  setModelCooldown(l, DEMON_MODEL, COOLDOWN_MS, 0)
  assert.equal(modelUsable(l, DEMON_MODEL, 1), false, "в кулдауне не пригоден")
})

test("T132: кулдаун и статистика касаются ВСЕЙ партии (free-пояс + политика), не только политики", () => {
  const l = freshLedger()
  assert.ok(setModelCooldown(l, "opencode/deepseek-v4.1-flash-free", COOLDOWN_MS, 1_000), "квота free-модели фиксируется")
  assert.ok(setModelCooldown(l, "opencode/nemotron-3.5-super-vl-free", COOLDOWN_MS, 1_000), "ротация закрывает и третью")
  const cooled = modelStats(l).filter((s) => s.cooldown_until !== null).map((s) => s.model)
  assert.equal(cooled.length, 2, "оба кулдауна записаны")
  assert.match(cooled[0], /^opencode\/deepseek-v4\.1-flash-free$/, "ключ deepseek → консольная free")
  assert.match(cooled[1], /^opencode\/nemotron-3\.5-super-vl-free$/, "ключ nemotron-vl → консольный free-дом")
  assert.ok(cooled.every((m) => !/luna/i.test(m)), "никакой luna в статистике")
  assert.equal(recordModelResult(l, "opencode/flint-40b-free", true)?.ok, 1, "статистика free-модели копится")
  assert.equal(resetModelCooldowns(l), 2, "model_reset снимает кулдауны партии")
})

test("T132: квоты — guard 100% > Console API > Σcost/токены за rolling-окно", () => {
  const at = Date.parse("2026-10-29T05:40:00.000Z")
  // Console API отдал проценты (путь готов: сейчас 404, включится — заработает)
  const c = parseConsoleQuota({ rolling: 100, weekly: "46%", monthly: 23 }, at)
  assert.equal(c?.source, "console")
  assert.equal(c?.rollingPct, 100)
  assert.equal(c?.weeklyPct, 46, "строка с % принимается")
  assert.equal(c?.monthlyPct, 23)
  assert.equal(parseConsoleQuota({ foo: 1 }, at), null, "процентов нет → не выдумываем")
  assert.equal(parseConsoleQuota(null, at), null)
  // Σcost/токены за окно: снаружи окна — не считаем, без updated — не доказано
  const items = [
    { cost: 0.117, tokens: { input: 100, output: 20 }, time: { updated: at - 60_000 } },
    { cost: 5, tokens: { input: 999 }, time: { updated: at - 4 * 3_600_000 } }, // старше 93м
    { cost: 0.5, tokens: { input: 50, cache: { read: 30 } }, time: { updated: at } },
    { cost: 9 }, // без updated → не доказано
  ]
  const u = rollingUsage(items, at)
  assert.equal(u.source, "cost")
  assert.equal(u.sessions, 2)
  assert.equal(Math.round(u.costUsd * 1000), 617, "Σcost за окно = 0.117 + 0.5 = 0.617 (старая сессия с cost=5 снаружи)")
  assert.equal(u.tokens, 200, "Σтокенов = input+output+cache.read")
  assert.equal(u.rollingPct, null, "лимит провайдер не публикует — процента не выдумываем")
  assert.equal(u.windowMin, ROLLING_WINDOW_MIN, "окно93м = «сброс ~1ч33м» из живой пробы 29.10")
  // guard: доказанная квота = 100% до сброса, главнее любых цифр
  const g = quotaGuardUsage(at, at + 600_000)
  assert.equal(g.rollingPct, 100)
  assert.equal(mergeQuota(g, c, u)?.source, "guard", "доказанная квота главнее процента провайдера")
  assert.equal(mergeQuota(null, c, u)?.source, "console")
  assert.equal(mergeQuota(null, null, u)?.source, "cost")
  assert.equal(mergeQuota(null, null, null), null, "ничего нет → null (пустых цифр в шапке не рисуем)")
  assert.equal(mergeQuota(g, null, u)?.tokens, u.tokens, "guard наследует измеренный расход")
})

test("T132/T137: форматтер квоты несёт Rolling, но ШАПКА панели его больше не рисует", () => {
  assert.equal(formatQuotaHeader(null), null)
  assert.equal(formatQuotaHeader(rollingUsage([], Date.now())), null, "ничего не измерено → без пустых цифр")
  assert.equal(formatQuotaHeader(parseConsoleQuota({ rolling: 46, weekly: 10 })), "Rolling 46% · Week 10%")
  const reset = new Date(2026, 9, 29, 7, 15) // локальное время → вывод без TZ-сюрпризов
  const warn = quotaGuardUsage(0, reset.getTime())
  assert.equal(formatQuotaHeader(warn), "Rolling 100% · ⚠ · сброс 07:15")
  assert.equal(quotaWarning(warn), true)
  assert.equal(quotaWarning(parseConsoleQuota({ rolling: 79 })), false, "⚠ только на ≥80")
  assert.equal(quotaWarning(null), false)
  // …и доехало до самой панели: шапка ИНСТАНСЫ с квотой
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_t132quota", title: "Квота · Маруська Гольденштерн", model: "mimo-v2.6-flash", last_seen: new Date().toISOString() })
  const ui = project(l, null, undefined, null, undefined, false, false, null, warn).ui
  assert.ok(!ui.includes("Rolling"), "T137: Rolling убран из шапки ИНСТАНСЫ (канон T129)")
  assert.equal(quotaWarning(warn), true, "⚠-порог жив — будильник, не шапка (T137)")
})

// ------------------------------------------------------------------ T128 ---
test("T128: settle пишет overrun_min = max(0, факт − план) и копит в суточном накопителе", () => {
  const l = freshLedger()
  // (1) переработка: план 5м, факт 25м → +20м
  const over = beginAgent(l, { input: { agent: "general", description: "[T1] slow" }, ref: "ses_slow", home: "ses_home" })
  over.eta_min = 5
  over.began_at = new Date(Date.now() - 25 * 60000).toISOString()
  const s1 = settleAgent(l, "completed", "ses_slow")
  assert.ok(s1!.counters!.overrun_min > 19 && s1!.counters!.overrun_min < 21, `overrun ≈ 20м: ${s1!.counters!.overrun_min}`)
  assert.equal(overrunOfDay(l), s1!.counters!.overrun_min, "накопитель принял переработку")
  assert.ok(overrunOfDay(l, "ses_home") > 19, "накопитель разбит по инстансу (home)")
  // (2) уложился: план 30м, факт 3м → 0, накопитель не растёт
  const fast = beginAgent(l, { input: { agent: "general", description: "[T2] fast" }, ref: "ses_fast", home: "ses_home" })
  fast.eta_min = 30
  fast.began_at = new Date(Date.now() - 3 * 60000).toISOString()
  const s2 = settleAgent(l, "completed", "ses_fast")
  assert.equal(s2!.counters!.overrun_min, 0, "уложился — переработки нет")
  assert.equal(overrunOfDay(l, "ses_home"), s1!.counters!.overrun_min, "ноль не капает в накопитель")
})

test("T128: settleOnEvent completed→failed (death stronger) НЕ задваивает накопитель", () => {
  const l = freshLedger()
  const a = beginAgent(l, { input: { agent: "general", description: "[T1] x" }, ref: "ses_death", home: "ses_h" })
  a.eta_min = 5
  a.began_at = new Date(Date.now() - 25 * 60000).toISOString()
  settleOnEvent(l, "completed", "ses_death")
  const afterFirst = overrunOfDay(l)
  assert.ok(afterFirst > 19, "первый settle посчитал")
  settleOnEvent(l, "failed", "ses_death", "session died") // смерть сильнее раннего settle
  assert.equal(overrunOfDay(l), afterFirst, "terminal→terminal не прибавляет повторно")
})

test("T128: накопитель durable — переживает save/load, чужой день = ноль (разрыв паузой)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-t128-"))
  const file = join(dir, "state.json")
  try {
    const l = freshLedger()
    const a = beginAgent(l, { input: { agent: "general", description: "[T1] x" }, ref: "ses_d", home: "ses_h" })
    a.eta_min = 5
    a.began_at = new Date(Date.now() - 23 * 60000).toISOString()
    settleAgent(l, "completed", "ses_d")
    const amount = overrunOfDay(l)
    assert.ok(amount > 17, `переработка измерена: ${amount}`)
    saveLedger(file, l)
    // рестарт: леджер грузится с накопителем (как T92 injection_count в записях)
    const loaded = loadLedger(file)
    assert.equal(overrunOfDay(loaded), amount, "накопитель пережил рестарт")
    assert.equal(overrunOfDay(loaded, "ses_h"), amount, "разбивка по инстансу пережила рестарт")
    // разрыв паузой: счётчики вчерашнего дня не в счёт (новые сутки = новые сутки)
    loaded.overruns = { day: "2000-01-01", total_min: 999, by_home: { ses_h: 999 } }
    assert.equal(overrunOfDay(loaded), 0, "чужой день читается нулём")
    assert.equal(overrunOfDay(loaded, "ses_h"), 0, "чужой день по инстансу тоже ноль")
    // …и смена дня сбрасывает накопитель при следующем settle
    const b = beginAgent(loaded, { input: { agent: "general", description: "[T2] y" }, ref: "ses_d2", home: "ses_h" })
    b.eta_min = 1
    b.began_at = new Date(Date.now() - 6 * 60000).toISOString()
    settleAgent(loaded, "completed", "ses_d2")
    assert.ok(overrunOfDay(loaded, "ses_h") < 10, "старые сутки обнулены, капнула только новая переработка")
    // мусор в накопителе не роняет загрузку
    const raw = JSON.parse(JSON.stringify({ version: 1, updated_at: new Date().toISOString(), tasks: [], agents: [], tabs: [], overruns: { day: "2026-10-29", total_min: "x", by_home: { a: -5, b: 3 } } }))
    writeFileSync(file, JSON.stringify(raw), "utf8")
    const cleaned = loadLedger(file)
    assert.equal(cleaned.overruns?.total_min, 0, "мусорная сумма вычищена")
    assert.deepEqual(cleaned.overruns?.by_home, { b: 3 }, "отрицательные/строковые значения вычищены")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("T128: панельная строка вкладки — «⏱+Nм» при переработке, без неё строка как раньше", () => {
  const l = freshLedger()
  const seen = new Date().toISOString()
  upsertTab(l, { session_id: "ses_over", title: "Переработчик · Маруська Гольденштерн", model: "mimo-v2.6-flash", last_seen: seen })
  upsertTab(l, { session_id: "ses_norm", title: "Норма · Маруська Гольденштерн", model: "mimo-2.6-flash", last_seen: seen })
  // живой агент вкладки уже переработал план: план 10м, шла 28м
  const a = beginAgent(l, { input: { agent: "general", description: "[T1] over" }, ref: "ses_child1", home: "ses_over" })
  a.eta_min = 10
  a.began_at = new Date(Date.now() - 28 * 60000).toISOString()
  // у соседа всё в рамках: план 30м, шла 5м
  const b = beginAgent(l, { input: { agent: "general", description: "[T2] fine" }, ref: "ses_child2", home: "ses_norm" })
  b.eta_min = 30
  b.began_at = new Date(Date.now() - 5 * 60000).toISOString()
  const ui = project(l).ui
  const lines = ui.split("\n")
  const rowOver = stateOf(lines, identityOf(ui, "Переработчик"))
  // T157: переработка и время — на оси-1, статус последним словом
  assert.match(rowOver, /⏱\+18м · \d{2}:\d{2} · работает ⏱$/, `переработка на оси-1 (T157): ${rowOver}`)
  const rowNorm = stateOf(lines, identityOf(ui, "Норма"))
  assert.ok(!rowNorm.includes("⏱+"), `без переработки метки нет: ${rowNorm}`)
  assert.match(rowNorm, /работает ⏱$/, `ось-1 без переработки как раньше: ${rowNorm}`)
  // суточный накопитель инстанса тоже доезжает до строки (settle'нутые демоны)
  settleAgent(l, "completed", "ses_child1")
  settleAgent(l, "completed", "ses_child2")
  assert.ok(overrunOfDay(l, "ses_over") > 17, "после settle переработка в накопителе")
  const ui2 = project(l).ui
  const rowSettled = stateOf(ui2.split("\n"), identityOf(ui2, "Переработчик"))
  assert.ok(rowSettled.includes("⏱+"), `суточный накопитель виден на оси-1 после settle: ${rowSettled}`)
  // шапка ИНСТАНСЫ несёт агрегат «переработка за сутки»
  assert.ok(ui2.includes(`🤖 ИНСТАНСЫ`) && ui2.includes(formatOverrunSuffix(overrunOfDay(l))), `агрегат в шапке секции: ${ui2.split("\n")[0]}`)
})

test("T128: живая переработка и порог дубль-буждения (2× плана, не kill)", () => {
  const at = Date.now()
  // liveOverrunMin: только у живых, ≥0, работает от began_at
  const live = { state: "running" as const, began_at: new Date(at - 47 * 60000).toISOString(), eta_min: 30 }
  assert.ok(Math.abs(liveOverrunMin(live, at) - 17) < 1, "живой перелёт = факт − план")
  assert.equal(liveOverrunMin({ ...live, state: "completed" }, at), 0, "закрытый агент не считается живым")
  assert.equal(liveOverrunMin({ ...live, eta_min: 0 }, at), 0, "без плана перелёт не выдумывается")
  // overrunWakeReason: < 2× плана → тишина; ≥ 2× → причина для оркестратора.
  // Канон T128: overrun = факт − план; будим при overrun ≥ 2×план (факт ≥ 3×план):
  // план 30м → тишина до факта 90м, с 91м — причина.
  assert.equal(overrunWakeReason({ ...live, began_at: new Date(at - 31 * 60000).toISOString() }, at), null, "overrun 1м < 2×30м — не будим")
  assert.equal(overrunWakeReason(live, at), null, "overrun 17м < 60м — ещё тишина, но живой перелёт уже виден")
  const deep = { ...live, began_at: new Date(at - 91 * 60000).toISOString() }
  const reason = overrunWakeReason(deep, at)
  assert.ok(reason !== null && reason.includes("переработка 61м") && reason.includes("2×"), `порог ≥2×: ${reason}`)
  assert.equal(OVERRUN_WAKE_FACTOR, 2, "канон: дубль-буждение на 2× плана")
  assert.equal(overrunWakeReason({ ...live, state: "failed" }, at), null, "мёртвого не будим")
  // formatOverrunSuffix: 0/пусто → пусто, иначе «⏱+18м»
  assert.equal(formatOverrunSuffix(0), "", "ноль метки не рисует")
  assert.equal(formatOverrunSuffix(18.4), "⏱+18м", "минуты округляются")
})

// T135 · ДЕЛЬТЫ СОСТОЯНИЯ для get_state (гипотеза Основателя 29.10)
import { stateSigs, changedSections, projectAgentsBrief } from "./state.ts"

test("T135: changedSections называет ровно изменившиеся секции", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "задача" })
  const s1 = stateSigs(l, 5)
  assert.deepEqual(changedSections(s1, stateSigs(l, 5)), [], "без правок — пусто")
  must(l, { op: "set_state", id: "T1", state: "DOING" })
  assert.deepEqual(changedSections(s1, stateSigs(l, 5)), ["tasks"], "смена состояния задачи = tasks")
  assert.deepEqual(changedSections(stateSigs(l, 5), stateSigs(l, 7)), ["chat"], "новые строки чата = chat")
})

test("T135: projectAgentsBrief — компактная строка на агента", () => {
  const l = freshLedger()
  l.agents.push({
    id: "A99", task_id: "T9", label: "x", kind: "general", state: "running",
    session_ref: "s", model: "mimo-v2.6-flash", began_at: "2026-10-29T00:00:00Z",
    updated_at: "2026-10-29T00:10:00Z", counters: {},
  } as never)
  assert.match(projectAgentsBrief(l), /A99 T9 running mimo-v2\.6-flash/, "строка агента на месте")
})

// ---------------------------------------------- T141: гейт проб-вкладок ----
test("T141: пробные табы (probe/__probe/New session) не регистрируются; настоящие — регистрируются", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_t141a", title: "probe T123 quota-test" })
  upsertTab(l, { session_id: "ses_t141b", title: "__probe T123 panel opencode/glm" })
  upsertTab(l, { session_id: "ses_t141c", title: "New session" })
  assert.equal(l.tabs.length, 0, "пробные сессии — не вкладки (гейт T141)")
  const real = upsertTab(l, { session_id: "ses_t141d", title: "Настоящая вкладка · Маруська" })
  assert.equal(l.tabs.length, 1, "настоящая — зарегистрирована")
  assert.ok(real.emoji, "настоящая получила свою запись")
  // повторный upsert той же настоящей — идемпотентен
  upsertTab(l, { session_id: "ses_t141d", title: "Настоящая вкладка · Маруська" })
  assert.equal(l.tabs.length, 1, "дублей нет")
})
// ------------------------------------------- T130: гейт идентификаторов ---
// Урок P0 29.10: потерянный экспорт прошёл PARSE --check и убил все диспатчи.
// Гейт без зависимостей (import_gate.ts): статическая сверка импортов с экспортами.
test("T130: гейт ловит потерянный экспорт (негативная проба P0 29.10)", () => {
  const ex = exportsOf("export const a = 1\nexport async function b() {}\nexport type C = number\nexport { d as e }\n")
  assert.ok(ex.has("a") && ex.has("b") && ex.has("C") && ex.has("e"), "экспорты собраны (const/async fn/type/alias)")
  const imps = importsOf('import { a, lost, type C } from "./state.ts"\nimport { Plugin } from "@opencode/plugin"\n')
  assert.deepEqual(imps[0].names, ["a", "lost", "C"], "импорты разобраны (комментарии/типы отброшены)")
  assert.deepEqual(imps[0].names.filter((n) => !ex.has(n)), ["lost"], "потерянный экспорт найден — гейт не пропустит P0")
})
test("T130: runtime modules/import_gate — импорты сходятся с экспортами", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url))
  for (const f of ["index.ts", "state.ts", "cpu.ts", "personas.ts", "ritual.ts", "server_guard.ts", "import_gate.ts"]) {
    assert.deepEqual(gapsIn(join(dir, f)), [], `${f}: потерянные импорты (см. import_gate.ts)`)
  }
})
// ------------------- T124: est_min персистится (фрагмент №2, заказ 29.10) ---
test("T124: update пишет est_min в леджер — продление плана не фиктивно", () => {
  const l = freshLedger()
  const created = applyOp(l, { op: "create", task: "продление плана" })
  assert.equal(created.ok, true)
  const id = (created as { ok: true; task: Task }).task.id
  const up = applyOp(l, { op: "update", id, est_min: 40 })
  assert.equal(up.ok, true)
  assert.equal((l.tasks.find((t) => t.id === id) ?? ({} as Task)).est_min, 40, "est_min записан в канонический леджер")
  const cleared = applyOp(l, { op: "update", id, est_min: null })
  assert.equal(cleared.ok, true)
  assert.equal((l.tasks.find((t) => t.id === id) ?? ({} as Task)).est_min ?? null, null, "null очищает план")
  assert.equal(applyOp(l, { op: "update", id, est_min: -5 }).ok, false, "отрицательный отклонён")
  assert.equal(applyOp(l, { op: "update", id, est_min: Number.NaN }).ok, false, "NaN отклонён")
})
// ------------------------------------- T94: очередь тест-серверов (11.11) ---
import { serverQueueAdd, serverQueueTake, serverReservationActive } from "./state.ts"
test("T94: очередь тест-серверов — FIFO, дедуп, TTL брони (без ИИ-логики)", () => {
  let q = serverQueueAdd([], { path: "C:/r", owner: "A1", kind: "test", since: "2026-11-11T00:00:00Z" })
  q = serverQueueAdd(q, { path: "C:/r", owner: "A1", kind: "test", since: "2026-11-11T00:01:00Z" })
  q = serverQueueAdd(q, { path: "C:/r", owner: "A2", kind: "test", since: "2026-11-11T00:02:00Z" })
  q = serverQueueAdd(q, { path: "C:/other", owner: "A3", kind: "test", since: "2026-11-11T00:03:00Z" })
  assert.equal(q.length, 3, "дубль A1 не добавлен; чужой репо — отдельная строка")
  const t1 = serverQueueTake(q, "C:/r")
  assert.equal(t1.next?.owner, "A1", "первым пришёл — первым забрал (FIFO)")
  const t2 = serverQueueTake(t1.rest, "C:/r")
  assert.equal(t2.next?.owner, "A2", "следующий по очереди")
  assert.equal(serverQueueTake(t2.rest, "C:/r").next, null, "пустой репо-очередь")
  assert.equal(serverQueueTake(q, "C:/other").next?.owner, "A3", "очереди по репо независимы")
  const at = Date.parse("2026-11-11T00:10:00Z")
  assert.equal(serverReservationActive({ reserved_for: "A2", reserved_at: "2026-11-11T00:00:00Z" }, at), true, "бронь жива")
  assert.equal(serverReservationActive({ reserved_for: "A2", reserved_at: "2026-11-11T00:00:00Z" }, Date.parse("2026-11-11T02:00:00Z")), false, "TTL истёк — призрак снят")
  assert.equal(serverReservationActive(null), false)
  assert.equal(serverReservationActive({ reserved_for: "A2" }, at), false, "без времени брони — неактивна")
})
// ------------------------------------ T120(3): процент шапки не врёт --------
import { formatHeaderPercent } from "./state.ts"
test("T120(3): шапка подаёт ДВА процента с подписями — по времени и по задачам", () => {
  const a = formatHeaderPercent(93, 93, 111)
  assert.equal(a.text, "по времени 93% · задачи 83% (93/111)", "числа не смешаны, подписи явные")
  assert.match(a.tooltip, /закрытые минуты.*DONE/, "формула в тултипе")
  const b = formatHeaderPercent(null, 5, 10)
  assert.equal(b.text, "задачи 50% (5/10)", "без времени — только счётная доля")
  const c = formatHeaderPercent(40, 0, 3)
  assert.equal(c.text, "по времени 40% · задачи 0% (0/3)", "ноль задач DONE — честный 0%")
  const d = formatHeaderPercent(null, 0, 0)
  assert.equal(d.text, "", "пустой леджер — процента не выдумываем")
})
// ------------------- T125: эмодзи/мигание — только прямой чат с Основателем ---
import { isDirectConversation } from "./state.ts"
test("T125: эмодзи и мигание — только прямой чат; фон/пробники/служебные без них", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_chat", title: "Обсуждение задач · Маруська Гольденштерн", last_seen: new Date().toISOString() })
  upsertTab(l, { session_id: "ses_probe", title: "__probe T123 panel", last_seen: new Date().toISOString() })
  upsertTab(l, { session_id: "ses_task", title: "T47 · Guard дублей", last_seen: new Date().toISOString() })
  upsertTab(l, { session_id: "ses_meta", title: "Acknowledging exact reply request", last_seen: new Date().toISOString() })
  assert.equal(isDirectConversation("ses_chat", l), true, "живой чат — прямой")
  assert.equal(isDirectConversation("ses_probe", l), false, "пробник бенча — не чат")
  assert.equal(isDirectConversation("ses_task", l), false, "сессия задачи (ребёнок) — не чат")
  assert.equal(isDirectConversation("ses_meta", l), false, "harness-мета-промпт — не чат")
  assert.equal(isDirectConversation("ses_unknown", l), false, "неизвестная сессия — не чат")
  assert.equal(autoBlinkAction("простаивает", "работает ⏱", false, false, false), "none", "фон не мигает")
  assert.equal(autoBlinkAction("простаивает", "работает ⏱", false, false, true), "start", "чат мигает как раньше")
  const lines = project(l).ui.split("\n")
  const probeLine = lines.find((x) => x.includes("__probe T123 panel")) ?? ""
  const chatLine = lines.find((x) => x.includes("Обсуждение задач")) ?? ""
  assert.ok(!INSTANCE_EMOJI.some((e) => probeLine.includes(e)), `пробник без эмодзи: ${probeLine}`)
  assert.ok(INSTANCE_EMOJI.some((e) => chatLine.includes(e)), `чат с эмодзи: ${chatLine}`)
})
// ------------------- T124: канал жалоб — дедуп, сброс аck, проекция -----
import { addComplaint, acknowledgeComplaint, loadComplaints, saveComplaints, makeDedupKey, COMPLAINT_COMPONENTS, formatComplaintsSection } from "./state.ts"
const cDir = mkdtempSync(join(tmpdir(), "devata-test-complaints-"))
after(() => rmSync(cDir, { recursive: true, force: true }))
function fresh(complaints: Complaint[]): void { saveComplaints(cDir, complaints) }
test("T124: одна и та же жалоба не дублится в окне — обновится ts", () => {
  fresh({ complaints: [] })
  const c1 = addComplaint(cDir, { author: "ses_1", session: "ses_1", task: "T1", component: "models", text: "модель не отвечает на инжект контекста" })
  assert.ok(c1, "первая добавлена")
  const c2 = addComplaint(cDir, { author: "ses_2", session: "ses_2", task: null, component: "models", text: "модель не отвечает на инжект контекста" })
  assert.equal(c2.id, c1.id, "дедуп: тот же id, не дубль")
  const all = loadComplaints(cDir)
  assert.equal(all.length, 1, "в хранилище — одна запись")
})
test("T124: разный компонент или текст — отдельная жалоба", () => {
  fresh({ complaints: [] })
  addComplaint(cDir, { author: "ses_1", session: null, task: null, component: "models", text: "модель не отвечает" })
  addComplaint(cDir, { author: "ses_1", session: null, task: null, component: "routing", text: "модель не отвечает" })
  assert.equal(loadComplaints(cDir).length, 2, "компоненты разные — две жалобы")
})
test("T124: acknowledgeComplaint помечает и держит", () => {
  fresh({ complaints: [] })
  const c = addComplaint(cDir, { author: "ses_1", session: null, task: null, component: "runtime", text: "рантайм падает" })
  assert.ok(acknowledgeComplaint(cDir, c.id), "ack это")
  assert.equal(acknowledgeComplaint(cDir, "нет такого"), false, "неизвестный id — false")
  assert.equal(loadComplaints(cDir)[0].ack, true, "сохранено")
})
test("T124: makeDedupKey стабильный, компонент известен", () => {
  assert.equal(makeDedupKey("models", "ABC"), makeDedupKey("models", "abc"), "регистр не важен")
  assert.notEqual(makeDedupKey("models", "ABC"), makeDedupKey("routing", "ABC"), "компонент в ключе")
  assert.ok(COMPLAINT_COMPONENTS.includes("init"), "компонент init есть")
})
test("T124: проекция секции — новые сверху, старые обрезаются, без — пусто", () => {
  assert.equal(formatComplaintsSection([]), "")
  const many = []
  for (let i = 0; i < 25; i++) many.push({ id: `c_${i}`, author: `a${i}`, session: null, task: null, component: "runtime", text: `жалоба №${i}`, ts: new Date(Date.now() + i * 1000).toISOString(), ack: false, dedupKey: `runtime|h${i}` })
  const sec = formatComplaintsSection(many)
  assert.ok(sec.includes("жалоба №24"), "новые сверху")
  assert.ok(!sec.includes("жалоба №0"), "старые обрезаются (лимит 20)")
  assert.match(sec, /⚠/, "компонент с иконкой")
})

// T136 · РЕТРАЙ-ТАЙМЕР БЛОКИРОВКИ (заказ Основателя 11.11: «Должны агенты работать постоянно» — не парковать задачу в BLOCKED навсегда).
test("T136: вход в BLOCKED ставит retry_at + retry_attempts с бэк-оффом (5→10→20… мин, потолок 60)", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "заблокированная" })
  must(l, { op: "set_state", id: "T1", state: "BLOCKED", why: "тестовый блок", owner: null })
  const t = l.tasks.find((x) => x.id === "T1")
  assert.equal(t.state, "BLOCKED", "статус BLOCKED")
  assert.equal(t.retry_attempts, 1, "первая попытка = 1")
  assert.ok(t.retry_at, "retry_at проставлен")
  assert.ok(Date.parse(String(t.retry_at)) > Date.now() + 4 * 60 * 1000, "первый ретрай ≈5 мин")

  must(l, { op: "set_state", id: "T1", state: "WAIT" })
  must(l, { op: "set_state", id: "T1", state: "BLOCKED", why: "ещё блок" })
  const t2 = l.tasks.find((x) => x.id === "T1")
  assert.equal(t2.retry_attempts, 2, "вторая попытка = 2")
  assert.ok(Date.parse(String(t2.retry_at)) > Date.now() + 8 * 60 * 1000, "второй ретрай ≈10 мин (бэк-офф)")

  must(l, { op: "set_state", id: "T1", state: "DOING" })
  const t3 = l.tasks.find((x) => x.id === "T1")
  assert.equal(t3.retry_at, null, "DOING сбрасывает retry_at")
  assert.equal(t3.retry_attempts, null, "DOING сбрасывает retry_attempts")
})

test("T136: потолок бэк-оффа — 60 минут", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "много блоков" })
  let t = l.tasks.find((x) => x.id === "T1")
  for (let i = 0; i < 6; i++) {
    // WAIT→WAIT — no-op по канону (задача уже в очереди), поэтому первый виток
    // идёт сразу в BLOCKED; дальше цикл WAIT→BLOCKED (backs off 5→10→20→40→60).
    if (i > 0) must(l, { op: "set_state", id: "T1", state: "WAIT" })
    must(l, { op: "set_state", id: "T1", state: "BLOCKED", why: "блок " + (i + 1) })
    t = l.tasks.find((x) => x.id === "T1")
  }
  const delayMs = Date.parse(String(t.retry_at)) - Date.now()
  assert.ok(delayMs > 55 * 60 * 1000 && delayMs <= 65 * 60 * 1000, "потолок 60 мин, реально " + Math.round(delayMs / 60000) + "м")
})

// ------------------- T94: протокол сервера для задач (чистые функции) -----
import { parseServerRequest, decideServerRequest, type ServerRequest } from "./state.ts"
test("T94: parseServerRequest — валидный запрос разобран, мусор отброшен", () => {
  const ok = parseServerRequest(JSON.stringify({ path: "C:/repo", kind: "test", owner: "A1", cmd: "npm run dev", port: 3000 }))
  assert.ok(ok, "запрос разобран")
  assert.equal(ok.path, "C:/repo")
  assert.equal(ok.kind, "test")
  assert.equal(ok.owner, "A1")
  assert.equal(ok.cmd, "npm run dev")
  assert.equal(ok.port, 3000)
  assert.equal(parseServerRequest("{ not json"), null, "мусор → null")
  assert.equal(parseServerRequest(JSON.stringify({ kind: "test", owner: "A1" })), null, "без path → null")
  assert.equal(parseServerRequest(JSON.stringify({ path: "C:/repo" })), null, "без owner → null")
  const def = parseServerRequest(JSON.stringify({ path: "C:/repo", owner: "A1" }))
  assert.equal(def?.kind, "dev", "вид по умолчанию — dev")
})
test("T94: decideServerRequest — reuse / spawn / queue по факту слота", () => {
  const req: ServerRequest = { path: "C:/repo", kind: "dev", owner: "A1" }
  assert.deepEqual(decideServerRequest(req, { pid: 42, port: 3000 }, null, []), { action: "reuse", port: 3000, pid: 42 }, "живой сервер → reuse")
  assert.deepEqual(decideServerRequest(req, null, null, []), { action: "spawn" }, "слот свободен → spawn")
  assert.deepEqual(decideServerRequest(req, null, "A2", []), { action: "queue", position: 1 }, "бронь другому → queue")
  assert.deepEqual(decideServerRequest({ ...req, owner: "A2" }, null, "A2", []), { action: "spawn" }, "бронь себе → spawn")
})
// ------------------- T146: гейт ловит «вызов без импорта» (ReferenceError) ----
import { undefinedUsesIn, calledNames, declaredNames } from "./import_gate.ts"
test("T146: import-gate ловит вызов ЭКСПОРТА без импорта (ReferenceError в рантайме)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-t146-"))
  try {
    const stateSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "state.ts"), "utf8")
    writeFileSync(join(dir, "state.ts"), stateSrc, "utf8")
    const bad = 'import { project } from "./state.ts"\nexport const go = (): string => {\n  const r = loadComplaints("C:/x")\n  return project({} as never).ui + r.length\n}\n'
    const badFile = join(dir, "bad.ts")
    writeFileSync(badFile, bad, "utf8")
    const gaps = undefinedUsesIn(badFile)
    assert.equal(gaps.length, 1, "дыра найдена")
    assert.ok(gaps[0].names.includes("loadComplaints"), `названо имя: ${gaps[0].names.join(",")}`)
    const good = 'import { project, loadComplaints } from "./state.ts"\nexport const go = (): string => {\n  const r = loadComplaints("C:/x")\n  return project({} as never).ui + r.length\n}\n'
    const goodFile = join(dir, "good.ts")
    writeFileSync(goodFile, good, "utf8")
    assert.equal(undefinedUsesIn(goodFile).length, 0, "чистый файл — без дыр")
    const called = calledNames('foo(1); bar(2); // baz(')
    assert.ok(called.has("foo") && called.has("bar"), "вызовы найдены")
    assert.ok(!called.has("baz"), "вызов в комментарии не считается")
    const declared = declaredNames("const foo = 1; function bar(){}")
    assert.ok(declared.has("foo") && declared.has("bar"), "объявления найдены")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
// ------------------- T120: висячий отступ continuation по отступу строки -----
test("T120: отступ строки задаёт висячий отступ продолжения (padding-left по отступу)", () => {
  const html = renderConsoleHtml("  инстанс\n    ось · работает ⏱", "2026-11-11T00:00:00Z")
  // Отступ строки живёт в CSS (padding-left), а текст строки БЕЗ ведущих
  // пробелов (raw) — иначе отступ удваивался и колонки разъезжались.
  assert.ok(html.includes("d.style.paddingLeft = ind + \"ch\""), "padding-left по отступу строки")
  assert.ok(!html.includes("textIndent"), "text-indent не используется (сдвигал первую строку)")
  // Разделитель между группами — ОТДЕЛЬНЫЙ элемент .sep с white-space: pre:
  // между inline-block группами браузер схлопывал его пробелы.
  assert.ok(html.includes('<span class="sep"> · </span>'), "разделитель — отдельный span.sep")
  assert.ok(html.includes(".sep { white-space: pre; }"), "у разделителя свой white-space")
  assert.ok(html.includes("const body = escText(raw)"), "текст строки без ведущих пробелов")
  // Общий text-indent на все строки — запрещён: он сдвигал первую строку
  // каждой строки влево (жалоба Основателя 11.11 «пробелы поехали»).
  assert.ok(!html.includes("#wrap > div { max-width: 80%; padding-left:"), "нет общего сдвига первой строки")
  assert.ok(html.includes("#wrap > div { max-width: 80%; overflow-wrap: break-word; }"), "ширина/перенос остались")
  assert.ok(html.includes(".g { display: inline-block; white-space: pre-wrap; }"), "группы — инлайн-блоки")
})
// ------------------- T120(б): тултипы секций ЗАДАЧИ/агенты --------------------
test("T120(б): расшифровки групп для статусов задач, ⏳, repo и записей агентов", () => {
  const html = renderConsoleHtml("● [T120] DOING ЛЕНТА · repo: +152 · ⏳~23:00 · A181", "2026-11-15T00:00:00Z")
  // Секция ЗАДАЧИ: токен статуса леджера расшифрован
  assert.ok(
    html.includes("(WAIT|DOING|BLOCKED|GATE|DONE)"),
    "статусы задач WAIT/DOING/BLOCKED/GATE/DONE узнаются",
  )
  assert.ok(
    html.includes("статус задачи в леджере"),
    "тултип статуса задачи присутствует",
  )
  assert.ok(html.includes("/^⏳/.test(s)"), "дедлайн плана ⏳ узнаётся")
  assert.ok(html.includes("/^repo:/"), "накопленная repo-работа узнаётся")
  assert.ok(html.includes("/^A\\d+$/.test(s)"), "запись агента A## узнаётся")
})
// ------------------- T120(а): буфер копирования строки ------------------------
test("T120(а): raw строки в data-raw, двойной клик кладёт в буфер целиком", () => {
  const html = renderConsoleHtml("● [T120] DOING ЛЕНТА ЧЕЛОВЕКОЧИАЕМАЯ · тест", "2026-11-15T00:00:00Z")
  // raw живёт в data-raw: у строк вкладок title перетирается хинтом клика —
  // читаемая копия ([Txxx] + TITLE) не должна пропадать.
  assert.ok(html.includes("d.dataset.raw = raw"), "raw строки хранится в data-raw")
  assert.ok(html.includes("dblclick"), "двойной клик — копирование строки")
  assert.ok(html.includes("navigator.clipboard"), "буфер через navigator.clipboard")
  assert.ok(html.includes('document.execCommand("copy")'), "фолбэк execCommand для буфера")
  assert.ok(
    html.includes("2×клик — копировать строку"),
    "хинт вкладки не прячет читаемую копию без предупреждения",
  )
})
// ------------------- T152-остаток: одиночная «В» от мохибейка ------------------
test("T152+: одиночная «В» перед разделителем (остаток мохибейка 0xC2) снимается, слова не трогаются", () => {
  assert.equal(
    normalizeTitle("👩 Динамические имена вкладок агентов · Мария Магдалена В · Мария Магдалена"),
    "Динамические имена вкладок агентов · Мария Магдалена",
    "остаток «В» снят, дубли-хвост схлопнулся",
  )
  assert.equal(
    normalizeTitle("Статус «В РАБОТЕ» — что отображает · Маруська Гольденштерн"),
    "Статус «В РАБОТЕ» — что отображает · Маруська Гольденштерн",
    "«В РАБОТЕ» не тронут (В за ним идёт буква, не «·»)",
  )
})

// ------------------- T149: каталог плагина чист (NUL/мусор ломают загрузку) ---
test("T149: в каталоге плагина нет NUL-байтов и посторонних файлов — иначе плагин не грузится", () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const files = readdirSync(dir)
  for (const f of files) {
    const p = join(dir, f)
    if (!statSync(p).isFile()) continue
    const bytes = readFileSync(p)
    let nul = 0
    for (const b of bytes) if (b === 0) nul += 1
    assert.equal(nul, 0, f + ": NUL-байтов быть не должно (Bun: Unexpected → плагин не грузится)")
  }
  const strays = files.filter((f) => f.endsWith(".bak") || f.includes(".bak-") || f.endsWith(".tmp"))
  assert.deepEqual(strays, [], "в каталоге плагина нет посторонних файлов: " + strays.join(", "))
})

// ------------------- T150: карантин не считает чужие смерти ------------------
test("T150: upstream/unknown-смерть НЕ двигает fail и НЕ ставит карантин", () => {
  const l = freshLedger()
  for (let i = 0; i < 10; i++) recordModelResult(l, "opencode/glm-5.3-flash-free", false, "upstream")
  const s = modelStats(l).find((x) => x.model.includes("glm"))
  assert.equal(s.ok, 0, "успехов не было")
  assert.equal(s.fail, 0, "upstream-смерти НЕ считаются отказом модели")
  assert.equal(s.upstream_fails, 10, "отдельный счётчик upstream")
  // карантин по отказам: 0 отказов → карантин не ставится
  assert.equal((s.fail / Math.max(1, s.ok + s.fail)) >= 0.5, false, "карантинный порог не проходится")
})
test("T150: отказ ПО ВИНЕ МОДЕЛИ двигает fail (rate limit / no such model)", () => {
  const l = freshLedger()
  for (let i = 0; i < 8; i++) recordModelResult(l, "opencode/glm-5.3-flash-free", false, "model")
  const s = modelStats(l).find((x) => x.model.includes("glm"))
  assert.equal(s.fail, 8, "отказ модели идёт в fail")
  assert.equal(s.upstream_fails ?? 0, 0, "upstream-счётчик не тронут")
  assert.ok(s.fail / Math.max(1, s.ok + s.fail) >= 0.5, "карантинный порог проходится — карантин уместен")
})
test("T150: byClass fail только при классе model; upstream-смерти копятся в upstream_fails", () => {
  const l = freshLedger()
  must(l, { op: "create", task: "probe", owner: "dev" })
  const cls = taskClass(l, l.tasks.find((t) => t.id === "T1"))
  recordModelResultByClass(l, "opencode/mimo-v2.6-flash-free", cls, false, 0.1, "upstream")
  recordModelResultByClass(l, "opencode/mimo-v2.6-flash-free", cls, false, 0.1, "model")
  const s = modelStats(l).find((x) => x.model.includes("mimo"))
  assert.equal(s.byClass[cls].fail, 1, "в byClass.fail — только вина модели")
  assert.equal(s.fail, 1, "глобальный fail — только вина модели")
  assert.equal(s.upstream_fails, 1, "upstream-смерть — отдельно")
  assert.equal(s.byClass[cls].runs, 2, "прогоны считаются все (для статистики)")
})
// ------------------- T152: имена инстансов (раздача персон) -------------------
test("T152: раздача детерминированна — базовая Маруська старейшему, остальные по каталогу без коллизий", () => {
  const l = freshLedger()
  const ids = ["ses_base", "ses_a", "ses_b", "ses_c", "ses_d"]
  const times = ["2026-11-11T01:00:00Z", "2026-11-11T01:01:00Z", "2026-11-11T01:02:00Z", "2026-11-11T01:03:00Z", "2026-11-11T01:04:00Z"]
  ids.forEach((id, i) => upsertTab(l, { session_id: id, title: `Тема ${i} · Маруська Гольденштерн`, last_seen: times[i] }))
  const p = (sid: string) => l.tabs.find((t) => t.session_id === sid)?.persona ?? null
  assert.equal(p("ses_base"), null, "старейший таб = базовая Маруська (поле пусто, дефолт)")
  const names = ["ses_a", "ses_b", "ses_c", "ses_d"].map(p)
  assert.deepEqual(names, ["Мария Кюри", "Мария Магдалена", "Мара", "Маша"], "порядок каталога, без пропусков")
  assert.equal(new Set(names).size, 4, "ни одного дубля имени")
  assert.ok(!names.includes("Визуальная Маруська") && !names.includes("Гольфия Совершен"), "ВМ и Гольфия — по вызову, автоматом не выдаются")
  assert.ok(!names.includes("Маруська Око Государево"), "Око Государево — именная (T170), автоматом не выдаётся")
  // идемпотентность: повторный upsert не переименовывает
  ids.forEach((id, i) => upsertTab(l, { session_id: id, title: `Тема ${i} · Маруська Гольденштерн`, last_seen: times[i] }))
  assert.deepEqual(["ses_a", "ses_b", "ses_c", "ses_d"].map(p), names, "повторная раздача даёт те же имена")
})
test("T152: personaTitle — хвост заменяется на назначенное имя, обратно совместим", () => {
  assert.equal(personaTitle("тема · Маруська Гольденштерн", "🧝", "Мара"), "🧝 Мара · тема", "хвост = назначенная персона")
  assert.equal(personaTitle("тема · Маруська Гольденштерн", null, "Мария Кюри"), "Мария Кюри · тема", "без эмодзи тоже")
  assert.equal(personaTitle("тема · Маруська Гольденштерн", "👩"), "👩 Маруська Гольденштерн · тема", "нет оверрайда — прежний канон")
  assert.equal(personaTitle("тема · Маруська Гольденштерн", "🧛", "Неизвестный Кто"), "🧛 Маруська Гольденштерн · тема", "имя вне каталога игнорируется")
})
// T152-инцидент 12.11 (свалка имён): канон = титул сессии. Усыновление.
test("T152-инцидент: эмодзи и имя усыновляются из титула, реестр следует за сессией", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_base", title: "старая тема", last_seen: "2026-11-12T00:00:00Z" })
  upsertTab(l, { session_id: "ses_a", title: "🧚 Обсуждение задач · Мария Кюри", last_seen: "2026-11-12T01:00:00Z" })
  const a = l.tabs.find((t) => t.session_id === "ses_a")
  assert.equal(a?.emoji, "🧚", "эмодзи = первый токен титула (канон сессии, не пул)")
  assert.equal(a?.persona, "Мария Кюри", "имя-хвост усыновлено вместо пула")
  // пересборка реестра (поля поплыли) — титул возвращает канон
  a!.emoji = "🧝"
  a!.persona = null
  upsertTab(l, { session_id: "ses_a", title: "🧚 Обсуждение задач · Мария Кюри", last_seen: "2026-11-12T01:05:00Z" })
  assert.equal(a!.emoji, "🧚", "эмодзи-поле следует за титулом при каждом upsert")
  assert.equal(a!.persona, "Мария Кюри", "имя снова усыновлено — автоматизм не перетирает канон")
})
// T118-инцидент N00sphere («кривое имя»: «🧚 Маша · Мара»)
test("T118-инцидент: инстанс = ОДНО имя — чужое имя-топик схлопывается, «Мара · Мара» не плодится", () => {
  // топик-мусор динамики = чужое имя каталога + назначенный хвост
  assert.equal(personaTitle("Маша · Мара", "🧚", "Мара"), "🧚 Мара", "«Маша · Мара» → «Мара»")
  assert.equal(personaTitle("Маша", "🧚", "Мара"), "🧚 Мара", "топик-имя схлопывается в назначенное")
  assert.equal(personaTitle("Мара", "🧚", "Мара"), "🧚 Мара", "идемпотентность: без «Мара · Мара»")
  // чужое имя в ХВОСТЕ при назначенной персоне — срезается и заменяется
  assert.equal(personaTitle("тема · Маша", "🧚", "Мара"), "🧚 Мара · тема", "чужой хвост заменён")
  assert.equal(personaTitle("тема · Маша", "🧚"), "🧚 тема · Маша", "персоны нет — ручное имя-хвост остаётся (T117)")
  // неизвестный топик ведёт себя по-прежнему
  assert.equal(personaTitle("Тема · Кривизна", "🧚", "Мара"), "🧚 Мара · Тема · Кривизна", "неизвестный хвост не тронут, персона впереди (T166)")
})
// T166-инцидент 16.11: панель показывала «Мария Магдалена · Мария Магдалена · …»
// — personaTitle на титуле «Персона · Тема» (уже нового порядка) клеила персону
// заново при каждом событии, титул рос до обрезки. Фикс: ведущие известные
// персоны снимаются до base; реестр схлопывает дубли ведущей персоны.
test("T166-фикс: повторные тики не растят титул, дубль ведущей персоны схлопывается", () => {
  const once = personaTitle("Динамические имена вкладок агентов · Мария Магдалена", "🧝", "Мария Магдалена")
  assert.equal(once, "🧝 Мария Магдалена · Динамические имена вкладок агентов", "старый вид пересобран в новый порядок")
  // идемпотентность: повторный прогон того же живого титула не плодит персону
  assert.equal(personaTitle(once, "🧝", "Мария Магдалена"), once, " personaTitle(personaTitle(x)) === x")
  // самоисцеление: испорченный ростом титул схлопывается обратно
  const dirty = "Мария Магдалена · Мария Магдалена · Мария Магдалена · Динамические имена вкладок агентов"
  assert.equal(personaTitle(dirty, "🧝", "Мария Магдалена"), once, "дубль ведущей персоны схлопывается")
  // реестр тоже: upsertTab с испорченным титулом канонизирует (без размножения)
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_dup", title: dirty, last_seen: "2026-11-16T00:00:00Z" })
  assert.ok(!l.tabs[0].title.includes("Мария Магдалена · Мария Магдалена"), "реестр не хранит размноженную персону: " + l.tabs[0].title)
  // 10 циклов пересборки — титул не растёт
  let t = dirty
  for (let k = 0; k < 10; k++) t = personaTitle(t, "🧝", "Мария Магдалена")
  assert.equal(t, once, "N тиков — длина титула константа")
})
test("T152-инцидент: занятое имя хвоста не усыновляется — пул даёт свободное", () => {  const l = freshLedger()
  upsertTab(l, { session_id: "ses_base", title: "тема · Маруська Гольденштерн", last_seen: "2026-11-12T00:00:00Z" })
  upsertTab(l, { session_id: "ses_1", title: "тема A · Мария Кюри", last_seen: "2026-11-12T01:00:00Z" })
  upsertTab(l, { session_id: "ses_2", title: "тема B · Мария Кюри", last_seen: "2026-11-12T02:00:00Z" })
  const p = (sid: string) => l.tabs.find((t) => t.session_id === sid)?.persona ?? null
  assert.equal(p("ses_1"), "Мария Кюри", "первый усыновляет свободное имя")
  assert.notEqual(p("ses_2"), "Мария Кюри", "дубль имени запрещён — второму пул")
  assert.equal(new Set([p("ses_1"), p("ses_2")].filter(Boolean)).size, 2, "имена разные")
})
test("T152: имя переживает save/load (sanitizeTab переносит persona)", () => {  const dir = mkdtempSync(join(tmpdir(), "dev-console-t152-"))
  const file = join(dir, "state.json")
  try {
    const l = freshLedger()
    upsertTab(l, { session_id: "ses_base", title: "тема", last_seen: "2026-11-11T01:00:00Z" })
    upsertTab(l, { session_id: "ses_two", title: "тема", last_seen: "2026-11-11T01:01:00Z" })
    const before = l.tabs.find((t) => t.session_id === "ses_two")?.persona ?? ""
    assert.ok(before !== "", "имя назначено до сохранения")
    saveLedger(file, l)
    const back = loadLedger(file)
    assert.equal(back.tabs.find((t) => t.session_id === "ses_two")?.persona, before, "после roundtrip имя на месте")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test("T240: agent observability — self-report, immutable plan ETA, cumulative usage, last tool, save/load", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-t240-"))
  const file = join(dir, "state.json")
  try {
    const l = freshLedger()
    const agent = beginAgent(l, { input: { agent: "general", description: "[T11] Проверить домены" }, ref: "ses_t240" })
    const originalPlan = agent.eta_min
    const at1 = "2026-11-17T09:00:00.000Z"
    const reported = noteAgentProgress(l, "ses_t240", {
      step: "проверяю цены .codes у 3 регистраторов\n",
      done: "3/10",
      next: "reg.ru API",
      eta_remaining_min: 7,
    }, at1)
    assert.equal(reported?.progress?.step, "проверяю цены .codes у 3 регистраторов")
    assert.equal(reported?.progress?.done, "3/10")
    assert.equal(reported?.progress?.next, "reg.ru API")
    assert.equal(reported?.progress?.eta_remaining_min, 7)
    assert.equal(reported?.eta_min, originalPlan, "self-report must never overwrite the original plan")
    const redacted = noteAgentProgress(l, "ses_t240", {
      step: "GET https://registry.test/?api_key=sk-12345678901234567890",
      done: "password=hunter2",
      next: "Authorization: Bearer abc.def.ghi",
    }, "2026-11-17T09:00:01.000Z")
    assert.doesNotMatch(redacted?.progress?.step ?? "", /sk-1234567890/)
    assert.match(redacted?.progress?.step ?? "", /api_key=\[redacted\]/)
    assert.doesNotMatch(redacted?.progress?.done ?? "", /hunter2/)
    assert.doesNotMatch(redacted?.progress?.next ?? "", /abc\.def\.ghi/)
    noteAgentProgress(l, "ses_t240", { step: "проверяю цены .codes у 3 регистраторов", done: "3/10", next: "reg.ru API", eta_remaining_min: 7 }, at1)
    assert.throws(() => noteAgentProgress(l, "ses_t240", { step: "  ", eta_remaining_min: 7 }), /step is required/)
    assert.throws(() => noteAgentProgress(l, "ses_t240", { step: "valid", eta_remaining_min: 1441 }), /between 0 and 1440/)

    noteAgentUsage(l, "ses_t240", {
      cost: 0.02,
      tokens: { input: 100, output: 20, reasoning: 10, cache: { read: 4, write: 1 } },
    }, at1, "usage-event")
    assert.equal(agent.usage?.total_tokens, 135)
    assert.equal(agent.usage?.source, "usage-event")
    noteAgentUsage(l, "ses_t240", {
      cost: 0.03,
      tokens: { total: 199, input: 150, output: 30, reasoning: 12, cache: { read: 5, write: 2 } },
    }, "2026-11-17T09:01:00.000Z", "session-snapshot")
    assert.equal(agent.usage?.total_tokens, 199, "cumulative snapshots replace previous totals, never sum")
    assert.equal(agent.usage?.cost_usd, 0.03)

    noteAgentTool(l, "ses_t240", "read", "DEV_CONSOLE/state.ts", "2026-11-17T09:01:30.000Z", "call-1")
    assert.equal(agent.last_tool?.name, "read")
    assert.equal(agent.last_tool?.target, "DEV_CONSOLE/state.ts")
    assert.equal(agent.last_tool?.call_id, "call-1")
    noteAgentTool(l, "ses_t240", "old-tool", "stale", "2026-11-17T09:00:30.000Z", "call-old")
    assert.equal(agent.last_tool?.name, "read", "out-of-order tool events must not roll state back")
    assert.equal(noteAgentTool(l, "ses_t240", "read", "DEV_CONSOLE/state.ts", "2026-11-17T09:01:30.000Z", "call-1"), null, "duplicate replay is ignored")
    assert.ok(noteAgentRequest(l, "ses_t240", "msg-1"), "assistant completion is counted")
    assert.equal(noteAgentRequest(l, "ses_t240", "msg-1"), null, "durable message replay is deduplicated")
    assert.ok(noteAgentRequest(l, "ses_t240", "msg-2"), "next assistant response increments the count")
    assert.equal(agent.request_count, 2)

    const childLedger = freshLedger()
    const childAgent = beginAgent(childLedger, { input: { agent: "general", description: "[T11] Проверка API snapshot" }, ref: "ses_feed" })
    upsertTab(childLedger, { session_id: "ses_parent", title: "Parent" })
    const childFeed = parseChildFeed({ data: [{
      id: "ses_feed", parentID: "ses_parent", title: "T11 · проверка",
      location: { directory: "/repo" }, model: { id: "glm-5.3-flash" },
      time: { updated: Date.parse(at1) }, cost: 0.04,
      tokens: { input: 100, output: 20, reasoning: 10, cache: { read: 4, write: 1 } },
    }] }, "/repo")
    assert.equal(childFeed[0]?.usage?.total_tokens, 135, "GET /api/session usage is parsed per child")
    attachTabChildren(childLedger, childFeed)
    assert.equal(childAgent.usage?.cost_usd, 0.04, "child feed snapshot reaches its Agent record")

    const rendered = project(l).ui
    assert.ok(rendered.includes("проверяю цены .codes"), "panel projection shows self-reported step")
    assert.ok(rendered.includes("3/10"), "panel projection shows self-reported checkpoint")
    assert.ok(rendered.includes("ETA≈7м"), "panel projection marks ETA as a report")
    assert.ok(rendered.includes("TOK 199"), "panel projection shows per-agent usage")
    assert.ok(rendered.includes("tool: read"), "panel projection shows last observed tool")
    assert.ok(rendered.includes("REQ 2"), "panel projection shows completed model replies for this agent")

    saveLedger(file, l)
    const back = loadLedger(file)
    const saved = back.agents.find((a) => a.session_ref === "ses_t240")
    assert.equal(saved?.progress?.done, "3/10", "progress survives ledger roundtrip")
    assert.equal(saved?.usage?.total_tokens, 199, "usage survives ledger roundtrip")
    assert.equal(saved?.last_tool?.call_id, "call-1", "last tool survives ledger roundtrip")
    assert.equal(saved?.request_count, 2, "per-agent request count survives ledger roundtrip")
    noteAgentTool(l, "ses_t240", "fetch", "https://example.test/?access_token=secret-value", "2026-11-17T09:02:00.000Z", "call-2")
    assert.doesNotMatch(agent.last_tool?.target ?? "", /secret-value/)
    assert.deepEqual(saved?.request_ids, ["msg-1", "msg-2"], "request dedupe ring survives ledger roundtrip")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
