// T116: EXPERIENCE_CORE — тесты ядра (§3 имя-ключ, §4 гейты, §5 агрегация,
// реестр-шарды, readForeignLedger). Чистые функции — без OpenCode-импортов.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  aggregateExperience,
  gateAllows,
  instanceNameOf,
  loadRegistry,
  nameOfAgent,
  readForeignLedger,
  scopeFor,
  touchRegistry,
  type RegistryEntry,
} from "./experience.ts"
import { freshLedger, learnEta, loadLedger, saveLedger, upsertTab, beginAgent, settleAgent } from "./state.ts"

const statOf = (p: string): { mtimeMs: number } | null => {
  try {
    return { mtimeMs: statSync(p).mtimeMs }
  } catch {
    return null
  }
}

// ----------------------------------------------------------------- §3: имя ---
test("T116: instanceNameOf — канон T86 «<эмодзи> <тема> · <имя>» даёт имя-хвост", () => {
  assert.equal(instanceNameOf("🧚 Обсуждение задач · Мария Кюри"), "Мария Кюри")
  assert.equal(instanceNameOf("Тема · Маруська Гольденштерн"), "Маруська Гольденштерн")
  assert.equal(instanceNameOf("тема · Маруха Чо"), "Маруха Чо", "вариант names наследует то же имя-ключ")
})
test("T116: локальное имя вне каталога НЕ склеивается с Маруськой (иначе чужой проект откроет presence)", () => {
  assert.equal(instanceNameOf("Тема · Лунная Дева"), "Лунная Дева")
  assert.equal(instanceNameOf(""), "Маруська Гольденштерн", "пустой титул → базовая")
  // §3 шаг 5: голова не узнаётся каталогом → raw-ХВОСТ («самонейтрализация» —
  // мусорный бакет memory-класса никому не открывает опыт; дизайн T103 §3).
  assert.equal(instanceNameOf("Маруська ЛУНА · тема"), "тема")
})
test("T116: nameOfAgent — nil-безопасно, home вкладки решает", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_tab", title: "тема · Мара", last_seen: "2026-11-11T01:00:00Z" })
  const a = beginAgent(l, { input: { agent: "general", description: "[T1] x" }, ref: "ses_child", home: "ses_tab" })
  assert.equal(nameOfAgent(a, l), "Мара")
  const orphan = { ...a, home: null }
  assert.equal(nameOfAgent(orphan, l), "Маруська Гольденштерн", "нет вкладки → базовая, не бросает")
})

// ---------------------------------------------------------------- §4: гейты --
test("T116: scopeFor — по ипостаси каталога: maruska→presence, golfia→unbound, прочие→memory", () => {
  assert.equal(scopeFor("Маруська Гольденштерн"), "presence")
  assert.equal(scopeFor("Маруха Чо"), "presence", "варианты names наследуют класс персонажа")
  assert.equal(scopeFor("Гольфия Совершен"), "unbound")
  assert.equal(scopeFor("Мара"), "memory")
  assert.equal(scopeFor("Маша"), "memory")
  assert.equal(scopeFor("Мария Кюри"), "memory")
  assert.equal(scopeFor("Неизвестный Кто"), "memory", "консервативно: чужое имя чужой опыт не получает")
})
test("T116: gateAllows — presence по вкладкам, memory по settled-памяти, unbound всегда", () => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_m", title: "тема · Маруська Гольденштерн", last_seen: "2026-11-11T01:00:00Z" })
  // presence: вкладка есть
  assert.equal(gateAllows("presence", l, "Маруська Гольденштерн"), true)
  assert.equal(gateAllows("presence", l, "Мара"), false, "вкладки Мары нет")
  // memory: вкладки нет, памяти нет
  assert.equal(gateAllows("memory", l, "Мара"), false, "Мара без памяти опыта не получает")
  const a = beginAgent(l, { input: { agent: "general", description: "[T1] x" }, ref: "ses_c", home: "ses_m" })
  assert.equal(gateAllows("memory", l, "Мара"), false, "running не память (§9.3)")
  settleAgent(l, "completed", "ses_c")
  // агента привязали к вкладке Маруськи — память Маруськи, не Мары
  assert.equal(gateAllows("memory", l, "Мара"), false)
  assert.equal(gateAllows("memory", l, "Маруська Гольденштерн"), true)
  assert.equal(gateAllows("unbound", l, "Гольфия Совершен"), true, "спецназ — везде")
})

// --------------------------------------------------------------- §5: склейка -
const ledgerWithAgent = (title: string, minutes: number): ReturnType<typeof freshLedger> => {
  const l = freshLedger()
  upsertTab(l, { session_id: "ses_home", title, last_seen: "2026-11-11T01:00:00Z" })
  const a = beginAgent(l, { input: { agent: "general", description: "[T1] x" }, ref: "ses_c", home: "ses_home" })
  settleAgent(l, "completed", "ses_c") // settle перетирает updated_at — даты ставим ПОСЛЕ
  a.began_at = new Date(Date.parse("2026-11-11T02:00:00Z")).toISOString()
  a.updated_at = new Date(Date.parse("2026-11-11T02:00:00Z") + minutes * 60000).toISOString()
  return l
}

