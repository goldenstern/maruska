// T117 · тесты динамической строки-деятельности.
import { test } from "node:test"
import assert from "node:assert/strict"
import { activityTopic, composeActivityTitle, parseTitle, shortTaskTopic, shouldRewriteTopic } from "./activity.ts"

test("T117: parseTitle — эмодзи / тема / персоно-хвост", () => {
  const p = parseTitle("👩 Динамические имена вкладок агентов · Маруська Гольденштерн")
  assert.equal(p.emoji, "👩")
  assert.equal(p.topic, "Динамические имена вкладок агентов")
  assert.equal(p.persona, "Маруська Гольденштерн")
  // тема с «·» внутри — режем по ПОСЛЕДНЕМУ «·»
  const q = parseTitle("🧚 Обсуждение · папки · Маруська Гольденштерн")
  assert.equal(q.topic, "Обсуждение · папки")
  assert.equal(q.persona, "Маруська Гольденштерн")
  // без персоны
  const r = parseTitle("👩 Голый титул")
  assert.equal(r.topic, "Голый титул")
  assert.equal(r.persona, null)
  // пусто
  assert.deepEqual(parseTitle(""), { emoji: null, topic: "", persona: null })
})

test("T117: shortTaskTopic — короткая тема без скобок-уточнений", () => {
  assert.equal(shortTaskTopic("ЧИСТКА ВКЛАДОК БЕЗ ПОРТРЕТОВ (заказ Основателя 29.10, дословно)"), "ЧИСТКА ВКЛАДОК БЕЗ ПОРТРЕТОВ")
  assert.equal(shortTaskTopic("Короткая задача"), "Короткая задача")
  const long = shortTaskTopic("x".repeat(120))
  assert.ok(long.length <= 44, "обрезано до 44 символов")
  assert.ok(long.endsWith("…"), "многоточие на обрезке")
})

test("T117: activityTopic — по данным леджера (демоны → задача → ожидание → простой)", () => {
  const ledger = {
    tasks: [
      { id: "T1", task: "Работа (заказ)", state: "DOING", session_ref: "s1", owner: null, parent: null, why: null, verification: null, agent_error: null, created_at: "", updated_at: "" },
      { id: "T2", task: "Ждёт", state: "WAIT", session_ref: "s1", owner: null, parent: null, why: null, verification: null, agent_error: null, created_at: "", updated_at: "" },
    ],
    agents: [
      { id: "A1", task_id: "T1", state: "running", home: "s1", session_ref: "c1", label: "x", kind: "general", model: null, began_at: "", updated_at: "" },
    ],
    tabs: [],
  }
  // 1) идёт демон → видно, что он делает
  assert.equal(activityTopic(ledger as never, "s1"), "T1 · Работа")
  // 2) без демонов, но задача DOING
  const l2 = { ...ledger, agents: [] }
  assert.equal(activityTopic(l2 as never, "s1"), "T1 · Работа")
  // 3) только ожидание (T1 создан раньше T2 → ждём именно T1)
  const l3 = { ...ledger, agents: [], tasks: ledger.tasks.map((t) => ({ ...t, state: "WAIT" })) }
  assert.equal(activityTopic(l3 as never, "s1"), "ждёт ⏳ T1")
  // 4) простоя работы нет — пусто (титул не трогаем)
  const l4 = { ...ledger, agents: [], tasks: [] }
  assert.equal(activityTopic(l4 as never, "s1"), "")
})

test("T117: shouldRewriteTopic — ручные темы НЕ перетираем (вердикт 06:00), голый титул — заполняем", () => {
  // тема = наша прошлая авто-тема → можно переписать
  assert.equal(shouldRewriteTopic({ currentTopic: "T1 · Работа", desiredTopic: "T2 · Другая", lastAutoTopic: "T1 · Работа" }), true)
  // тема уже новая (desired равен) → нечего делать
  assert.equal(shouldRewriteTopic({ currentTopic: "T1 · Работа", desiredTopic: "T1 · Работа", lastAutoTopic: "T1 · Работа" }), false)
  // авто-темы ещё не было (null) + тема непуста = РУЧНАЯ → НЕ трогаем (T86)
  assert.equal(shouldRewriteTopic({ currentTopic: "Моя тема", desiredTopic: "T1 · Работа", lastAutoTopic: null }), false)
  // голый титул (тема пуста) → строку-деятельности ставим (канон 29.10)
  assert.equal(shouldRewriteTopic({ currentTopic: "", desiredTopic: "T1 · Работа", lastAutoTopic: null }), true)
  // человек переписал тему руками ПОСЛЕ нашей авто-темы → не трогаем
  assert.equal(shouldRewriteTopic({ currentTopic: "Переписал руками", desiredTopic: "T1 · Работа", lastAutoTopic: "простой" }), false)
  // пустая активность → не трогаем
  assert.equal(shouldRewriteTopic({ currentTopic: "Моя тема", desiredTopic: "", lastAutoTopic: null }), false)
})

test("T117: composeActivityTitle — канон T166 «Персона · Тема»", () => {
  assert.equal(
    composeActivityTitle({ emoji: "👩", topic: "T136 · Конвейер", persona: "Маруська Гольденштерн" }),
    "👩 Маруська Гольденштерн · T136 · Конвейер",
  )
  assert.equal(composeActivityTitle({ emoji: null, topic: "простой", persona: "Маруська Гольденштерн" }), "Маруська Гольденштерн · простой")
})

test("T117: composeActivityTitle — append-петля невозможна (инцидент ~15с + 16.11)", () => {
  // персона, уже стоящая ПЕРЕД темой (канон T166), не плодит дубль
  assert.equal(
    composeActivityTitle({ emoji: null, topic: "Маруська Гольденштерн · Тема", persona: "Маруська Гольденштерн" }),
    "Маруська Гольденштерн · Тема",
  )
  // хвост старого канона снимается
  assert.equal(
    composeActivityTitle({ emoji: "👩", topic: "Тема · Маруська Гольденштерн", persona: "Маруська Гольденштерн" }),
    "👩 Маруська Гольденштерн · Тема",
  )
  // фикс-пойнт: повторные прогоны не растят титул
  const fix = (t: string): string => composeActivityTitle({ emoji: null, topic: t, persona: "Маруська Гольденштерн" })
  let t = fix("Тема")
  for (let i = 0; i < 5; i++) t = fix(t)
  assert.equal(t, "Маруська Гольденштерн · Тема", "титул стабилен за 5 циклов")
})
