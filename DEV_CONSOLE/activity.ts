// T117 · ДИНАМИЧЕСКАЯ СТРОКА-ДЕЯТЕЛЬНОСТИ ИНСТАНСА.
// Канон Основателя 29.10: у инстанса должна быть строка «что делает» — она
// ПЕРИОДИЧЕСКИ меняется (взяла задачу / закрыла / сменила статус), потому что
// инстанс персистентен. Персоно-хвост «· <имя>» неприкосновенен (механизм имён
// T117 стоит поверх). Ручные темы Основателя не теряются: тема, которую
// задал человек, отличается от нашей авто-темы → мы её не трогаем.
//
// Здесь — ЧИСТАЯ логика (без OpenCode): разбор титула, короткая тема задачи,
// вычисление деятельности по леджеру, сборка нового титула. Индекс (index.ts)
// держит состояние «какую тему мы сами поставили» и переименовывает сессию.

import type { Ledger, Task } from "./state.ts"

// Сколько символов оставлять от темы задачи в титуле вкладки.
export const ACTIVITY_TOPIC_MAX = 44

// Персоно-хвост: «... · <имя>». Хвост — то, что после ПОСЛЕДНЕГО «·».
export interface ParsedTitle {
  emoji: string | null // ведущий эмодзи-токен (портрет инстанса), если есть
  topic: string // тема без эмодзи и без персоно-хвоста
  persona: string | null // имя персоны (хвост) либо null
}

/** Разобрать титул «👩 Тема · Имя» на эмодзи / тему / персону. */
export function parseTitle(raw: string | null | undefined): ParsedTitle {
  const t = (raw ?? "").trim()
  if (t === "") return { emoji: null, topic: "", persona: null }
  let rest = t
  let emoji: string | null = null
  // Ведущий эмодзи-токен (T87: портрет инстанса первым токеном).
  const m = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F)?\s+(.*)$/u.exec(rest)
  if (m) {
    emoji = m[1]
    rest = (m[2] ?? "").trim()
  }
  // Персоно-хвост — после последнего «·». Тема может содержать «·» (например
  // «Статус «В РАБОТЕ» — что отображает»), поэтому режем по ПОСЛЕДНЕМУ «·».
  const idx = rest.lastIndexOf("·")
  let topic = rest
  let persona: string | null = null
  if (idx >= 0) {
    const tail = rest.slice(idx + 1).trim()
    const head = rest.slice(0, idx).trim()
    if (tail !== "") {
      topic = head
      persona = tail
    }
  }
  return { emoji, topic: topic.trim(), persona }
}

/** Короткая тема задачи для титула: без скобок-уточнений, с обрезкой. */
export function shortTaskTopic(text: string | null | undefined, max = ACTIVITY_TOPIC_MAX): string {
  const raw = (text ?? "").replace(/\s+/g, " ").trim()
  if (raw === "") return ""
  // Выкидываем вставки в скобках (обычно — ссылка на заказ/канон/дословно).
  const head = raw.replace(/\s*\([^)]*\)/g, " ").replace(/\s+/g, " ").trim() || raw
  const one = head.split(/[:;.!–—]/)[0]?.trim() ?? head
  const s = one.length > max ? one.slice(0, max - 1).replace(/\s+\S*$/, "") + "…" : one
  return s
}

/**
 * Что инстанс (вкладка sessionID) делает СЕЙЧАС — по данным леджера.
 * Порядок (канон 29.10): ход демонов → открытая задача → «ждёт ⏳» → простой.
 */