test("T116: aggregateExperience — свои всегда; чужой по гейту memory (память) иначе пропуск", () => {
  const own = ledgerWithAgent("свой · Маруська Гольденштерн", 30)
  const maraProject = ledgerWithAgent("другое · Мара", 20) // память Мары есть здесь
  upsertTab(maraProject, { session_id: "ses_mk", title: "второй · Маруська Гольденштерн", last_seen: "2026-11-11T01:05:00Z" })
  const emptyProject = ledgerWithAgent("чужое · Маша", 10) // у Маши нет вкладки/памяти в своём — но гейт смотрит ЧУЖОЙ леджер
  const ledgers = new Map<string, ReturnType<typeof freshLedger>>([
    ["/own", own],
    ["/mara", maraProject],
    ["/masha", emptyProject],
  ])
  // Мара: memory-класс — проекты, где есть её settled-память: /mara (да), /masha (нет у неё памяти — вкладка Маши)
  const agg = aggregateExperience("Мара", "/own", ledgers)
  assert.ok(agg.sources.includes("/own"), "свой проект входит всегда")
  assert.ok(agg.sources.includes("/mara"), "проект с памятью Мары открыт")
  assert.ok(!agg.sources.includes("/masha"), "проект без памяти Мары закрыт гейтом")
  assert.ok(agg.durations.some((d) => d.ms === 20 * 60000), "чужой тайминг в окне")
  // presence: Маруська открыта везде, где есть её инстанс
  const aggM = aggregateExperience("Маруська Гольденштерн", "/own", ledgers)
  assert.ok(aggM.sources.includes("/mara"), "presence: вкладка Маруськи в чужом проекте открывает")
  // несуществующий свой root → ПУСТОЙ агрегат (никакой новой правды)
  const none = aggregateExperience("Мара", "/nowhere", ledgers)
  assert.deepEqual(none, { durations: [], modelClass: [], sources: [], unlimited: false })
})
test("T116: unbound — Гольфия открыта везде и окно не сжимается", () => {
  const own = ledgerWithAgent("свой · Маруська Гольденштерн", 30)
  const foreign = ledgerWithAgent("другое · Мара", 20)
  const ledgers = new Map<string, ReturnType<typeof freshLedger>>([
    ["/own", own],
    ["/foreign", foreign],
  ])
  const agg = aggregateExperience("Гольфия Совершен", "/own", ledgers)
  assert.ok(agg.sources.includes("/foreign"), "unbound: чужой проект открыт без вкладки/памяти")
  assert.equal(agg.unlimited, true, "пул не сжимается до окна 5")
})

// ------------------------------------------------------------------- реестр --
test("T116: touchRegistry + loadRegistry — шард атомарен, throttle 60с, битый шард пропускается", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-t116-"))
  const hub = dir
  try {
    assert.equal(touchRegistry(hub, "C:/proj/one", Date.parse("2026-11-11T03:00:00Z")), true, "первый touch пишется")
    assert.equal(touchRegistry(hub, "C:/proj/one", Date.parse("2026-11-11T03:00:20Z")), false, "throttle 60с")
    assert.equal(touchRegistry(hub, "C:/proj/two", Date.parse("2026-11-11T03:00:40Z")), true, "другой проект не задет")
    writeFileSync(join(hub, "experience", "projects", "broken.json"), "{not json", "utf8")
    const reg = loadRegistry(hub)
    assert.equal(reg.size, 2, "битый шард пропущен, живые два на месте")
    assert.ok(reg.has("C:/proj/one") && reg.has("C:/proj/two"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test("T116: readForeignLedger — битый файл → null (не роняет рантайм), живой — читается", () => {
  const dir = mkdtempSync(join(tmpdir(), "dev-console-t116b-"))
  try {
    const good = join(dir, "good.json")
    saveLedger(good, freshLedger())
    assert.ok(readForeignLedger(good, statOf) !== null, "живой леджер читается")
    const bad = join(dir, "bad.json")
    writeFileSync(bad, "{broken", "utf8")
    assert.equal(readForeignLedger(bad, statOf), null, "битый → null")
    assert.equal(readForeignLedger(join(dir, "missing.json"), statOf), null, "нет файла → null")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test("T116: кросс-опыт доезжает до learnEta/beginAgent (state.ts F2, опциональный cross)", () => {
  const l = freshLedger()
  // нет истории → DEFAULT_ETA (30)
  const eta0 = learnEta(l.agents, "general")
  assert.equal(eta0, 30)
  // кросс-тайминги 10м для general → средняя ~10 → clamp 5..120 → 10
  const cross = { durations: [{ kind: "general", ms: 10 * 60000, endedAt: Date.parse("2026-11-11T02:00:00Z") }] }
  const eta = learnEta(l.agents, "general", null, cross)
  assert.ok(eta >= 5 && eta <= 120 && eta !== eta0, `кросс докрутил ETA (${eta})`)
  // beginAgent прокидывает cross в план (нет est_min у задачи)
  const a = beginAgent(l, { input: { agent: "general", description: "[T9] x" }, ref: "ses_x", home: null, cross })
  assert.equal(a.eta_min, eta, "план спавна собран из кросс-истории")
})