export function activityTopic(ledger: Ledger, sessionID: string): string {
  const myTasks = ledger.tasks.filter((t) => t.session_ref === sessionID)
  const myAgents = ledger.agents.filter((a) => a.home === sessionID || a.session_ref === sessionID)

  // 1) Идут демоны этого инстанса — показываем, что именно он делает.
  const busy = myAgents.filter((a) => a.state === "running" || a.state === "waiting")
  if (busy.length > 0) {
    const a = busy[busy.length - 1]
    const task = a.task_id ? ledger.tasks.find((t) => t.id === a.task_id) : null
    const topic = task ? shortTaskTopic(task.task) : ""
    const label = task ? `${task.id} · ${topic}` : `${a.id} · работает`
    return busy.length > 1 ? `${label} (+${busy.length - 1})` : label
  }

  // 2) Есть задача в работе, созданная этим инстансом.
  const doing = myTasks.find((t) => t.state === "DOING")
  if (doing) return `${doing.id} · ${shortTaskTopic(doing.task)}`

  // 3) Ждёт своей очереди — берём САМУЮ ДАВНЮЮ задачу в очереди (не первую
  // попавшуюся в массив): порядок ожидания = по времени создания.
  const waits = myTasks.filter((t) => t.state === "WAIT")
  if (waits.length > 0) {
    const wait = waits
      .slice()
      .sort((a, b) => (Date.parse(a.created_at || "") || 0) - (Date.parse(b.created_at || "") || 0))[0]
    return `ждёт ⏳ ${wait.id}`
  }

  // 4) Простоя работы нет — тему не трогаем (пустая активность = «не знаю что
  // делать» ≠ «делаю что-то конкретное»). Тогда и лишних переименований нет.
  return ""
}

/** Собрать титул в каноне T166: «<эмодзи> <Персона> · <тема>» — имя инстанса
 * впереди (портрет → имя → деятельность). Идемпотентно: персона, уже прилипшая
 * к теме спереди (канон T166) или сзади (старый канон), снимается — «Мара ·
 * Мара · …» не вырастает (инцидент 16.11). */
export function composeActivityTitle(opts: {
  emoji: string | null
  topic: string
  persona: string | null
}): string {
  const persona = (opts.persona ?? "").trim()
  let topic = opts.topic.trim()
  if (persona !== "") {
    if (topic === persona) return opts.emoji ? `${opts.emoji} ${persona}` : persona
    // снимаем персону с ВЕДУЩЕГО сегмента («Мара · Мара · тема» → «тема»)
    for (;;) {
      const idx = topic.indexOf(" · ")
      if (idx < 0) break
      if (topic.slice(0, idx).trim() !== persona) break
      topic = topic.slice(idx + 3).trim()
    }
    // и с хвоста (остаток старого канона «тема · Мара»)
    for (;;) {
      const idx = topic.lastIndexOf(" · ")
      if (idx < 0) break
      if (topic.slice(idx + 3).trim() !== persona) break
      topic = topic.slice(0, idx).trim()
    }
    if (topic === "") topic = persona
  }
  const base = persona !== "" ? `${persona} · ${topic}` : topic
  return opts.emoji ? `${opts.emoji} ${base}` : base
}

/**
 * Переименовывать ли вкладку: тема должна ОТЛИЧАТЬСЯ от текущей, и текущая
 * тема не должна быть ручной (ручную мы не трогаем — она не равна нашей
 * последней авто-теме).
 */
export function shouldRewriteTopic(args: {
  currentTopic: string
  desiredTopic: string
  lastAutoTopic: string | null
}): boolean {
  const desired = args.desiredTopic.trim()
  if (desired === "") return false // нечего показывать — титул не трогаем
  if (args.currentTopic === desired) return false
  // ВЕРДИКТ ЖИВОЙ ПРОБЫ (Основатель 06:00, инцидент «не те инстансы»): главные
  // табы держат канон T86 «тема · Маруська» — ручные темы НЕ перетираем.
  // Мы ещё ни разу не ставили свою тему (lastAutoTopic === null) и текущая
  // тема непуста → она ручная → не трогаем. Строку-деятельности получит только
  // вкладка с ГОЛЫМ титулом (канон 29.10) или та, чью тему мы уже вели (auto).
  if (args.lastAutoTopic === null) return args.currentTopic.trim() === ""
  // Уже ставили свою тему, а текущая ≠ нашей → человек переписал руками.
  if (args.currentTopic !== args.lastAutoTopic) return false
  return true
}

/** Задачи инстанса, у которых есть работа (для отладки/тестов). */
export function instanceTasks(ledger: Ledger, sessionID: string): Task[] {
  return ledger.tasks.filter((t) => t.session_ref === sessionID)
}
