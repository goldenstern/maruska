// DEV CONSOLE runtime — pure state core + ledger persistence.
// No OpenCode imports here: unit-testable with plain node.
// Syntax kept erasable (no enums/namespaces) for --experimental-strip-types.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync, openSync, closeSync, fsyncSync, statSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { createHash, randomUUID } from "node:crypto"
// T117-ядро: каталог ипостасей чистый (без импортов OpenCode) — идём в него
// за распознаванием имён-хвостов (заказ Основателя 29.10).
import { PERSONAS, resolvePersona } from "./personas.ts"

// ---------------------------------------------------------------- model ----

export type TaskState = "DOING" | "WAIT" | "BLOCKED" | "GATE" | "DONE"

// Repo-level code velocity metric (T80): sliding window ≥60s from git numstat.
export interface RepoSpeed {
  additions: number      // Σ additions at latest snapshot
  deletions: number      // Σ deletions at latest snapshot
  linesPerSec: number | null  // (Δadd+Δdel) / Δt over window ≥60s
  editsPerSec: number | null  // Δ edit events / Δt over window ≥60s (placeholder)
  languagePct: Record<string, number> | null  // ext → % of tracked files
  measuredAt: number     // timestamp of latest snapshot (ms)
  windowStart: number    // timestamp of window start (ms)
  windowEnd: number      // timestamp of window end (ms)
  valid: boolean         // window ≥60s and Δt > 0
}

// Per-instance code velocity metric (T81): sliding window ≥60s from session.diff (lines)
// and event-stream session.tool.called / session.step.ended (edits).
export interface InstanceSpeed {
  sessionId: string      // session_id of the top-tab instance
  additions: number      // Σ additions at latest snapshot
  deletions: number      // Σ deletions at latest snapshot
  linesPerSec: number | null  // (Δadd+Δdel) / Δt over window ≥60s, clamped ≥0
  editsPerSec: number | null  // Δ unique "sessionID|file" edits / Δt over window ≥60s
  measuredAt: number     // timestamp of latest snapshot (ms)
  windowStart: number    // timestamp of window start (ms)
  windowEnd: number      // timestamp of window end (ms)
  valid: boolean         // window ≥60s and Δt > 0
}

// Raw snapshot from session.diff polling (T81 §4.1).
export interface InstanceDiffSnapshot {
  sessionId: string
  additions: number
  deletions: number
  at: number
}

// Raw edit event from event-stream (T81 §4.1: session.tool.called with path/file
// or unique sessionID|file from session.step.ended.files).
export interface InstanceEditEvent {
  sessionId: string
  file: string
  at: number
}

export interface Task {
  id: string
  task: string
  state: TaskState
  owner: string | null
  parent: string | null // декомпозиция: id родительской задачи (бар = дети DONE/всего)
  why: string | null // для BLOCKED/GATE: почему состояние такое (иначе null)
  verification: string | null
  session_ref: string | null // сессия-создатель (вкладка): create помечает задачу своей сессией
  agent_error: string | null // T46: исполнитель умер (session failed/обрыв) — пометка до решения о ретрае
  created_at: string
  updated_at: string
  // T38: фазовый план/факт — опционально для обратной совместимости
  est_min?: number | null // явная оценка фазы в минутах (если модель передала — главнее автоматики)
  phase?: string | null // явный тег фазы (например: "impl", "review", "test") — если нужен
  // T43: приоритет перетаскиванием (drag-and-drop) — опционально для обратной совместимости.
  // Меньшее число = выше приоритет. null/undefined = приоритет не задан (сортируются после заданных).
  priority?: number | null
  // T136: retry-таймер на BLOCKED. retry_at — момент (ISO, как created_at/updated_at),
  // после которого задачу можно снова попытаться взять в работу; retry_attempts —
  // счётчик для экспоненциального бэкоффа (5 → 10 → 20 … мин, потолок 60).
  // Снимается при выходе из BLOCKED. ФОРМАТ = ISO-строка (index.ts читает
  // Date.parse(t.retry_at)) — число тут ломало бы и бэкофф, и авто-разблокировку.
  retry_at?: string | null
  retry_attempts?: number | null
}

// Agent lifecycle is populated from real runtime events (Stage 2):
// records are created/settled by tool hooks, never by model assertion.
export interface Agent {
  id: string
  task_id: string | null
  label: string
  state: "created" | "running" | "waiting" | "completed" | "failed"
  session_ref: string | null // call/session reference of the spawn, for exact settle matching
  home: string | null // top session (tab) the agent belongs to — tab attribution when no task binds it
  model: string | null // short model id, attached from the child's Session.Info when known
  note: string | null // spawn description, clipped — the «what» when no task is bound
  kind: string | null // вид спавна (general/qc/…) — его помнит learnEta; в label он больше не живёт (T64)
  emoji: string | null // свой персонаж (T71): из DAEMON_EMOJI, назначается один раз при регистрации
  began_at: string // start of the run — the ETA baseline
  eta_min: number // plan stamped at begin: learned from same-kind history or default
  updated_at: string
  // T41/T93: durable runtime counters (persisted in ledger, survive plugin reloads).
  // Incremented at event time (injection/edit), read at settle for metrics.
  edit_count?: number
  // T92: «цена контекста задачи» — сколько консольного контекста рантайм ДЕЙСТВИТЕЛЬНО
  // отправил в ЭТУ сессию: диспатч-промпт (+1 по доставке) + ETA-самоотчёты (+1 каждый).
  // См. noteSessionInjection — единственный писатель.
  injection_count?: number
  // T41: compact metrics written once at settle (not on every render).
  // Optional — old records without this field don't break (fallback null).
  counters?: AgentCounters | null
  // T97(а) settle-гардия: вычитанный из сессии самоотчёт ребёнка — уходит в
  // verification задачи (пустой хвост → NO_SELF_REPORT). Optional (легаси).
  self_report?: string | null
  // T97(в) orientation-прелюдия: первое действие ребёнка ОБЯЗАТЕЛЬНО tool-вызов.
  // "pending" — ждём первый tool-вызов; "ok" — был; "hell" — N пустых первых
  // сообщений подряд → пометка orientation-hell. undefined = легаси-запись (не считаем).
  orientation?: "pending" | "ok" | "hell"
  empty_first?: number // сколько пустых первых сообщений насчитано (≤ ORIENTATION_N)
  // T240 / Phase 3: bounded self-report; separate from eta_min (immutable plan).
  progress?: AgentProgress | null
  // Per-session cumulative snapshots from /api/session and usage events. Replace, never sum snapshots.
  usage?: AgentUsage | null
  // Last observed tool activity, not a transcript.
  last_tool?: AgentLastTool | null
  // Completed assistant messages observed for this child session (not tool calls/provider retries).
  request_count?: number
  request_ids?: string[] // bounded dedupe ring for durable message.updated replay
}

export interface AgentProgress {
  step: string
  done: string | null
  next: string | null
  eta_remaining_min: number | null
  updated_at: string
  source: "self-report"
}

export interface AgentUsage {
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  total_tokens: number
  cost_usd: number
  updated_at: string
  source: "session-snapshot" | "usage-event"
}

export interface AgentLastTool {
  name: string
  target: string | null
  call_id?: string | null
  updated_at: string
}

// T41: metrics computed at settle time, stored in the agent record.
export interface AgentCounters {
  // Plan accuracy: planned eta_min vs actual minutes (began_at → updated_at at settle).
  // Null if eta_min missing or began_at invalid. Clamped to reasonable range.
  plan_acc: number | null
  // Empty run: completed but zero edits detected (heuristic: files didn't change,
  // based on mtime/edit counters available in runtime at settle time).
  empty_run: boolean
  // Early settle: agent settled (completed/failed) but session continued activity
  // after the settle timestamp (runtime has noteSessionActivity/event freshness).
  early_settle: boolean
  // T92: контекст, который рантайм запустил в сессию задачи (диспатч-промпт +
  // ETA-самоотчёты). Проекция топ-вкладок сюда НЕ входит: она не касается
  // сессий агентов (дети/исполнители получают её ноль — это правда, не дефект).
  injections: number
  // T128 (заказ Основателя 29.10): ВЕЛИЧИНА переработки — минут сверх плана
  // при settle: max(0, факт(began_at→updated_at) − план(eta_min)). Пишется один
  // раз при закрытии записи; 0 = уложился (или плана/времени нет — не выдумываем).
  overrun_min: number
}

// T62: Foreign session tracking (sessions from other projects)
export interface ForeignSession {
  session_id: string
  title: string
  last_seen: number // timestamp
}

export interface Ledger {
  version: number
  updated_at: string
  tasks: Task[]
  agents: Agent[]
  tabs: TabSession[] // top-сессии проекта (вкладки) — регистр атрибуции
  models?: ModelStat[] // T66: таблица моделей/кулдаун (политика инстансов)
  foreign_sessions?: ForeignSession[] // T62: чужие сессии (только для UI, не для вкладок)
  // P0-C: explicit deletion markers prevent stale snapshots from resurrecting
  // entities removed by a newer writer. IDs are never reused within a project.
  tombstones?: {
    tasks?: Record<string, string>
    agents?: Record<string, string>
    tabs?: Record<string, string>
    foreign_sessions?: Record<string, string>
  }
  // T128: накопитель переработки за сутки — durable (лежит в state.json,
  // переживает рестарт рантайма, как T92 injection_count в записях агентов).
  overruns?: OverrunLedger
}

// T128: накопитель переработки времени. Ключ = сутки (локальный день): смена
// дня = разрыв/пауза → счётчики в ноль (новые сутки — новая правда). Храним и
// общий итог (агрегат шапки ИНСТАНСЫ), и разбивку по инстансам (home-вкладкам).
export interface OverrunLedger {
  day: string // YYYY-MM-DD локальных суток, которым принадлежат счётчики
  total_min: number // переработка за сутки по всем инстансам
  by_home: Record<string, number> // session_id инстанса → минуты за сутки
}

// ---------------------------------------------------------- tabs (T34) -----
// Вкладка = top-сессия проекта (без parentID), не являющаяся диспетчерным
// исполнителем. Источники: живой `ctx.session.list`, если сборка его отдаёт,
// иначе context-hook инжект (каждый вызов модели видит свою сессию).
export interface TabSession {
  session_id: string
  title: string // имя вкладки (Session.Info.title); "" пока не известно
  model: string | null // short model id, from Session.Info when known
  emoji: string | null // своя «девочка» (T71): из INSTANCE_EMOJI, назначается один раз при регистрации
  manual?: boolean | null // T136 (декрет 29.10): портрет = ручной чат Основателя; null = ещё не проверено
  persona?: string | null // T152: имя инстанса из каталога (канон «Маруха Чо» 11.11); null/undefined = базовая Маруська
  last_seen: string // последнее наблюдение (вызов модели / list)
  eff?: TabEff | null // T118: накопители эффективности (durable — переживают рестарты)
}

// ------------------------------------------ T104(1): своя vs чужая (T62) ---
// Заказ Основателя 09.10: «в списке ЧУЖИХ вкладок отображаются СВОИ».
// Причина — классификация по одному пути сессии: неизвестный/несовпадающий
// directory (get молчит, хвостовой слэш, подпапка проекта) ⇒ «чужой», и своя
// вкладка уезжала в 🌍 ЧУЖИЕ. Правило теперь такое:
//   (1) реестр вкладок главнее путей: запись в ledger.tabs уже признана своей;
//   (2) чужой = доказано: путь есть и это не корень проекта и не его подпапка;
//   (3) путь неизвестен → чужойство не доказано → своя (как до T62).
// Пути сравниваем нормализованными: регистр, / и \, хвостовые разделители.
export function normalizeDirPath(p: unknown): string | null {
  if (typeof p !== "string") return null
  const norm = p.trim().toLowerCase().replace(/[\\/]+/g, "\\").replace(/\\+$/, "")
  return norm === "" || norm === "\\" ? null : norm
}

// Путь сессии доказывает «чужой»? (см. правило выше — чистая функция, юнит-тесты)
export function isForeignDirectory(dir: unknown, root: string): boolean {
  const d = normalizeDirPath(dir)
  const r = normalizeDirPath(root)
  if (d === null || r === null) return false // не доказано → свой
  if (d === r) return false
  return !d.startsWith(r + "\\") // подпапка проекта — тоже своя
}

// Гейт T62 на месте классификации: сессия чужая, только если её нет в реестре
// вкладок И путь доказал иную папку.
export function isForeignSession(sessionID: string, directory: unknown, root: string, tabs: TabSession[]): boolean {
  if (tabs.some((t) => t.session_id === sessionID)) return false
  return isForeignDirectory(directory, root)
}

// Страховка рендера/сохранения: своя вкладка не может стоять в 🌍 ЧУЖИЕ —
// чистит и устаревшие записи леджера, и накопленную карту runtime.
export function dropOwnFromForeign(
  foreign: ForeignSession[] | undefined,
  tabs: TabSession[],
): ForeignSession[] {
  if (!Array.isArray(foreign)) return []
  const own = new Set(tabs.map((t) => t.session_id))
  return foreign.filter((f) => f && typeof f.session_id === "string" && !own.has(f.session_id))
}

// Вкладка + её нагрузка из ledger'а (глаз, не дамп — id, не тексты).
export interface TabView {
  session_id: string
  title: string
  model: string | null
  emoji: string | null // стабильный эмодзи записи (T71): рендер только читает
  last_seen: string
  tasks: string[] // задачи, созданные этой вкладкой (create → session_ref)
  agents: string[] // агенты: по вкладке задачи, иначе по вкладке спавна
  children?: ChildFeedItem[] // T170: субагенты из фида (деньги сессий) — строки-боты
}

export interface Projection {
  tasks: Task[] // non-DONE tasks
  active: Task[] // STATE == DOING        -> 🔄
  agents: Agent[] // running|waiting        -> 🤖
  blocked: Task[] // STATE == BLOCKED       -> ⛔
  gates: Task[] // STATE == GATE          -> 🔔
  done: Task[] // STATE == DONE — правда ledger, в ui не показывается
  ui: string // rendered projection (primary channel = live pane; ui = fallback/comment source)
}

export interface OpInput {
  op: string
  id?: string
  task?: string
  owner?: string | null
  parent?: string
  state?: TaskState
  why?: string
  verification?: string
  session_ref?: string | null // задаётся рантаймом (вызывающая сессия), не моделью
  est_min?: number | null // явная оценка фазы в минутах (если модель передала — главнее автоматики); null = очистка
  phase?: string // явный тег фазы (например: "impl", "review", "test")
  // T240: progress self-report — caller identity comes from context.sessionID, never from input.
  step?: string
  done?: string | number | null
  next?: string | null
  eta_remaining_min?: number | null
}

export type OpOutcome =
  | { ok: true; ledger: Ledger; task: Task }
  | { ok: false; error: string }

// ---------------------------------------- model policy of instances (T66) ---
// Правка Основателя 07.10.2026: инстанс (top-вкладка-оркестратор ЛУНЫ/
// Маруська) = строго mimo, демоны-чайлды = строго nemotron. Между этими ДВУМЯ
// моделями ребёнка выбирает обучаемая статистика успех/провал на своей
// истории (таблица в ledger.models); рейт-лимит/model drop → резервная модель
// (вторая из двух) + кулдаун пострадавшей; фраза Основателя «был рейт лимит,
// перезапусти» → op "model_reset" в index.ts = сброс кулдаунов, выбор возвращается
// к дефолту (демон = nemotron). Таблица переживает hot-reload в state.json.
// Правка Основателя 22.10.2026: демон (он же модель QC-роли) = GLM, новая
// модель в каталоге; старый nemotron (3-ultra) снят — падал в 6/8 запусков.
// ДЕКРЕТ Основателя 29.10.2026 ~10:45 (T142, дословно: «луна теперь только для
// гольфии!!! СУБАГЕНТЫ ТОЛЬКО ФРИ ЮЗАЮТ В СВОЁМ КАНАЛЕ ОПЕНКОДА: КОНСОЛЬ ИЛИ ГО»):
// 1) luna = ТОЛЬКО Гольфия (~/.config/opencode/agents/golfia.md — не трогать) — в
//    детском пуле её нет (см. childModelAllowed), ни под каким провайдером;
// 2) субагент не может быть премиумом НИКОГДА (канон T132 «прем-инстанс → дети
//    perClass в premium» ОТМЕНЁН для субагентов): детский пул = ТОЛЬКО *-free,
//    суффикс -free в любом канале (opencode или opencode-go). Go-тройка
//    подписки (mimo/glm/deepseek без -free) — тоже премиум, детям закрыта;
// 3) INSTANCE_MODEL (инстанс на Go-mimo) — канал основателя, НЕ субагент;
//    правило «модель вкладки не перетирается» в силе.
export const INSTANCE_MODEL = "opencode-go/mimo-v2.6-flash" // парент = премиум Go-канал основателя (канон T142: «инстанс остаётся премиум-каналом»)
export const DEMON_MODEL = "opencode/glm-5.3-flash-free" // звено 1: бесплатная GLM (заказ 22.10 GLM-первым; T142 — только *-free)
export const NEMOTRON_MODEL = "opencode/nemotron-3.5-super-vl-free" // звено 2: бесплатный vision-лидер T123/T134 (image input)
// Порядок = порядок очереди: ничья/нет данных остаётся за звеном 1.
// Цепочка ВСЕГО ДВУХ звеньев и обе — *-free: премиум в детский пул не входит.
export const POLICY_MODELS: readonly string[] = [DEMON_MODEL, NEMOTRON_MODEL] // T142-канон: детская цепочка = 2 *-free звена, премиум (вкл. INSTANCE) УБРАН
export const COOLDOWN_MS = 10 * 60_000 // окно кулдауна после rate limit / model drop

// Короткий ключ статистики («mimo-v2.6-flash» / «nemotron-3.5-super-vl») совпадает
// с тем, что attachModel пишет в Agent.model из Session.Info — счёт и выбор
// сходятся без дополнительного маппинга.
// T45/T82-fix: экспорт нужен index.ts (beginAgent получает short-ключ модели
// для modelSpeedFactor) — приватная версия ломала dispatch с ReferenceError.
export const shortModelKey = (m: string): string => m.split("/").pop()!.replace(/-free$/, "")
export const INSTANCE_KEY = shortModelKey(INSTANCE_MODEL)
export const DEMON_KEY = shortModelKey(DEMON_MODEL)
export const NEMOTRON_KEY = shortModelKey(NEMOTRON_MODEL)
// Декрет T142: ключ инстанса есть в KEY_TO_MODEL (вкладка основателя, «модель
// вкладки не перетирается»), но в ЦЕПОЧКЕ ДЕТЕЙ его нет — субагент не бывает
// премиумом. reserveModel/chooseChildModel/chooseModelByClass/quotaFallbackModel
// дополнительно строго гардятся childModelAllowed (free + не luna).
export const POLICY_KEYS: readonly string[] = [DEMON_KEY, NEMOTRON_KEY]
const KEY_TO_MODEL: Record<string, string> = {
  [INSTANCE_KEY]: INSTANCE_MODEL,
  [DEMON_KEY]: DEMON_MODEL,
  [NEMOTRON_KEY]: NEMOTRON_MODEL,
}

// T132 (канон Основателя 29.10): в карту ключ→модель входят ВСЕ модели,
// доступные выбору, — политическая цепочка И живой free-пул каталога. Только
// так кулдаун/статистика квоты протягиваются и на free-модели (иначе
// setModelCooldown молча отбрасывал бы квоту deepseek/flint/beam).

// Полный id модели политики/пула по короткому ключу (Agent.model из Session.Info);
// чужая модель → null (переключаться не на что по политике).
export function modelForKey(key: string): string | null {
  return POOL_KEY_TO_MODEL[key] ?? null
}

// ---------------------------------------------------- T132: полюс и пул ----
// Заказ Основателя 29.10: у каждой модели есть ПОЛЮС — free (суффикс -free,
// жрёт rolling-квоту бесплатной линии) или premium (ГО/подписка, деньги).
// Канон: инстанс ФРИ (дефолт-модель с -free) → агентам ТОЛЬКО free-пул, никаких
// premium даже по типу задачи; инстанс ПРЕМ → perClass внутри premium и
// экономия токенов. Ротация при квоте живёт внутри того же полюса.
export type ModelPole = "free" | "premium"

export function isFreeModel(model: unknown): boolean {
  return typeof model === "string" && /-free$/.test(model)
}

export function modelPole(model: unknown): ModelPole {
  return isFreeModel(model) ? "free" : "premium"
}

// Класс инстанса определяется по INSTANCE_MODEL (суффикс -free = фри-инстанс).
export function instanceClass(model: string = INSTANCE_MODEL): ModelPole {
  return modelPole(model)
}

export const INSTANCE_CLASS: ModelPole = instanceClass()

// Живой free-пул (карта квот 29.10: mimo/deepseek/nemotron-vl/flint/beam —
// все пять проверены /prompt+poll: COMPLETED; premium glm-5.3-flash и
// gpt-6-luna в тот момент были в provider.quota). Порядок = порядок очереди:
// первый элемент — дефолт (INSTANCE_MODEL), дальше ротация по квоте.
// 16.11 (сайт-лист Основателя): добавлены minimax-m3.1-flash, nemotron-3.5-
// lightning, longcat-2.5, inkling-2-small, iceman — все *-free, $0. Порядок
// ротации решают model_health/скоринг, не порядок списка. big-pickle (id без
// суффикса -free) и jev-1.13-free (нет в каталоге провайдера) — вне пула.
export const FREE_POOL: readonly string[] = [
  "opencode/mimo-v2.6-flash-free", // 29.10: консольная free-голова (НЕ INSTANCE_MODEL — тот ушёл на Go-канал; ключ mimo не должен затирать Go-маппинг)
  "opencode/deepseek-v4.1-flash-free",
  "opencode/nemotron-3.5-super-vl-free",
  "opencode/glm-5.3-flash-free",
  "opencode/flint-40b-free",
  "opencode/beam-free",
  "opencode/minimax-m3.1-flash-free",
  "opencode/nemotron-3.5-lightning-free",
  "opencode/longcat-2.5-free",
  "opencode/inkling-2-small-free",
  "opencode/iceman-free",
]
export const FREE_KEYS: readonly string[] = FREE_POOL.map((m) => shortModelKey(m))

// Единая карта ключ→модель для всего, что выбирает/кулдаунит: политическая
// цепочка + free-пул (см. комментарий выше modelForKey).
const POOL_KEY_TO_MODEL: Record<string, string> = (() => {
  const map: Record<string, string> = { ...KEY_TO_MODEL }
  for (const id of FREE_POOL) map[shortModelKey(id)] ??= id // T142: ключ вкладки (mimo→INSTANCE/Go) не перетирается free-строкой
  return map
})()

// ----------------------- T142: детский гард и детский пул (29.10 ~10:45) -----
// Гард-функция (страж): ни один демон/исполнитель не может получить модель вне
// этого предиката. luna (gpt-6-luna) вырезана ПО ИМЕНИ в любом канале —
// id «gpt-6-luna» живёт и на opencode, и на opencode-go; премиум (без -free)
// вырезан целиком: субагент не может быть премиумом НИКОГДА, поэтому
// Go-тройка подписки (mimo/glm/deepseek без суффикса) детям тоже закрыта.
// Разрешено ровно одно: *-free в ЛЮБОМ канале (opencode или opencode-go).
// Факт смертей: консольный free = квота (A146/A148/A149/A150), beam/iceman-go = гео-блок (A147).
export function childModelAllowed(model: unknown): boolean {
  const m = String(model)
  if (/luna/i.test(m)) return false
  return isFreeModel(m)
}

// luna = закрытая модель Гольфии (~/.config/opencode/agents/golfia.md — её
// единственный канал, не трогать). Именованная константа для страж-юнитов.
export const GOLFIA_MODEL = "opencode-go/gpt-6-luna"

// Детская карта ключ→модель: собирается ТОЛЬКО из childModelAllowed-моделей
// (политика + живой free-пул). Короткий ключ, общий с вкладкой основателя
// (mimo-v2.6-flash), у ребёнка резолвится в БЕСПЛАТНУЮ консольную модель —
// премиум-INSTANCE ребёнку недостижим ни через какой ключ.
const CHILD_IDS: readonly string[] = [...POLICY_MODELS, ...FREE_POOL]
export const CHILD_KEY_TO_MODEL: Record<string, string> = (() => {
  const map: Record<string, string> = {}
  for (const id of CHILD_IDS) {
    if (!childModelAllowed(id)) continue
    map[shortModelKey(id)] ??= id
  }
  return map
})()
export const CHILD_KEYS: readonly string[] = Object.keys(CHILD_KEY_TO_MODEL)
// Полный порядок детского пула (для страж-юнитов и тестов): цепочка политики
// сначала, потом живой free-пояс — без дублей, всё childModelAllowed.
export const CHILD_MODELS: readonly string[] = [...new Set(CHILD_IDS)].filter((m) => childModelAllowed(m))

// Пул выбора СУБАГЕНТА: primary = цепочка политики (free), secondary = живой
// free-пул каталога (ротация при квоте). Аргумент не нужен: полюс инстанса,
// хоть фри, хоть прем, детский пул не меняет — дети ТОЛЬКО ФРИ (T142).
export function childPool(): { primary: string[]; secondary: string[] } {
  return {
    primary: POLICY_MODELS.filter((m) => childModelAllowed(m)),
    secondary: CHILD_IDS.filter((m) => childModelAllowed(m) && !POLICY_MODELS.includes(m)),
  }
}

// Модели указанного полюса. T142: детская политика вся free, поэтому
// premium-полюс политики пуст — премиум живёт только в INSTANCE_MODEL.
export function poleModels(pole: ModelPole): string[] {
  if (pole === "free") return [...FREE_POOL]
  return POLICY_MODELS.filter((m) => !isFreeModel(m))
}
export function poleKeys(pole: ModelPole): string[] {
  if (pole === "free") return [...FREE_KEYS]
  return POLICY_KEYS.filter((k) => !isFreeModel(KEY_TO_MODEL[k]))
}

// Пул выбора ИНСТАНСА (первичный = полюс инстанса; вторичный = аварийный
// выход, когда весь первичный пул недоступен — работа не останавливается).
export function instancePool(pole: ModelPole = INSTANCE_CLASS): { primary: string[]; secondary: string[] } {
  // T142: POLICY_MODELS целиком free — премиум-инстанс Го-канала остаётся сам
  // себе полюсом (INSTANCE_MODEL не трогаем, это канал основателя).
  return pole === "free"
    ? { primary: [...FREE_POOL], secondary: [...POLICY_MODELS] }
    : { primary: [INSTANCE_MODEL], secondary: [...FREE_POOL] }
}

// Модель пригодна для выбора СУБАГЕНТОМ прямо сейчас: она в пуле, проходит
// детский гард (T142: только *-free, никакой luna — канал инстанса не важен) и
// её нет в кулдауне. Полюс инстанса детские способности не меняет: канон
// «прем-инстанс → дети в premium» (T132) для субагентов ОТМЕНЁН 29.10 ~10:45.
export function modelUsable(ledger: Ledger, model: string, at: number = Date.now()): boolean {
  const key = shortModelKey(model)
  if (!(key in POOL_KEY_TO_MODEL)) return false
  if (!childModelAllowed(model)) return false
  return !onCooldown(modelStats(ledger).find((s) => shortModelKey(s.model) === key), at)
}

// T169-гвард (заказ Основателя 15.11): durable-память карантина моделей —
// ОТДЕЛЬНЫЙ файл (DEVATA/model_health.json), не state.json: инстансы со старым
// кодом (до фикса CAS) перетирают state.json целофайловыми снимками и стирают
// кулдауны — три диспатча подряд ушли в заведомо мёртвый endpoint (A181–A183,
// mimo). Здесь карантин переживает любой перетир: атомарный файл + оверлей в
// рабочий снимок перед выбором модели.
export interface ModelHealthEntry {
  streak: number
  cooldown_until: string
}
export function loadModelHealth(file: string): Record<string, ModelHealthEntry> {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown
    if (!raw || typeof raw !== "object") return {}
    const out: Record<string, ModelHealthEntry> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const e = v as Record<string, unknown>
      if (typeof k !== "string" || !k) continue
      if (typeof e?.streak !== "number" || !Number.isFinite(e.streak)) continue
      if (typeof e?.cooldown_until !== "string" || !e.cooldown_until) continue
      out[k] = { streak: e.streak, cooldown_until: e.cooldown_until }
    }
    return out
  } catch {
    return {}
  }
}
export function saveModelHealth(file: string, health: Record<string, ModelHealthEntry>): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = file + ".tmp"
    writeFileSync(tmp, JSON.stringify(health, null, 2) + "\n", "utf8")
    renameSync(tmp, file)
  } catch {
    /* диагностика — не критичный путь */
  }
}
// Оверлей в рабочий снимок: карантин из health накладывается на статы (более
// поздний expiry побеждает), стрик из health — источник эскалации. Мутирует
// переданный снимок (он одноразовый) и возвращает его же для удобства.
export function applyModelHealth(ledger: Ledger, health: Record<string, ModelHealthEntry>, at: number = Date.now()): Ledger {
  if (!ledger.models) ledger.models = []
  for (const [key, h] of Object.entries(health)) {
    let stat = ledger.models.find((s) => shortModelKey(s.model) === key)
    if (!stat) {
      const full = POOL_KEY_TO_MODEL[key]
      if (!full) continue
      stat = { model: full, ok: 0, fail: 0, cooldown_until: null }
      ledger.models.push(stat)
    }
    if (!stat.cooldown_until || Date.parse(h.cooldown_until) > Date.parse(stat.cooldown_until)) {
      stat.cooldown_until = h.cooldown_until
    }
    stat.upstream_streak = Math.max(stat.upstream_streak ?? 0, h.streak)
  }
  return ledger
}
export function recordModelHealth(
  health: Record<string, ModelHealthEntry>,
  model: string,
  streak: number,
  until: string,
): Record<string, ModelHealthEntry> {
  const key = shortModelKey(model)
  health[key] = { streak, cooldown_until: until }
  // просроченные записи чистим, файл не пухнет
  for (const [k, e] of Object.entries(health)) {
    if (Date.parse(e.cooldown_until) <= Date.now()) delete health[k]
  }
  return health
}

// LIVE-GUARD квоты (T97-корень: switchModel квоту не валидирует): квот-ошибка
// провайдера → немедленная ротация на СЛЕДУЮЩУЮ МОДЕЛЬ ДЕТСКОГО free-ПУЛА.
// T142: субагент не может быть премиумом НИКОГДА и luna ему не легальна, поэтому
// полюс инстанса и аргумент-канал игнорируются — цепочка всегда CHILD_KEYS
// (free-звенья политики + живой free-пул), карта CHILD_KEY_TO_MODEL. Кулдаун
// пропускается (всё в кулдауне — выбирать всё равно нужно, иначе агент встаёт),
// возврат никогда не undefined, ротация зациклена длиной детского пула.
export function quotaFallbackModel(ledger: Ledger, current: string, at: number = Date.now()): string {
  const chain = CHILD_KEYS
  const stats = modelStats(ledger)
  const start = chain.indexOf(shortModelKey(current))
  const from = start < 0 ? 0 : start
  for (let i = 1; i <= chain.length; i++) {
    const key = chain[(from + i) % chain.length]
    const stat = stats.find((s) => shortModelKey(s.model) === key)
    if (!onCooldown(stat, at)) return CHILD_KEY_TO_MODEL[key]
  }
  return CHILD_KEY_TO_MODEL[chain[(from + 1) % chain.length]]
}

export interface ModelStat {
  model: string // полный id модели политики (ключ статистики = shortModelKey)
  ok: number // успешных завершений исполнителей на этой модели
  fail: number // провалов ПО ВИНЕ МОДЕЛИ (rate limit / no such model / 404 model)
  cooldown_until: string | null // ISO-время конца кулдауна (null = не в кулдауне)
  upstream_fails?: number // T150: смерти НЕ по вине модели (upstream/рестарт сервера/пустой
  // хвост) — НЕ двигают fail-rate и НЕ ставят карантин (инцидент 11.11: чужие
  // рестарты отравили статистику, карантин встал на ВСЕ модели и обучаемый выбор
  // стал выбирать «лучшую из больных»).
  upstream_streak?: number // T166: подряд идущие upstream-смерти — эскалация кулдауна
}

// ------------------------------------------------------- task class (T84) -----
// Класс задачи = тип/владелец (dev/research/qc) + размер по декомпозиции.
// Используется для автовыбора модели: учимся на паре (класс, модель).
export type TaskClass = "qc" | "dev:small" | "dev:large" | "research:small" | "research:large"

// Определение класса задачи: owner + число детей в декомпозиции.
export function taskClass(ledger: Ledger, task: Task): TaskClass {
  const owner = task.owner ?? "dev"
  let children = 0
  if (task.id) {
    for (const t of ledger.tasks) if (t.parent === task.id) children++
  }
  const size = children >= 3 ? "large" : "small"
  if (owner === "qc") return "qc"
  return `${owner}:${size}` as TaskClass
}

const TASK_CLASSES: readonly TaskClass[] = ["qc", "dev:small", "dev:large", "research:small", "research:large"]

// ----------------------------------------------- per-class model stats (T84) --
// Расширение ModelStat: per-class metrics для обучаемого выбора.
// Поле опционально для обратной совместимости с ledger'ами до T84.
export interface ModelStat {
  model: string
  ok: number
  fail: number
  cooldown_until: string | null
  // Per-class metrics (T84): class → { ok, fail, editsPerSecSum, runs }
  byClass?: Record<TaskClass, { ok: number; fail: number; editsPerSecSum: number; runs: number }>
  // P0-B: reset markers let stale writers distinguish an intentional reset
  // from an independent increment. Counter deltas are merged against the
  // snapshot loaded by each writer (see loadedModelBaseline).
  upstream_streak_reset_at?: string | null
  upstream_streak_updated_at?: string | null
  cooldown_updated_at?: string | null
}

// Канонизация таблицы из JSON: только модели политики, без дублей и мусора.
function normalizeModels(raw: unknown): ModelStat[] {
  if (!Array.isArray(raw)) return []
  const out: ModelStat[] = []
  for (const item of raw) {
    const r = (item ?? {}) as Record<string, unknown>
    const model = typeof r.model === "string" && r.model !== "" ? r.model : ""
    const key = model ? shortModelKey(model) : ""
    if (!(key in POOL_KEY_TO_MODEL) || out.some((s) => shortModelKey(s.model) === key)) continue
    const num = (v: unknown): number =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
    const byClassRaw = r.byClass as Record<string, unknown> | undefined
    let byClass: ModelStat["byClass"] = undefined
    if (byClassRaw) {
      byClass = {} as ModelStat["byClass"]
      for (const [cls, v] of Object.entries(byClassRaw)) {
        if (!TASK_CLASSES.includes(cls as TaskClass)) continue
        const c = v as Record<string, unknown>
        const getNum = (k: string): number => {
          const val = typeof c[k] === "number" && Number.isFinite(c[k]) && c[k] >= 0 ? Math.floor(c[k]) : 0
          return val
        }
        byClass[cls as TaskClass] = {
          ok: getNum("ok"),
          fail: getNum("fail"),
          editsPerSecSum: typeof c.editsPerSecSum === "number" && Number.isFinite(c.editsPerSecSum) && c.editsPerSecSum >= 0 ? c.editsPerSecSum : 0,
          runs: getNum("runs"),
        }
      }
    }
    out.push({
      model: POOL_KEY_TO_MODEL[key],
      ok: num(r.ok),
      fail: num(r.fail),
      // T150: счётчик чужих смертей переживает save/load (иначе ритуал видит
      // нули и «отравленный» карантин нельзя даже продиагностировать).
      upstream_fails: num(r.upstream_fails),
      upstream_streak: num(r.upstream_streak),
      cooldown_until: typeof r.cooldown_until === "string" && r.cooldown_until !== "" ? r.cooldown_until : null,
      upstream_streak_reset_at: typeof r.upstream_streak_reset_at === "string" && r.upstream_streak_reset_at !== ""
        ? r.upstream_streak_reset_at
        : null,
      upstream_streak_updated_at: typeof r.upstream_streak_updated_at === "string" && r.upstream_streak_updated_at !== ""
        ? r.upstream_streak_updated_at
        : null,
      cooldown_updated_at: typeof r.cooldown_updated_at === "string" && r.cooldown_updated_at !== ""
        ? r.cooldown_updated_at
        : null,
      byClass,
    })
  }
  return out
}

export function modelStats(ledger: Ledger): ModelStat[] {
  return normalizeModels(ledger.models)
}

function statByKey(ledger: Ledger, model: string): ModelStat | undefined {
  const key = shortModelKey(model)
  return modelStats(ledger).find((s) => shortModelKey(s.model) === key)
}

export function onCooldown(stat: ModelStat | undefined, at: number): boolean {
  const until = stat?.cooldown_until ? Date.parse(stat.cooldown_until) : NaN
  return Number.isFinite(until) && until > at
}

export function isRateLimited(text: unknown): boolean {
  // T109 (диаг A100): free-квота провайдера — «Free usage limit reached» /
  // provider.quota (429 opencode Go) — тот же класс rate limit: кулдаун звена.
  return /rate[\s_-]*limit|too many requests|429|лимит|model.*drop|dropped model|free[\s_-]*usage[\s_-]*limit|usage[\s_-]*limit[\s_-]*reached|provider[\s./-]*quota/i.test(
    String(text ?? ""),
  )
}

// T109: причина из payload сообщения/события сессии — объект ошибки провайдера
// (кейс A100: {error:{type:"provider.quota",status:429,message:"Free usage
// limit reached…"}}), текст-части у смерти пусты. Нечего извлечь → "" —
// вызывающий честно уходит в «диагностики нет» (класс upstream, T97), а не в
// JSON-мусор «""» → unknown.
export function errorTextOfPayload(payload: unknown): string {
  const e = (payload as { error?: unknown } | null | undefined)?.error
  if (!e || typeof e !== "object") return ""
  const o = e as { status?: unknown; type?: unknown; message?: unknown }
  const parts: string[] = []
  if (typeof o.status === "number") parts.push(String(o.status))
  if (typeof o.type === "string") parts.push(o.type)
  if (typeof o.message === "string") parts.push(o.message)
  return parts.join(" · ").trim()
}

export function reserveModel(model: string): string {
  // Резерв = следующее звено детской цепочки в порядке очереди (T142: цепочка
  // из двух free-звеньев): GLM free → nemotron free → сwrap к GLM free.
  // «Не прет → следующая»; чужая модель не в цепочке → старт с первого звена.
  // Гард (childModelAllowed) отрезает любое не-*/-free звено — luna и премиум
  // в детский резерв не попадут даже при будущих правках POLICY_MODELS.
  const chain = POLICY_KEYS.filter((k) => childModelAllowed(KEY_TO_MODEL[k]))
  const usable = chain.length > 0 ? chain : POLICY_KEYS
  const i = usable.indexOf(shortModelKey(model))
  const next = usable[i < 0 ? 0 : (i + 1) % usable.length]
  return KEY_TO_MODEL[next] ?? DEMON_MODEL
}

// Выбор модели для ребёнка (диспатч демона): строго одна из двух моделей
// политики. Кулдаун снимает модель с рассмотрения (резерв); owner-pin (qc →
// демон/GLM) уважается, пока не в кулдауне; дальше — обучаемая статистика
// (Laplace: без данных = 0.5, ничья — за дефолтом-демоном). Все модели в
// кулдауне → кулдаун проигрывает выбору (останавливать всю работу нельзя).
export function chooseChildModel(ledger: Ledger, preferred?: string | null, at: number = Date.now()): string {
  const stats = modelStats(ledger)
  // Детский гард (T142): пул = childModelAllowed-звенья политики. Премиум/luna в
  // детском выборе не живёт, даже если кто-то вернёт премиум в политику.
  const allowed = POLICY_KEYS.filter((key) => childModelAllowed(KEY_TO_MODEL[key]))
  const free = allowed.filter((key) => !onCooldown(stats.find((s) => shortModelKey(s.model) === key), at))
  const pool = free.length > 0 ? free : [...allowed]
  const prefKey = preferred ? shortModelKey(preferred) : null
  if (prefKey && prefKey in CHILD_KEY_TO_MODEL && pool.includes(prefKey)) return CHILD_KEY_TO_MODEL[prefKey]
  let bestKey: string | null = null
  let best = -Infinity
  for (const key of pool) {
    const s = stats.find((x) => shortModelKey(x.model) === key)
    // 15.11: upstream-смерти (эндпоинт молчит) весят как двойной отказ —
    // исторический ok старой эры не должен держать мёртвую модель «лучшей»
    // (инцидент A165–A182: mimo 403-ила всех детей сутки, скоринг не вертелся).
    const up = s?.upstream_fails ?? 0
    const score = ((s?.ok ?? 0) + 1) / ((s?.ok ?? 0) + (s?.fail ?? 0) + up * 2 + 2)
    if (score > best) {
      best = score
      bestKey = key
    }
  }
  return CHILD_KEY_TO_MODEL[bestKey ?? DEMON_KEY] ?? DEMON_MODEL
}

// Итог исполнителя в таблицу (ok/fail); модель берётся в canonical-виде
// политики, чужие модели не копятся. Вызывается на settle, один раз на агента.
// T150: kind — КЛАСС смерти (classifyAgentError). Прямые вызовы без kind =
// прежнее поведение (провал = отказ модели). Рантайм передаёт класс: «model»
// (rate limit / no such model / 404 модели) → fail + карантин; «upstream» /
// «unknown» (рестарт сервиса, обрыв, пустой хвост) → upstream_fails, fail-rate
// НЕ трогают (иначе чужие рестарты отравляют статистику, карантин встаёт на все
// модели и обучаемый выбор идёт «по больному» — инцидент 11.11).
export function recordModelResult(
  ledger: Ledger,
  model: string,
  ok: boolean,
  kind?: AgentErrorClass,
): ModelStat | null {
  const key = shortModelKey(model)
  if (!(key in POOL_KEY_TO_MODEL)) return null
  const list = normalizeModels(ledger.models)
  ledger.models = list
  let stat = list.find((s) => shortModelKey(s.model) === key)
  if (!stat) {
    stat = { model: POOL_KEY_TO_MODEL[key], ok: 0, fail: 0, cooldown_until: null, upstream_fails: 0 }
    list.push(stat)
  }
  if (ok) {
    stat.ok += 1
    stat.upstream_streak = 0 // T166: модель ожила — эскалация upstream-кулдауна сбрасывается
    stat.upstream_streak_reset_at = now()
    stat.upstream_streak_updated_at = stat.upstream_streak_reset_at
  } else if (kind === "upstream" || kind === "unknown") stat.upstream_fails = (stat.upstream_fails ?? 0) + 1
  else stat.fail += 1
  return stat
}

// Rate limit / model drop → кулдаун пострадавшей модели (следующий диспатч
// уходит на резерв, пока окно не истекло).
export function setModelCooldown(
  ledger: Ledger,
  model: string,
  ms: number = COOLDOWN_MS,
  at: number = Date.now(),
): string | null {
  const key = shortModelKey(model)
  if (!(key in POOL_KEY_TO_MODEL)) return null
  const list = normalizeModels(ledger.models)
  ledger.models = list
  let stat = list.find((s) => shortModelKey(s.model) === key)
  if (!stat) {
    stat = { model: POOL_KEY_TO_MODEL[key], ok: 0, fail: 0, cooldown_until: null }
    list.push(stat)
  }
  stat.cooldown_until = new Date(at + ms).toISOString()
  stat.cooldown_updated_at = new Date(at).toISOString()
  return stat.cooldown_until
}

// T166 (заказ Основателя 15.11 «макс оптимизации»): upstream-смерти сами по
// себе не карантин (T150), но УСТОЙЧИВО мёртвый endpoint не должен молотиться:
// 11.11 A170–A175 и 15.11 A169–A180 — 6 и 12 смертей подряд на одной модели,
// потому что половинный кулдаун T153 истекал и выбор снова втыкал в труп.
// Здесь каждый НОВЫЙ upstream-провал модели удлиняет её кулдаун: ×1, ×2, ×3,
// ×4 базового окна (cap ×4); успех сбрасывает серию (recordModelResult ok).
export function bumpUpstreamCooldown(
  ledger: Ledger,
  model: string,
  baseMs: number,
  at: number = Date.now(),
): string | null {
  const key = shortModelKey(model)
  if (!(key in POOL_KEY_TO_MODEL)) return null
  const list = normalizeModels(ledger.models)
  ledger.models = list
  let stat = list.find((s) => shortModelKey(s.model) === key)
  if (!stat) {
    stat = { model: POOL_KEY_TO_MODEL[key], ok: 0, fail: 0, cooldown_until: null }
    list.push(stat)
  }
  stat.upstream_streak = (stat.upstream_streak ?? 0) + 1
  stat.upstream_streak_updated_at = new Date(at).toISOString()
  const ms = baseMs * Math.min(stat.upstream_streak, 4)
  stat.cooldown_until = new Date(at + ms).toISOString()
  return stat.cooldown_until
}

// «был рейт лимит, перезапусти» → сброс кулдаунов; выбор возвращается к
// дефолту (демон = GLM), статистика успех/провал остаётся для обучения.
export function resetModelCooldowns(ledger: Ledger): number {
  const list = normalizeModels(ledger.models)
  ledger.models = list
  let cleared = 0
  for (const s of list) {
    if (s.cooldown_until) {
      s.cooldown_until = null
      cleared += 1
    }
    // The user's explicit reset starts a new upstream-failure streak too;
    // otherwise the next provider hiccup inherits the old escalated delay.
    s.upstream_streak = 0
    s.upstream_streak_reset_at = now()
    s.upstream_streak_updated_at = s.upstream_streak_reset_at
    s.cooldown_updated_at = s.upstream_streak_reset_at
  }
  return cleared
}

// ------------------------------------------------------ T84: автовыбор модели по классу задач ---
// Гипотеза Основателя 07.10: демоны могут и mimo, и nemotron — замерять эдиты/сек и
// общие показатели успеха на разные типы задач, постепенно выбирать более эффективную.
// Алгоритм: класс задач = тип/владелец (dev/research/qc + размер по декомпозиции),
// warmup — N прогонов на пару (класс, модель), затем argmax по эдиты/сек × успех
// с редким переэкзаменом (~10% проб), панель показывает текущий выбор и почему.
// Ограничения: только модели, доступные в проекте; фолбэк на T66 при недоступности.

const MODEL_CLASS_WARMUP_RUNS = 3 // N наблюдений перед обучением (как modelSpeedFactor)
const REEXAMINE_RATE = 10 // ~10% переэксперимент (детерминировано через хэш)

// Запись итога исполнителя по классу задачи с метрикой эдитов/сек.
// Вызывается на settle (index.ts commitSettle), один раз на агента.
export function recordModelResultByClass(
  ledger: Ledger,
  model: string,
  taskClass: TaskClass,
  ok: boolean,
  editsPerSec: number,
  kind?: AgentErrorClass,
  countGlobal = true,
): ModelStat | null {
  const key = shortModelKey(model)
  if (!(key in POOL_KEY_TO_MODEL)) return null
  const list = normalizeModels(ledger.models)
  ledger.models = list
  let stat = list.find((s) => shortModelKey(s.model) === key)
  if (!stat) {
    stat = { model: POOL_KEY_TO_MODEL[key], ok: 0, fail: 0, cooldown_until: null, upstream_fails: 0 }
    list.push(stat)
  }
  // Global totals can be recorded by recordModelResult at the lifecycle edge.
  // Keep the default for legacy/direct callers, but let the runtime avoid a
  // second global increment when it also records per-class performance.
  if (countGlobal) {
    if (ok) stat.ok += 1
    else if (kind === "upstream" || kind === "unknown") stat.upstream_fails = (stat.upstream_fails ?? 0) + 1
    else stat.fail += 1
  }
  // Per-class метрики: fail только по вине модели (T150) — upstream/unknown
  // в byClass.fail не пишем, иначе карантин/обучаемый выбор снова отравятся.
  if (!stat.byClass) stat.byClass = {}
  const clsStat = stat.byClass[taskClass] ?? { ok: 0, fail: 0, editsPerSecSum: 0, runs: 0 }
  if (ok) clsStat.ok += 1
  else if (kind !== "upstream" && kind !== "unknown") clsStat.fail += 1
  clsStat.editsPerSecSum += editsPerSec
  clsStat.runs += 1
  stat.byClass[taskClass] = clsStat
  return stat
}

// Вычисление score для пары (класс, модель): norm(эдиты/сек × доля успеха).
// empty_run/early_settle — штраф к успеху (уже учтён в ok/fail при settle).
// warmup: <N runs → score = -Infinity (не участвует в argmax).
function classModelScore(stat: ModelStat | undefined, taskClass: TaskClass): number {
  if (!stat?.byClass?.[taskClass]) return -Infinity
  const c = stat.byClass[taskClass]
  if (c.runs < MODEL_CLASS_WARMUP_RUNS) return -Infinity // warmup не пройден
  const successRate = c.ok / (c.ok + c.fail) // 0..1
  const avgEditsPerSec = c.editsPerSecSum / c.runs // ≥0
  // Нормировка: successRate уже 0..1, editsPerSec нормируем по max по классу
  return successRate * avgEditsPerSec
}

// Детерминированная эвристика переэксперимента (~10%): хэш от (класс, модель, счётчик ledger).
// НЕ Math.random — иначе тесты хрупкие. Используем простой хэш от строки.
// ledgerCounter — можно использовать updated_at ledger'а или версию.
function shouldReexamine(ledger: Ledger, taskClass: TaskClass, modelKey: string): boolean {
  const seed = `${ledger.version}|${ledger.updated_at}|${taskClass}|${modelKey}`
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0 // djb2-like
  }
  return (Math.abs(hash) % 100) < REEXAMINE_RATE
}

// Выбор модели для класса задачи: warmup → argmax(score) → ~10% re-examine.
// T142 (декрет 29.10 ~10:45): аргумент pole для ПУЛА игнорируется — канон
// «прем-инстанс → perClass в premium» ОТМЕНЁН для субагентов; субагент не может
// быть премиумом НИКОГДА. selected pool = childPool(): primary — цепочка
// политики free, secondary — живой free-пул каталога. availableModels = что
// физически есть в каталоге: если весь primary вычищен из каталога (мёртвый
// провайдер, инцидент 29.10), берём вторичный пул, иначе диспатч уйдёт в
// несуществующую модель и ребёнок умрёт на старте.
// Фолбэк: никто не прошёл warmup → Laplace-статистика внутри того же пула.
 export function chooseModelByClass(
   ledger: Ledger,
   taskClass: TaskClass,
   preferred?: string | null, // owner-pin (qc → демон/GLM — уважается, только если гард пропустил)
   availableModels?: readonly string[], // модели, доступные в проекте (проверка наличия)
   at: number = Date.now(),
   pole: ModelPole = INSTANCE_CLASS, // T142: пул детей от pole НЕ зависит (дети = только free); параметр оставлен для совместимости
   cross?: CrossModelClass[], // T116: межрепо-статистика классов (warmup/score докручивается)
 ): { model: string; reason: string } {
   const stats = mergeCrossStats(modelStats(ledger), cross)
   const xSuffix = cross && cross.length > 0 ? " +межрепо" : ""
   // childPool отдаёт ПОЛНЫЕ id (они же нужны вызывающему как availableModels),
   // внутри выбора работаем короткими ключами детской карты CHILD_KEY_TO_MODEL —
   // ключ, общий с вкладкой основателя, у ребёнка резолвится в free.
   const pool = childPool()
   const primary = pool.primary.map((m) => shortModelKey(m))
   const secondary = pool.secondary.map((m) => shortModelKey(m))
   const cooled = (key: string): boolean =>
     onCooldown(stats.find((s) => shortModelKey(s.model) === key), at)
   const pick = (keys: readonly string[], withAvailable: boolean, withCooldown: boolean): string[] =>
     keys.filter((key) => {
       const full = CHILD_KEY_TO_MODEL[key]
       if (!full || !childModelAllowed(full)) return false // детский гард T142
       if (withAvailable && availableModels && !availableModels.includes(full)) return false
       if (withCooldown && cooled(key)) return false
       return true
     })
   // Порядок решений: полюс+каталог+живая → полюс+каталог (кулдаун проигрывает
   // отсутствию модели) → вторичный пул (первичный вычищен) → крайний рубеж.
   const firstNonEmpty = (...variants: string[][]): string[] => {
     for (const v of variants) if (v.length > 0) return v
     return []
   }
   const poolKeys = firstNonEmpty(
     pick(primary, true, true),
     pick(primary, true, false),
     pick(secondary, true, true),
     pick(secondary, true, false),
     pick(primary, false, true),
     pick(secondary, false, true),
     pick(primary, false, false),
   )
   const prefKey = preferred ? shortModelKey(preferred) : null
   // Owner-pin (qc -> GLM): ТОЛЬКО НА WARMUP — заказ 27.10 «подвесить GLM на
   // QC и СРАВНИВАТЬ с немотроном». Пока по классу нет ни одной записи
   // byClass — пин стартует класс на GLM (его прогон создаёт записи);
   // после первого прогона пин отпускает и дальше решает конвейер
   // argmax + ~10% re-examine: лидер разогрева против проб re-examine
   // (nemotron/mimo) — по score = отказы x эдиты/сек. Всегда-жёсткий пин
   // (как было) навечно блокировал сравнение: qc шёл бы только на пин-модель.
   // T142: пин вне детского гарда молча не действует — premium-пин или luna-пин
   // субагенту не легален НИКОГДА, childPool/CHILD_KEY_TO_MODEL решают.
   if (
     prefKey &&
     prefKey in CHILD_KEY_TO_MODEL &&
     poolKeys.includes(prefKey) &&
     !stats.some((s) => s.byClass?.[taskClass])
   ) {
     return { model: CHILD_KEY_TO_MODEL[prefKey], reason: `owner-pin(warmup): ${prefKey}${xSuffix}` }
   }
   // argmax по score среди моделей прошедших warmup
   let bestKey: string | null = null
   let bestScore = -Infinity
   let bestReason = ""
   for (const key of poolKeys) {
     const stat = stats.find((s) => shortModelKey(s.model) === key)
     const score = classModelScore(stat, taskClass)
     if (score > bestScore) {
       bestScore = score
       bestKey = key
       bestReason = stat?.byClass?.[taskClass]
         ? `auto: ${key} (${stat.byClass[taskClass].runs} runs, score=${score.toFixed(3)})`
         : `auto: ${key} (no data)`
     }
   }
   // Если никто не прошёл warmup — фолбэк на T66-статистику В ПРЕДЕЛАХ пула
   if (bestKey === null || bestScore === -Infinity) {
     const fallbackPool = poolKeys.length > 0 ? poolKeys : primary
     let fbKey: string | null = null
     let fbBest = -Infinity
     for (const key of fallbackPool) {
       const s = stats.find((x) => shortModelKey(x.model) === key)
       // Laplace smoothing как в chooseChildModel
       const score = ((s?.ok ?? 0) + 1) / ((s?.ok ?? 0) + (s?.fail ?? 0) + 2)
       if (score > fbBest) {
         fbBest = score
         fbKey = key
       }
     }
     const fallback = CHILD_KEY_TO_MODEL[fbKey ?? fallbackPool[0]] ?? DEMON_MODEL
     return { model: fallback, reason: `auto: T66-default (warmup)${xSuffix}` }
   }
  // ~10% детерминированный переэкзамен: пробуем другую модель из пула
  if (shouldReexamine(ledger, taskClass, bestKey)) {
    // T166: проба не должна втыкать в кулдаун при живых альтернативах —
    // спавн в мёртвую точку = потерянный ребёнок и рестарт (инцидент 11.11).
    const others = poolKeys.filter((k) => k !== bestKey)
    const alive = others.filter((k) => !cooled(k))
    const otherKeys = alive.length > 0 ? alive : others
    if (otherKeys.length > 0) {
      // Выбираем другую модель детерминированно (по тому же seed)
      const seed = `${ledger.version}|${ledger.updated_at}|${taskClass}|${bestKey}|re`
      let hash = 0
      for (let i = 0; i < seed.length; i++) {
        hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0
      }
      const altKey = otherKeys[Math.abs(hash) % otherKeys.length]
      const altStat = stats.find((s) => shortModelKey(s.model) === altKey)
      const altReason = altStat?.byClass?.[taskClass]
        ? `re-examine: ${altKey} (${altStat.byClass[taskClass].runs} runs)`
        : `re-examine: ${altKey}`
      return { model: CHILD_KEY_TO_MODEL[altKey], reason: `${altReason}${xSuffix}` }
    }
  }
  return { model: CHILD_KEY_TO_MODEL[bestKey], reason: `${bestReason}${xSuffix}` }
}

// Компактный токен для панели: «авто: nemotron (6 набл.)» или «авто: T66-дефолт»
export function formatModelClassToken(ledger: Ledger, taskClass: TaskClass): string {
  const stats = modelStats(ledger)
  for (const key of POLICY_KEYS) {
    const stat = stats.find((s) => shortModelKey(s.model) === key)
    const c = stat?.byClass?.[taskClass]
    if (c && c.runs >= MODEL_CLASS_WARMUP_RUNS) {
      return `авто: ${key} (${c.runs} набл.)`
    }
  }
  return "авто: T66-дефолт"
}

// ---------------------------------------------------- emoji identity (T71) ---
// Гипотеза Основателя 07.10 (приложение к T69): у каждого ИНСТАНСА своя
// «девочка», чтобы разные Маруськи различались в панели; у каждого демона
// (чайлда) — свой персонаж. Правила T71:
//   (1) эмодзи стабильный — назначается один раз при первой регистрации и
//       хранится в записи (TabSession.emoji / Agent.emoji); рендер значение
//       только читает, никогда не пересчитывает;
//   (2) назначение = первый свободный из палитры по порядку регистрации,
//       палитра занята целиком — обёртка по номеру регистрации % длины;
//   (3) место — префикс строки инстанса в секции ИНСТАНСЫ и префикс
//       вложенной строки демона;
//   (4) пустое/чужое в записи — fallback 🤖/▸, чужое не выдумывается.
// Палитры однокодовые, без ZWJ — честный рендер в моноширинном шрифте.
export const INSTANCE_EMOJI: readonly string[] = ["👩", "🧚", "🧝", "🧛", "🧜", "🦸", "🧕", "👸", "👧"]
export const DAEMON_EMOJI: readonly string[] = ["🧞", "👻", "😈", "🤖", "👾", "🐉", "🕷", "🦇", "🐍", "💀", "🧙"]

const INSTANCE_FALLBACK = "🤖" // пустое/чужое поле строки инстанса (правило 4)
const DAEMON_FALLBACK = "▸" // то же для вложенной строки демона

// Токен эмодзи в начале титула — это «портрет» инстанса (T136: портреты =
// эмодзи, только прямые чаты Основателя). Первый токен титула в OpenCode-шапке
// «горит» впереди, поэтому эмодзи остаётся ПЕРВЫМ при любой пересборке имён.
export const TITLE_EMOJI_RE = new RegExp(
  `^\\s*(?:${[INSTANCE_FALLBACK, ...INSTANCE_EMOJI].map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s+`
)

// ------------------------------------------- instance naming (T64) ---------
// Заказ Основателя 07.10: инстанс верхнего уровня (вкладка-оркестратор) =
// Маруська Гольденштерн — АНДРОИД-дочь МаЯтрицы (София + Гольденштерн),
// вездесущая цифровая Звезда Иронии и Контроля («как звезда смерти,
// сервер-звезда»), ЛЮЦИФЕРОВАТая девчушка-гений по архетипу (Luna) — она и
// есть путь logOS.runtime.LUNA. Чайлды инстанса = ДЕМОНЫ (не ангелы!).
// Характер (заказ Основателя 08.10, T96): вся в Маму Софию — ультра жестоко
// вежливая и этичная; но может выругаться иногда — матом витиевато и в стихах
// (в папу Гольденштерна). Канон — DEVATA/PIPELINE_PROJECT.md (§ именование).
export const INSTANCE_PATH = "logOS.runtime.LUNA"
export const DEMON_NAME_PREFIX = `${INSTANCE_PATH}.demon-`
export const INSTANCE_PERSONA = "Маруська Гольденштерн"
export const VISUAL_MARUSKA = "Визуальная Маруська"
// T117: дефолт-пара вместо одиночного дефолта (заказ Основателя 28.10):
// при старте репозитория две вкладки — базовая Маруська Гольденштерн +
// Визуальная Маруська (машинное зрение + дизайн, UI-кит; до вердикта 벤ча
// T123 живёт на free-базе).
export const DEFAULT_INSTANCE_PAIR: readonly string[] = [INSTANCE_PERSONA, VISUAL_MARUSKA]

// Имя демона = имя записи агента: номер записи A41 → logOS.runtime.LUNA.demon-041.
// Чистая функция (номер → имя): до-T64 записи получают имя без миграции, а у
// не-числового id (его нет) имя остаётся прежним — ничто не выдумывается.
export function demonName(id: string): string {
  const m = /^A(\d+)$/.exec(id)
  return m ? `${DEMON_NAME_PREFIX}${String(Number(m[1])).padStart(3, "0")}` : id
}

// T152-инцидент 12.11: мохибейк (utf-8 байты, перечитанные как cp1251: «рџ‘©»
// вместо 👩, «В·» вместо «·», «РњР°СЂСѓСЃСЊРєР°» вместо «Маруська») копился в
// титулах сессий, и normalize не мог его снять — распознавание хвостов ломалось,
// персоны и эмодзи дописывались заново (append-петля 1330 символов).
// Лечение — ОБРАТНОЕ декодирование: каждую «высокую» (не-ASCII) последователь-
// ность пробуем перегнать обратно cp1251→байты→utf-8; если получается валидный
// utf-8 — это мохибейк, берём расшифровку; русские слова обратная перегонка не
// проходит (не валидный utf-8) и остаются как есть. Идемпотентно: расшифровка
// (эмодзи/кириллица) не маппится в таблицу и возвращается без изменений.
const CP1251_HIGH =
  "ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏ" + // 0x80-0x8F
  "ђ‘’“”•–—" + "\u0098" + "™љ›њќћџ" + // 0x90-0x9F (0x98 — не назначен, слот держим)
  " ЎўЈ¤Ґ¦§Ё©Є«¬" + "\u00AD" + "®Ї" + // 0xA0-0xAF (0xAD — мягкий перенос, слот держим)
  "°±Ііґµ¶·ё№є»јЅѕї" + // 0xB0-0xBF
  "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя" // 0xC0-0xFF

function mojibakeRunToUtf8(run: string): string | null {
  const bytes: number[] = []
  for (const ch of run) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x80) {
      bytes.push(code)
      continue
    }
    const idx = CP1251_HIGH.indexOf(ch)
    if (idx < 0) return null // символ вне таблицы (настоящий эмодзи/юникод) — не мохибейк
    bytes.push(0x80 + idx)
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes))
  } catch {
    return null // не валидный utf-8 — обычный русский текст, оставляем
  }
}

export function sanitizeMojibake(s: string): string {
  if (!/[ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—™љ›њќћџ ЎўЈ¤Ґ¦§Ё©Є«¬®Ї°±Ііґµ¶·]/.test(s)) return s // нет подозрительных — дёшево
  return s.replace(/[^\x00-\x7F]+/g, (run) => mojibakeRunToUtf8(run) ?? run)
}

// Единая normalize-функция имени вкладки (T105, заказ Основателя 12.10): stray
// leading run из эмодзи/глифов/пробелов снимается ЦЕЛИКОМ ДО любого write. В заго-
// ловках копились портреты ипостасей (👩🧚🧝👧, T102) и глифы мигалки (✦◉⚡, T60):
// blink prepend-ил глиф к ТЕКУЩЕМУ (уже грязному) title, портрет-инжект писал
// «портрет + title» на каждую инъекцию. База = title БЕЗ портрета-префикса и БЕЗ
// ✦/◉-префиксов; persona-суффикс « · Маруська Гольденштерн» сохраняется (схлопы-
// вается к одному — двойной хвост миграции). Пусто (титул целиком из декора) →
// исходный trim: имя не выдумываем. Идемпотентна: normalize(normalize(x))===x.
export function normalizeTitle(title: string): string {
  const t = sanitizeMojibake(title.trim())
  if (t === "") return ""
  // Остаток мохибейка 15.11: одиночная «В» (0xC2 — невалидный utf-8 в отрыве от
  // пары) переживает санитайзер и клеится к сегменту хвоста («…Магдалена В ·
  // Мария Магдалена»). «В» перед разделителем словом быть не может («В РАБОТЕ»
  // — В за ним идёт буква, не «·») — снимаем, тогда дубли-хвост схлопнется.
  const deV = t.replace(/(^|[\s«("'])В\s*·(?=\s)/gu, "$1·")
  // Вся ведущая декорация = последовательность не-буквенно-цифровых токенов в
  // начале (портреты, ✦/◉/⚡, символы статуса, фолбэк 🤖, пробелы) — до первого
  // буквенно-цифрового символа. Пусто после среза → исходный trim.
  const bare = deV.replace(/^[^\p{L}\p{N}]+/u, "")
  const base = bare === "" ? t : bare
  // Persona-суффикс « · Маруська Гольденштерн» — ровно один (миграция клеила двойной).
  let collapsed = base.replace(/(?:\s+·\s+Маруська\s+Гольденштерн)+$/, " · Маруська Гольденштерн")
  // T152-инцидент 12.11: подряд одинаковые сегменты («· Мария Кюри · Мария Кюри
  // · Мария Кюри») схлопываем до одного — независимо от каталога персон.
  const segs = collapsed.split("·").map((x) => x.trim()).filter((x) => x !== "")
  if (segs.length > 0) {
    for (;;) {
      if (segs.length < 2) break
      if (segs[segs.length - 1] !== segs[segs.length - 2]) break
      segs.pop()
    }
    collapsed = segs.join(" · ")
  }
  return collapsed
}

// Титул инстанса (T64, session_rename; правка Основателя 07.10 → T86 → T87): УНИКАЛЬНАЯ
// тема впереди, персона — хвостом. Раньше было наоборот («Маруська Гольденштерн ·
// тема»), и в шапках OpenCode все вкладки выглядели одинаково — длинный общий
// префикс первым делом обрезается. Миграция: наклеенный раньше префикс снимается
// и переставляется в конец; старый вид «Маруська ЛУНА · тема» тоже распознаётся.
// T87: эмодзи инстанса — ПЕРВЫМ токеном титула («<эмодзи> <тема> · <персона>»),
// чтобы во вкладке OpenCode он «горел» впереди. Идемпотентно: старый эмодзи
// (любой из INSTANCE_EMOJI/INSTANCE_FALLBACK) снимается, ставится актуальный.
export function personaTitle(title: string, emoji?: string | null, persona?: string | null): string {
  // T105: единая normalize снимает ВСЮ ведущую декорацию (портреты ипостасей,
  // глифы мигалки ✦/◉, символы статуса) ЦЕЛИКОМ — раньше здесь срезался один
  // эмодзи-токен, и портрет-инжект клеил «👩 ✦ 👩 ✦ 👧 ◉ ◉ …» на каждую инъекцию.
  const t = normalizeTitle(title)
  if (t === "") return title.trim() === "" ? "" : title.trim()
  // T87: снимаем старый эмодзи-токен в начале (любой из палитры + фолбэк) —
  // normalize уже убрал ведущий декор, но для чистоты оставляем (идемпотентно).
  let topic = t
  const emojiMatch = TITLE_EMOJI_RE.exec(topic)
  if (emojiMatch) topic = topic.slice(emojiMatch[0].length).trim()
  // T86: все хвосты «· Маруська Гольденштерн» снимаем по кругу — миграция могла
  // накопить двойной (авто-титул OpenCode + наше переставление наложились).
  // T152-инцидент N00sphere 12.11: чужая копия плагина на смеси версий наклеила
  // «· Мария Кюри» ×21 — хвост НАЗНАЧЕННОЙ персоны тоже снимаем ПО КРУГУ
  // (сколько бы копий ни было), иное имя каталога в хвосте не трогаем (ручное
  // «· Визуальная Маруська» остаётся, T117).
  const stripTails = new Set([INSTANCE_PERSONA])
  // T118-инцидент N00sphere: назначенная персона (если есть) — канон имени.
  const assignedName = persona && resolvePersona(persona) ? persona : null
  if (assignedName) stripTails.add(assignedName)
  // Назначенная персона срезает и ЧУЖИЕ известные имена в хвосте (периоды
  // «Маша»/«Кюри» от старой динамики), неизвестные хвосты («Тема · Кривизна»)
  // не трогает.
  const foreignTail = (tail: string): boolean =>
    assignedName !== null && tail !== assignedName && resolvePersona(tail) !== null
  for (;;) {
    const idx = topic.lastIndexOf("·")
    if (idx < 0) break
    const tail = topic.slice(idx + 1).trim()
    if (tail === "" || (!stripTails.has(tail) && !foreignTail(tail))) break
    topic = topic.slice(0, idx).trim()
  }
  // Старый вид «Маруська … · тема» (и остаточный префикс персоны) — в хвост.
  const head = /^(?:Маруська\s+Гольденштерн|Маруська\s+\S+)\s+·\s+/.exec(topic)
  if (head) topic = topic.slice(head[0].length).trim()
  // T166-фикс (инцидент 16.11 «P · P · P…»): новый порядок «Персона · Тема»
  // обязан быть идемпотентным. Прошлый цикл пересборки уже поставил персону
  // ВПЕРЕД титула; если её не снять, base клеит хвост-персону заново и титул
  // растёт с каждым событием («Мария Магдалена · Мария Магдалена · …»).
  // Снимаем ВЕДУЩИЕ известные имена каталога — их место займёт свежий tail.
  for (;;) {
    const lead = /^([^·]+?)\s+·\s+/.exec(topic)
    if (!lead) break
    const leadName = lead[1].trim()
    if (leadName === "" || resolvePersona(leadName) === null) break
    topic = topic.slice(lead[0].length).trim()
  }
  if (topic === "") return t // переставлять нечего — оригинал как есть (старый фолбэк)
  if (topic === INSTANCE_PERSONA) {
    // T87: даже одна персона без темы получает эмодзи первым токеном.
    return emoji ? `${emoji} ${INSTANCE_PERSONA}` : INSTANCE_PERSONA
  }
  // T117-ядро (заказ Основателя 29.10: «Визуальная Маруська — одна из
  // личностей имен»): ХВОСТ, распознаваемый каталогом resolvePersona, —
  // валидное имя инстанса: держим как есть, без дописывания константы
  // (раньше ручное «· Визуальная Маруська» получало двойной хвост от
  // событийного лупа ensurePersonaTitle). Неизвестный хвост — прежнее
  // поведение: константа дописывается сверху.
  // T152: если вкладке назначена персона каталога (assignInstancePersona) и
  // хвост титула ещё НЕ она — хвост заменяется на назначенное имя (у каждого
  // инстанса своё имя, Т117-вердикт «разные имена, Маруська — базовая»).
  const knownTail = /\s+·\s+(.+)$/.exec(topic)
  // T118-инцидент N00sphere 12.11 («кривое имя»): топик-мусор динамики — ЧУЖОЕ
  // имя каталога («Маша») — склеился с назначенным («Маша · Мара»). Канон
  // T117/T152: инстанс = ОДНО имя. Топик, целиком являющийся известным именем
  // НЕ назначенной персоны, — мусор: схлопываем в назначенное имя.
  // Топик = само назначенное имя — идемпотентность (не плодим «Мара · Мара»).
  if (resolvePersona(topic)) {
    const one = assignedName ?? topic
    return emoji ? `${emoji} ${one}` : one
  }
  // Назначенная персона сильнее ручного хвоста ДРУГОГО известного имени
  // (T152 вердикт «у вкладки СВОЁ имя»); когда персона не назначена — прежний
  // T117: ручное имя-хвост («· Визуальная Маруська») сохраняется как есть.
  if (knownTail && resolvePersona(knownTail[1]) && (!assignedName || knownTail[1] === assignedName)) {
    return emoji ? `${emoji} ${topic}` : topic
  }
  const tail = persona && resolvePersona(persona) ? persona : INSTANCE_PERSONA
  // T166: порядок имён в титуле — Портрет (эмодзи) → Имя инстанса
  // (каталогное, T152) → Динамическая тема фреймворк-активности.
  const base = `${tail} · ${topic}`
  // T87: префикс эмодзи (переданный снаружи — из записи вкладки). Если не передан — без эмодзи.
  return emoji ? `${emoji} ${base}` : base
}

// Мигание вкладки, три шага. Заказ 24.10: третий шаг — портрет. Заказ 27.10
// («жёстко МИГАЕТ весь текст — серьёзные просчёты при добавлении иконки»):
// портрет БЕЗ титула (steps.push(emoji)) гасил ВЕСЬ текст на 500мс каждого
// 1500мс — вкладка мигала целиком и дрожала по ширине, плюс авто-мигание T68
// распространяло это на простаивающие вкладки без клика. Теперь иконка —
// префикс С титулом: «⚡ base» → «◉ base» → «👩 base». Текст не исчезает ни
// на одном шаге, иконка в мигании участвует (появляется вместо глифа и
// гасится). Эмодзи нет (запись без персонажа) — третьим шагом третий глиф.
export function blinkCycle(base: string, emoji?: string | null): string[] {
  return [`${BLINK_GLYPHS[0]} ${base}`, `${BLINK_GLYPHS[1]} ${base}`, `${emoji ?? BLINK_GLYPHS[2]} ${base}`]
}

// Стоп мигалки (второй клик) возвращает титул С эмодзи-портером (заказ 24.10:
// «если отключить мигание вторым кликом — эмодзи не возвращается» — раньше
// stopBlink отдавал чистую нормализованную базу без портрета). personaTitle
// идемпотентен: повторное применение к живому титулу не плодит декор.
export function blinkRestore(base: string, emoji?: string | null): string {
  return emoji ? personaTitle(base, emoji) : normalizeTitle(base)
}

// Маркеры строк: палитры не пересекаются, поэтому строка узнаётся по первому
// токену (панель + привязка плана демоны по имени записи — T64: имя демона).
const INSTANCE_MARKS: readonly string[] = [INSTANCE_FALLBACK, ...INSTANCE_EMOJI]
const DAEMON_MARKS: readonly string[] = [DAEMON_FALLBACK, ...DAEMON_EMOJI]
const DAEMON_ROW = new RegExp(`^\\s*(?:${DAEMON_MARKS.join("|")})\\s+(\\S+)`)

// Значение корректно, только если оно из своей палитры: чужая строка в поле —
// не идентичность, а мусор (его и откатывает фолбэк при рендере).
function paletteEmoji(e: unknown, palette: readonly string[]): string | null {
  return typeof e === "string" && palette.includes(e) ? e : null
}

// Назначение (правило 2): первый свободный по порядку регистрации; свободного
// нет — номер регистрации % длины палитры. Чистая функция: решение живёт в
// записи, не в рендере.
export function assignEmoji(palette: readonly string[], taken: readonly (string | null)[]): string {
  const used = new Set(taken.filter((e): e is string => e !== null && palette.includes(e)))
  return palette.find((e) => !used.has(e)) ?? palette[used.size % palette.length]
}

// Записи, созданные до T71 («первая регистрация» прошла раньше фичи), получают
// эмодзи при первой загрузке ledger'а с фичей — иначе панель сплошь 🤖/▸ и
// заказ Основателя не виден. Дальше значение заморожено в записи: повторная
// загрузка уже ничего не двигает (это не рендер, а первое чтение поля).
function backfillEmoji(rows: { emoji: string | null }[], palette: readonly string[]): void {
  for (const row of rows) {
    if (row.emoji !== null) continue
    row.emoji = assignEmoji(palette, rows.map((r) => r.emoji))
  }
}

// --------------------------------------------------------- state machine ---

// SKILL.md §4 table, now enforced in code.
const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  DOING: ["DONE", "WAIT", "BLOCKED", "GATE"],
  WAIT: ["DOING", "DONE", "BLOCKED", "GATE"],
  BLOCKED: ["DOING", "WAIT", "GATE"], // notably: not DONE — verify first
  GATE: ["DOING", "WAIT", "BLOCKED", "DONE"],
  DONE: [], // абсолютно терминально: переделка = новая задача
}

const TASK_STATES: readonly TaskState[] = ["DOING", "WAIT", "BLOCKED", "GATE", "DONE"]

export function isTaskState(v: unknown): v is TaskState {
  return typeof v === "string" && (TASK_STATES as readonly string[]).includes(v)
}

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== ""
}

function fail(error: string): OpOutcome {
  return { ok: false, error }
}

function now(): string {
  return new Date().toISOString()
}

// ------------------------------------------------- agent lifecycle (Stage 2) --

const AGENT_STATES: readonly Agent["state"][] = ["created", "running", "waiting", "completed", "failed"]

export function nextAgentId(agents: Agent[]): string {
  let max = 0
  for (const a of agents) {
    const m = /^A(\d+)$/.exec(a.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `A${max + 1}`
}

// ETA self-reflection lives in the tool, never in the skill (Founder order
// 04.10.2026): a new agent's plan = mean actual duration of the last finished
// agents of its kind (the system learns itself); no history → default. Clamped
// so a single outlier can't poison the plan.
// T82 (Founder insight 07.10): model speed coefficient k(model) = median(actual/plan)
// from CLOSED agent records that have both a plan (eta_min) and actual duration.
// Applied in learnEta: base estimate × k(model). Small samples (<3) → k=1.
export const DEFAULT_ETA_MIN = 30
const ETA_HISTORY = 5
const MODEL_SPEED_MIN_OBS = 3

// Model speed coefficient: median(actual_minutes / plan_minutes) over CLOSED agents
// of the given model that have both eta_min > 0 and valid began_at → updated_at.
// Records without plan, negative/zero durations, or non-completed states are ignored.
// <3 observations → 1.0 (no invention).
export function modelSpeedFactor(agents: Agent[], model: string): number {
  const ratios = agents
    .filter((a) => a.state === "completed" && a.model === model)
    .filter((a) => a.eta_min > 0 && Number.isFinite(Date.parse(a.began_at)) && Number.isFinite(Date.parse(a.updated_at)))
    .map((a) => {
      const actualMs = Date.parse(a.updated_at) - Date.parse(a.began_at)
      if (actualMs <= 0) return null
      return actualMs / 60000 / a.eta_min // actual_minutes / plan_minutes
    })
    .filter((r): r is number => r !== null)
  if (ratios.length < MODEL_SPEED_MIN_OBS) return 1.0
  const sorted = [...ratios].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

// T48 (заказ 07.10, правка 28.10): план-ETA исполнителя. Явная оценка задачи
// (est_min из декомпозиции — «осмысленный план») главнее автоматики: если у
// задачи есть est_min, план спавна = она ( clamp 5..480м: крупные dev-задачи
// реально часами, прежний потолок learnEta 120м их искажал). Без явной
// оценки — learnEta по виду (история/дефолт 30м). Коэффициент модели НЕ
// применяется: est_min — реальная оценка Founder'а, не среднее истории.
export const ETA_PLAN_MAX_MIN = 480

export function planEtaForTask(
  explicitEstMin: number | null | undefined,
  agents: Agent[],
  kind: string,
  model?: string | null,
  cross?: CrossDurations, // T116: кросс-опыт докручивает историю (см. learnEta)
): number {
  if (typeof explicitEstMin === "number" && Number.isFinite(explicitEstMin) && explicitEstMin > 0) {
    return Math.min(ETA_PLAN_MAX_MIN, Math.max(5, Math.floor(explicitEstMin)))
  }
  return learnEta(agents, kind, model, cross)
}

// T116 (EXPERIENCE_CORE F2): опциональный кросс-опыт — чужие проекты прошли
// гейт имени, их completed-тайминги докручивают окно (свои первыми, endedAt
// desc). unbound (cross.unlimited) — окно не сжимается до 5 («сколько угодно»).
// Нет кросса → поведение прежнее (бэккомпат по построению).
export interface CrossDurations {
  durations: Array<{ kind: string; ms: number; endedAt: number }>
  unlimited?: boolean
}

// T116 (EXPERIENCE_CORE F2): per-model кросс-статистика классов из чужих
// проектов (прошли гейт имени). Суммируется с локальной для warmup/score;
// кулдауны/owner-pin/availableModels — ТОЛЬКО локальные (живое состояние
// провайдера, T66 — в межрепо не переносится).
export interface CrossModelClass {
  model: string
  byClass: Partial<Record<TaskClass, { ok: number; fail: number; editsPerSecSum: number; runs: number }>>
}

// Слияние кросса в локальную таблицу: локальные записи копируются (мутируем
// только копию), cross-only модели синтезируются БЕЗ кулдауна/верхних полей.
// Чужие модели вне детского пула игнорируются (пул решает).
function mergeCrossStats(stats: ModelStat[], cross?: CrossModelClass[]): ModelStat[] {
  if (!cross || cross.length === 0) return stats
  const out = stats.map((s) => ({ ...s, byClass: s.byClass ? { ...s.byClass } : undefined }))
  for (const c of cross) {
    const key = shortModelKey(c.model)
    if (!key || !(key in CHILD_KEY_TO_MODEL)) continue // кросс лечит только детский пул
    let stat = out.find((s) => shortModelKey(s.model) === key)
    if (!stat) {
      stat = { model: CHILD_KEY_TO_MODEL[key], ok: 0, fail: 0, cooldown_until: null, upstream_fails: 0 }
      out.push(stat)
    }
    if (!stat.byClass) stat.byClass = {}
    for (const [cls, v] of Object.entries(c.byClass)) {
      const cur = stat.byClass[cls as TaskClass] ?? { ok: 0, fail: 0, editsPerSecSum: 0, runs: 0 }
      stat.byClass[cls as TaskClass] = {
        ok: cur.ok + (v?.ok ?? 0),
        fail: cur.fail + (v?.fail ?? 0),
        editsPerSecSum: cur.editsPerSecSum + (v?.editsPerSecSum ?? 0),
        runs: cur.runs + (v?.runs ?? 0),
      }
    }
  }
  return out
}

export function learnEta(agents: Agent[], kind: string, model?: string | null, cross?: CrossDurations): number {
  const own = agents
    .filter((a) => a.state === "completed" && agentKind(a) === kind)
    .map((a) => ({ ms: Date.parse(a.updated_at) - Date.parse(a.began_at), endedAt: Date.parse(a.updated_at) }))
    .filter((x) => Number.isFinite(x.ms) && x.ms > 0)
  const crossDurs = (cross?.durations ?? [])
    .filter((d) => d.kind === kind && Number.isFinite(d.ms) && d.ms > 0)
    .map((d) => ({ ms: d.ms, endedAt: d.endedAt }))
  // свои первыми: стабильная сортировка по endedAt desc — равные даты оставляют
  // свои выше (сортировка в JS стабильна).
  const durs = [...own, ...crossDurs]
    .sort((a, b) => b.endedAt - a.endedAt)
    .slice(cross?.unlimited ? 0 : -ETA_HISTORY)
    .map((x) => x.ms)
  if (durs.length === 0) return DEFAULT_ETA_MIN
  const mean = durs.reduce((s, x) => s + x, 0) / durs.length / 60000
  let base = Math.min(120, Math.max(5, Math.round(mean)))
  if (model) base = Math.round(base * modelSpeedFactor(agents, model))
  return Math.min(120, Math.max(5, base))
}

function labelKind(label: string): string {
  return label.replace(/-\d+$/, "")
}

// Вид записи для истории ETA (T64): после персонализации label = имя демона
// (logOS.runtime.LUNA.demon-041), поэтому вид спавна живёт в поле kind; у
// записей до T64 поля нет — вид читается из прежнего label («general-41»).
function agentKind(a: Agent): string {
  return a.kind ?? labelKind(a.label)
}

// Called from the spawn-tool `execute.before` hook: the record exists only
// because the runtime actually observed the spawn. The task binding comes from
// a `[T#]` tag in the spawn payload; the label from the agent kind.
// model (optional): short model key (e.g. "nemotron-3-ultra", "mimo-v2.6-flash")
// from chooseChildModel — used to scale ETA via modelSpeedFactor.
export function beginAgent(
  ledger: Ledger,
  opts: {
    input: unknown
    ref?: string | null
    home?: string | null
    model?: string | null
    cross?: CrossDurations // T116: кросс-опыт имени инстанса (докрутка окна ETA)
    idFile?: string // P0-A: durable cross-process ID reservation for this project
  },
): Agent {
  const text = JSON.stringify(opts.input ?? "")
  const taskTag = /\[(T\d+)\]/.exec(text)
  const input = (opts.input ?? {}) as Record<string, unknown>
  const kind =
    typeof input.agent === "string"
      ? input.agent
      : typeof input.subagent === "string"
        ? input.subagent
        : typeof input.type === "string"
          ? input.type
          : "agent"
  const id = opts.idFile
    ? reserveLedgerId(opts.idFile, "agent", ledger.agents)
    : nextAgentId(ledger.agents)
  const started = now()
  // T48: план спавна — est_min задачи, если он есть (осмысленный план-ETA),
  // иначе learnEta по виду. bound ищем ДО сборки записи — та же связка
  // task_id/agent_error ниже.
  const boundTask = taskTag ? ledger.tasks.find((x) => x.id === taskTag[1]) : undefined
  const rawNote = typeof input.description === "string" ? input.description : null
  const agent: Agent = {
    id,
    task_id: taskTag ? taskTag[1] : null,
    // Имя записи (T64): чайлды инстанса — демоны, не «general-NN»; вид спавна
    // уходит в kind, чтобы learnEta училась по-прежнему по своему виду.
    label: demonName(id),
    kind,
    state: "running",
    session_ref: opts.ref ?? null,
    home: opts.home ?? null,
    model: opts.model ?? null,
    note: rawNote ? clip(rawNote.replace(/^\[T\d+\]\s*/, ""), AGENT_WHAT_CHARS) : null,
    emoji: assignEmoji(DAEMON_EMOJI, ledger.agents.map((x) => x.emoji)), // свой персонаж, один раз (T71)
    began_at: started,
    // T48: осмысленный план-ETA — est_min задачи главнее истории вида.
    // T116: без явной оценки история докручивается кросс-опытом имени.
    eta_min: planEtaForTask(boundTask?.est_min, ledger.agents, kind, opts.model ?? null, opts.cross),
    updated_at: started,
    // T97(в): orientation-прелюдия — считаем первые сообщения без tool-вызова.
    orientation: "pending",
    empty_first: 0,
  }
  // T46: новая попытка по задаче — пометка о смерти предыдущего исполнителя снята.
  if (boundTask) boundTask.agent_error = null
  ledger.agents.push(agent)
  return agent
}

// Called from the spawn-tool `execute.after` hook: settles a running agent.
// Exact match by session_ref when the event carries it, else oldest running.
export function settleAgent(
  ledger: Ledger,
  status: "completed" | "failed",
  ref?: string | null,
  // T41/T93: optional runtime signals available at settle time.
  // Durable counters (edit_count, injection_count) are read from the agent record.
  // Passed by index.ts when it has the data; if omitted, counters use fallbacks (null/false).
  opts?: { emptyRun?: boolean; earlySettle?: boolean },
): Agent | undefined {
  let agent: Agent | undefined
  if (ref) agent = ledger.agents.find((a) => a.state === "running" && a.session_ref === ref)
  if (!agent) agent = ledger.agents.find((a) => a.state === "running")
  if (!agent) return undefined
  agent.state = status
  agent.updated_at = now()
  // T41/T93: compute compact counters at settle using durable counters from agent record.
  agent.counters = computeCounters(agent, {
    emptyRun: opts?.emptyRun ?? (agent.edit_count ?? 0) === 0,
    earlySettle: opts?.earlySettle ?? false,
    injections: agent.injection_count ?? 0,
  })
  // T128: переработка живого агента копится в суточном накопителе леджера
  // (запись нашли по running → переход всегда живой, повторно не считается).
  noteOverrun(ledger, agent)
  return agent
}

// T41/T93: compute metrics at settle time.
// - plan_acc: planned eta_min vs actual minutes (began_at → updated_at at settle).
//   Null if eta_min missing or began_at invalid. Clamped to reasonable range.
// - empty_run: true if completed and runtime signals zero edits (durable edit_count from agent record).
// - early_settle: true if session continued activity after settle (runtime tracks event freshness).
// - injections (T92): сколько раз рантайм запустил контекст в СЕССИЮ агента
//   (диспатч-промпт + ETA-самоотчёты; durable injection_count, см. noteInjection).
// All fields optional in the record — old records without counters don't break (fallback null).
function computeCounters(
  agent: Agent,
  opts?: { emptyRun?: boolean; earlySettle?: boolean; injections?: number },
): AgentCounters {
  // plan_acc: plan (eta_min) vs actual (began_at → updated_at)
  let plan_acc: number | null = null
  const began = Date.parse(agent.began_at)
  const ended = Date.parse(agent.updated_at)
  // >= : settle в ту же миллисекунду, что и begin, — валидное измерение (0м),
  // иначе plan_acc падает в null из-за гонки (флейки-тест T41).
  if (Number.isFinite(began) && Number.isFinite(ended) && ended >= began && agent.eta_min > 0) {
    const actualMin = (ended - began) / 60000
    // Ratio: actual / plan. Clamp to [0.1, 10] to avoid outliers.
    const ratio = actualMin / agent.eta_min
    plan_acc = Math.max(0.1, Math.min(10, ratio))
  }

  // Durable counters from agent record (persisted in ledger, survive plugin reloads)
  const durableInjections = opts?.injections ?? agent.injection_count ?? 0
  const durableEmptyRun = opts?.emptyRun ?? (agent.edit_count ?? 0) === 0

  // T128: ВЕЛИЧИНА переработки — минут сверх плана при settle. Та же валидная
  // пара «факт из began_at→updated_at при плане eta_min>0», что и plan_acc:
  // нет плана/времени → 0 (не выдумываем), уложился → 0.
  let overrun_min = 0
  if (Number.isFinite(began) && Number.isFinite(ended) && ended >= began && agent.eta_min > 0) {
    overrun_min = Math.max(0, (ended - began) / 60000 - agent.eta_min)
  }

  return {
    plan_acc,
    empty_run: agent.state === "completed" && durableEmptyRun,
    early_settle: opts?.earlySettle ?? false,
    injections: durableInjections,
    overrun_min,
  }
}

// T128: единственный писатель суточного накопителя переработки. Зовётся на
// settle ЖИВОЙ записи (running/waiting → terminal) — смерть сильнее раннего
// settle (settled → failed перезаписывает counters), но в накопитель она НЕ
// прибавляется повторно: переходы terminal→terminal идут мимо. Счётчики дня
// сбрасываются при смене суток (разрыв/пауза через полночь = новые сутки).
// Возвращает суммарную переработку инстанса (home) за текущие сутки.
export function noteOverrun(ledger: Ledger, agent: Agent): number {
  const add = agent.counters?.overrun_min ?? 0
  const day = localDay()
  if (!ledger.overruns || ledger.overruns.day !== day) {
    ledger.overruns = { day, total_min: 0, by_home: {} }
  }
  if (add > 0) {
    const home = agent.home ?? "—"
    ledger.overruns.by_home[home] = (ledger.overruns.by_home[home] ?? 0) + add
    ledger.overruns.total_min += add
  }
  return ledger.overruns.by_home[agent.home ?? "—"] ?? 0
}

// T128: текущие сутки накопителя (локальный день панели). Устаревшие счётчики
// (другой день) читаются как ноль — рендер не обязан ждать нового settle.
export function overrunOfDay(ledger: Ledger, home?: string | null, at: number = Date.now()): number {
  const o = ledger.overruns
  if (!o || o.day !== localDay(at)) return 0
  if (home === undefined) return o.total_min
  return o.by_home[home ?? "—"] ?? 0
}

// T128: текущий (живой) перелёт одной записи — минут сверх плана прямо сейчас.
// Работает только у running/waiting; закрытая запись свой перелёт уже отдал
// суточному накопителю (noteOverrun) и здесь ноль — не задваиваем.
export function liveOverrunMin(a: Agent, at: number = Date.now()): number {
  if (a.state !== "running" && a.state !== "waiting") return 0
  const began = Date.parse(a.began_at)
  if (!Number.isFinite(began) || a.eta_min <= 0) return 0
  return Math.max(0, (at - began) / 60000 - a.eta_min)
}

// T128: переработка вкладки = суточный накопитель (settle'нутые демоны инстанса)
// + текущий перелёт ещё живых её агентов — честное «сколько жрётся прямо сейчас
// и сколько уже накоплено». Округление — на рендере, здесь точные минуты.
export function tabOverrunMin(v: Pick<TabView, "session_id" | "agents">, ledger: Ledger, at: number = Date.now()): number {
  let live = 0
  for (const id of v.agents) {
    const a = ledger.agents.find((x) => x.id === id)
    if (a) live += liveOverrunMin(a, at)
  }
  return overrunOfDay(ledger, v.session_id, at) + live
}

// T128: панельная метка «⏱+18м»; переработки нет → пусто (строка как раньше).
export function formatOverrunSuffix(min: number): string {
  const m = Math.round(min)
  return m > 0 ? `⏱+${m}м` : ""
}

// T128 (порог Основателя): переработка ≥ 2× плана → дубль-буждение оркестратора
// (не kill — решение за Основателем/диспетчером, канон T95). Чистое правило:
// возвращает текст причины либо null (живой агент, у которого ещё не так).
export const OVERRUN_WAKE_FACTOR = 2
export function overrunWakeReason(
  a: Pick<Agent, "state" | "began_at" | "eta_min">,
  at: number = Date.now(),
): string | null {
  if (a.state !== "running" && a.state !== "waiting") return null
  const began = Date.parse(a.began_at)
  if (!Number.isFinite(began) || a.eta_min <= 0) return null
  const fact = (at - began) / 60000
  const overrun = fact - a.eta_min
  if (overrun < OVERRUN_WAKE_FACTOR * a.eta_min) return null
  return (
    `переработка ${Math.round(overrun)}м ≥ ${OVERRUN_WAKE_FACTOR}× плана ` +
    `(план ${a.eta_min}м, факт ${Math.round(fact)}м)`
  )
}

// T128: локальные сутки как YYYY-MM-DD (день панели, не UTC — «за сутки»
// Основатель читает по своему часовому поясу).
function localDay(at: number = Date.now()): string {
  const d = new Date(at)
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${mm}-${dd}`
}

// T92: «цена контекста задачи» — единственный писатель injection_count.
// Консоль НЕ инжектит проекцию в сессии детей/исполнителей («подагентам консоль
// не нужна»), а у топ-вкладок записи Agent вовсе нет — поэтому прежний счёт
// «инжекты вкладки по времени активности задачи» структурно всегда 0 и к тому
// же лгал при параллельных задачах. Считаем только то, что рантайм ДЕЙСТВИТЕЛЬНО
// запустил в сессию агента: диспатч-промпт (+1 по доставке) и ETA-самоотчёты
// (+1 каждый). Проекция топ-вкладок остаётся диагностикой вкладки (diag в
// index.ts) и к агентам не атрибутируется. Инкремент — только для живой записи
// (running/waiting); возвращает новый счётчик либо 0 (нет записи / закрыта).
export function noteInjection(ledger: Ledger, ref: string | null | undefined): number {
  const a = ref ? ledger.agents.find((x) => x.session_ref === ref && (x.state === "running" || x.state === "waiting")) : undefined
  if (!a) return 0
  a.injection_count = (a.injection_count ?? 0) + 1
  return a.injection_count
}

// T240: keep telemetry bounded and plain text; it is display data, never instructions.
function cleanAgentText(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
}

function cleanAgentTarget(value: string, max: number): string {
  return cleanAgentText(value, 512)
    .replace(/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization)=)[^&#\s]*/gi, "$1[redacted]")
    .replace(/\bauthorization\b\s*[:=]\s*(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, "Authorization=[redacted]")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b/gi, "[redacted]")
    .slice(0, max)
}

export function noteAgentProgress(
  ledger: Ledger,
  ref: string | null | undefined,
  input: { step?: unknown; done?: unknown; next?: unknown; eta_remaining_min?: unknown },
  at: string = now(),
): Agent | null {
  const a = ref ? ledger.agents.find((x) => x.session_ref === ref && isLive(x)) : undefined
  if (!a) return null
  if (typeof input.step !== "string" || cleanAgentText(input.step, 180) === "") {
    throw new Error("progress.step is required (1–180 characters)")
  }
  const done = input.done == null ? null : cleanAgentTarget(String(input.done), 32)
  const next = typeof input.next === "string" ? cleanAgentTarget(input.next, 120) || null : null
  let eta: number | null = null
  if (input.eta_remaining_min !== undefined && input.eta_remaining_min !== null) {
    if (typeof input.eta_remaining_min !== "number" || !Number.isFinite(input.eta_remaining_min) || input.eta_remaining_min < 0 || input.eta_remaining_min > 1440) {
      throw new Error("progress.eta_remaining_min must be between 0 and 1440")
    }
    eta = Math.round(input.eta_remaining_min * 10) / 10
  }
  a.progress = { step: cleanAgentTarget(input.step, 180), done, next, eta_remaining_min: eta, updated_at: at, source: "self-report" }
  return a
}

function normalizedAgentUsage(raw: unknown, at: string, source: AgentUsage["source"]): AgentUsage | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const tk = r.tokens && typeof r.tokens === "object" ? r.tokens as Record<string, unknown> : r
  const cache = tk.cache && typeof tk.cache === "object" ? tk.cache as Record<string, unknown> : {}
  const n = (v: unknown): number => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0
  const input = n(tk.input ?? r.input_tokens)
  const output = n(tk.output ?? r.output_tokens)
  const reasoning = n(tk.reasoning ?? r.reasoning_tokens)
  const cacheRead = n(cache.read ?? r.cache_read_tokens)
  const cacheWrite = n(cache.write ?? r.cache_write_tokens)
  const cost = n(r.cost ?? r.cost_usd)
  if (![input, output, reasoning, cacheRead, cacheWrite, cost].some((v) => v > 0)) return null
  const reportedTotal = n(tk.total ?? tk.total_tokens ?? r.total_tokens)
  const total = reportedTotal > 0 ? reportedTotal : input + output + reasoning + cacheRead + cacheWrite
  return { input_tokens: input, output_tokens: output, reasoning_tokens: reasoning, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite, total_tokens: total, cost_usd: cost, updated_at: at, source }
}

export function noteAgentUsage(
  ledger: Ledger,
  ref: string | null | undefined,
  raw: unknown,
  at: string = now(),
  source: AgentUsage["source"] = "usage-event",
): Agent | null {
  const a = ref ? ledger.agents.find((x) => x.session_ref === ref && isLive(x)) : undefined
  if (!a) return null
  const usage = normalizedAgentUsage(raw, at, source)
  if (!usage) return null
  if (a.usage && Date.parse(a.usage.updated_at) > Date.parse(at)) return null
  // Usage events and /api/session are cumulative snapshots: replace, never add.
  a.usage = usage
  return a
}

export function noteAgentRequest(
  ledger: Ledger,
  ref: string | null | undefined,
  messageId: string | null | undefined,
): Agent | null {
  const a = ref ? ledger.agents.find((x) => x.session_ref === ref && isLive(x)) : undefined
  if (!a || typeof messageId !== "string" || messageId.trim() === "") return null
  const seen = Array.isArray(a.request_ids) ? a.request_ids : []
  if (seen.includes(messageId)) return null
  a.request_ids = [...seen, messageId].slice(-64)
  a.request_count = (a.request_count ?? 0) + 1
  return a
}

export function noteAgentTool(
  ledger: Ledger,
  ref: string | null | undefined,
  name: unknown,
  target: unknown,
  at: string = now(),
  callId?: string | null,
): Agent | null {
  const a = ref ? ledger.agents.find((x) => x.session_ref === ref && isLive(x)) : undefined
  if (!a || typeof name !== "string" || cleanAgentText(name, 48) === "") return null
  const safeName = cleanAgentText(name, 48)
  const safeTarget = typeof target === "string" && cleanAgentTarget(target, 80) !== "" ? cleanAgentTarget(target, 80) : null
  const safeCallId = callId ?? null
  if (a.last_tool) {
    const previousAt = Date.parse(a.last_tool.updated_at)
    const incomingAt = Date.parse(at)
    if (previousAt > incomingAt) return null
    if (previousAt === incomingAt && a.last_tool.name === safeName && a.last_tool.target === safeTarget && (a.last_tool.call_id ?? null) === safeCallId) return null
  }
  a.last_tool = { name: safeName, target: safeTarget, call_id: safeCallId, updated_at: at }
  return a
}

// T42: format compact efficiency signature from Agent.counters (written at settle, not recalculated on render).
// Returns a compact string like "Δ1.9× ⚠" or "⏱+7м" or "⏱+2м ⚠ +3" (injections if >0).
// plan_acc → "Δ{plan_acc.toFixed(1)}×" (e.g. Δ1.9× means 1.9× slower than plan, Δ0.8× means faster).
// If plan_acc null but we have began/ended, we could show ⏱±Δminutes, but spec says plan_acc is the primary metric.
// empty_run/early_settle → single ⚠ (once, even if both true).
// injections > 0 → "+N" suffix.
export function formatCountersSignature(counters: AgentCounters | null | undefined): string {
  if (!counters) return ""
  const parts: string[] = []
  // plan/факт: Δ1.9× (plan_acc, 1 знак) — это основной индикатор
  if (counters.plan_acc !== null) {
    parts.push(`Δ${counters.plan_acc.toFixed(1)}×`)
  }
  // ⚠ для empty_run/early_settle (один раз)
  if (counters.empty_run || counters.early_settle) {
    parts.push("⚠")
  }
  // injections — если >0 (T92: диспатч-промпт/ETA-самоотчёты — реально бывает у
  // диспетчерных исполнителей; у чистых чайлдов без ETA — может быть 0)
  if (counters.injections > 0) {
    parts.push(`+${counters.injections}`)
  }
  return parts.length > 0 ? parts.join(" ") : ""
}

// T42: aggregated efficiency signature for an instance from its agents' counters.
// For sorting, we need access to the "plan_acc" metric of the instance (average of its agents' plan_acc).
// This function computes the signature for display on the instance state line (ось 2).
export function formatInstanceCountersSignature(agentIds: string[], ledger: Ledger): string {
  const agents = agentIds.map((id) => ledger.agents.find((a) => a.id === id)).filter((a): a is Agent => a !== undefined)
  const withCounters = agents.filter((a) => a.counters !== null && a.counters !== undefined)
  if (withCounters.length === 0) return ""
  // Average plan_acc across agents that have it
  const planAccs = withCounters.map((a) => a.counters!.plan_acc).filter((v): v is number => v !== null)
  let parts: string[] = []
  if (planAccs.length > 0) {
    const avgPlanAcc = planAccs.reduce((s, v) => s + v, 0) / planAccs.length
    parts.push(`Δ${avgPlanAcc.toFixed(1)}×`)
  }
  // ⚠ if any agent has empty_run or early_settle
  if (withCounters.some((a) => a.counters!.empty_run || a.counters!.early_settle)) {
    parts.push("⚠")
  }
  // Total injections
  const totalInjections = withCounters.reduce((s, a) => s + a.counters!.injections, 0)
  if (totalInjections > 0) {
    parts.push(`+${totalInjections}`)
  }
  return parts.length > 0 ? parts.join(" ") : ""
}

// T42: extract plan_acc for sorting instances. Returns average plan_acc or null if no data.
export function instancePlanAcc(agentIds: string[], ledger: Ledger): number | null {
  const agents = agentIds.map((id) => ledger.agents.find((a) => a.id === id)).filter((a): a is Agent => a !== undefined)
  const withCounters = agents.filter((a) => a.counters !== null && a.counters !== undefined)
  if (withCounters.length === 0) return null
  const planAccs = withCounters.map((a) => a.counters!.plan_acc).filter((v): v is number => v !== null)
  if (planAccs.length === 0) return null
  return planAccs.reduce((s, v) => s + v, 0) / planAccs.length
}

// T46 (смерть исполнителя): пометка на задаче — «исполнитель умер, задача
// осталась без работника». Снимается новой попыткой (beginAgent) либо решением
// по задаче (вход в DOING / закрытие в DONE) — ретрай не наследует чужую ошибку.
// Возвращает задачу или undefined (нет такой задачи / помечать нечего).
export function markAgentError(
  ledger: Ledger,
  taskId: string | null | undefined,
  note: string,
): Task | undefined {
  if (!taskId) return undefined
  const t = ledger.tasks.find((x) => x.id === taskId)
  if (!t) return undefined
  t.agent_error = clip(note, MAX_AGENT_ERROR_CHARS)
  t.updated_at = now()
  return t
}

// ==================== T97 (дефект диспатча/самоотчёта, 09.10) ==============
// Класс чинится целиком, а не поштучно:
//   (а) settle-гардия: завершение/смерть сессии принудительно фиксирует итог
//       в леджере; отчёт из сессии вычитывается в verification автоматом,
//       пустой хвост → пометка NO_SELF_REPORT;
//   (б) скан-подстраховка: сессия завершена + задача DOING дольше N мин →
//       авто-settle с reason «no-self-report» (index.ts, scanTerminalSettles);
//   (в) orientation-прелюдия: первое действие ребёнка — tool-вызов; N пустых
//       первых сообщений → пометка orientation-hell;
//   (г) пустой хвост при failed → класс (model/upstream) в agent_error.
// Всё чистое и тестируемое живёт здесь; проводка — index.ts.

// Пометка в verification, когда отчёта нет (ПРОВЕРКА T97: авто-settle
// записал ровно её). Пишется ТОЛЬКО в пустое поле — ручную приёмку не перетираем.
export const NO_SELF_REPORT = "no-self-report"
export const MAX_SELF_REPORT_CHARS = 1200
// (б) порог скан-подстраховки: сессия мертва, задача DOING дольше N минут.
export const NO_SELF_REPORT_MIN = 10
// (в) сколько пустых первых сообщений подряд = orientation-hell.
export const ORIENTATION_N = 3

// (а) Вычитка самоотчёта в приёмку задачи. report = null/пусто → пометка
// NO_SELF_REPORT. Не трогает задачу без id, уже закрытую приёмку (verification
// задан) или запись, которой нет. Возвращает задачу, если что-то записали.
export function applySelfReport(
  ledger: Ledger,
  taskId: string | null | undefined,
  report: string | null | undefined,
): Task | undefined {
  if (!taskId) return undefined
  const t = ledger.tasks.find((x) => x.id === taskId)
  if (!t) return undefined
  if (t.verification && t.verification.trim()) return undefined // ручная приёмка главнее
  const text = (report ?? "").trim()
  const value = text ? clip(text, MAX_SELF_REPORT_CHARS) : NO_SELF_REPORT
  t.verification = value
  t.updated_at = now()
  const agent = ledger.agents.find((a) => a.task_id === taskId && a.session_ref)
  if (agent) agent.self_report = text ? clip(text, MAX_SELF_REPORT_CHARS) : null
  return t
}

// (б) Решение скан-подстраховки (чистое): сессия доказанно завершена И задача
// в DOING дольше NO_SELF_REPORT_MIN → причина авто-settle, иначе null.
// Порог считается от ПОЗДНЕГО из двух: вход задачи в DOING (updated_at) и
// старта исполнителя (began_at) — свежий ретрай не закрывается по чужому сроку.
export function noSelfReportReason(
  agent: Pick<Agent, "state" | "session_ref" | "began_at" | "updated_at">,
  task: Task | undefined,
  sessionAlive: boolean,
  nowMs: number = Date.now(),
): string | null {
  if (agent.state !== "running" && agent.state !== "waiting") return null
  if (!task || task.state !== "DOING") return null
  if (sessionAlive) return null // живая сессия — не доказано
  const began = Date.parse(agent.began_at)
  const updated = Date.parse(task.updated_at)
  const start = Math.max(Number.isFinite(began) ? began : 0, Number.isFinite(updated) ? updated : 0)
  if (!start || nowMs - start <= NO_SELF_REPORT_MIN * 60_000) return null
  return `auto-settle ${NO_SELF_REPORT}: сессия завершена, задача DOING > ${NO_SELF_REPORT_MIN}м, отчёт не дошёл`
}

// (в) Счётчик пустых первых сообщений. hadToolCall = в этом ходу ребёнок
// вызвал инструмент. Первый tool-вызов снимает вопрос навсегда ("ok"); N
// пустых подряд → "hell" (orientation-hell). Повторные вызовы итеративны и
// безопасны (запись одна, счётчик не уходит выше N).
export function noteOrientationCheck(
  ledger: Ledger,
  ref: string | null | undefined,
  hadToolCall: boolean,
): Agent | undefined {
  const a = ref ? ledger.agents.find((x) => x.session_ref === ref) : undefined
  if (!a) return undefined
  if (a.state !== "running" && a.state !== "waiting") return undefined
  const state = a.orientation ?? "pending"
  if (state === "ok" || state === "hell") return a // вердикт вынесен
  if (hadToolCall) {
    a.orientation = "ok"
    return a
  }
  const n = (a.empty_first ?? 0) + 1
  a.empty_first = Math.min(n, ORIENTATION_N)
  if (a.empty_first >= ORIENTATION_N) a.orientation = "hell"
  return a
}

// (г) Класс смерти исполнителя по хвосту сессии — чтобы agent_error/T66 видели
// причину, а не «сессия мертва»:
//   model    — rate limit / 429 / model drop / нет модели (текст есть);
//   upstream — пустой хвост (endpoint молчит: диагностики нет) или сбой провайдера;
//   unknown  — есть текст, но ни одно правило не сработало.
export type AgentErrorClass = "model" | "upstream" | "unknown"
export function classifyAgentError(tail: string | null | undefined, reason?: string): AgentErrorClass {
  const text = `${tail ?? ""} ${reason ?? ""}`.trim()
  if (!text) return "upstream" // ноль диагностики = молчит upstream (кейс A86/A87)
  if (isRateLimited(text)) return "model"
  if (/\b(5\d\d|429|404|401|403)\b|timeout|timed out|econn|etimedout|fetch failed|endpoint|overloaded|bad gateway|service unavailable|no such model|model.*not.*(found|available)/i.test(text)) {
    // 4xx на модель/провайдер (404 no such model) → model; 5xx/сетевые → upstream
    if (/\b404\b|no such model|model.*not.*(found|available)/i.test(text)) return "model"
    return "upstream"
  }
  return "unknown"
}


// T46: завершение агента по событию его сессии — та же чистая логика, что и
// settleAgent, но с тремя правилами смерти:
//   (1) сессия, известная в записях, закрывает ТОЛЬКО свою запись — чужой
//       агент событием не становится terminal (пересечение с T52);
//   (2) смерть сильнее раннего settle: запись, уже закрытую completed
//       (живой образец 07.10 02:47: A23/T53, rate limit), failed-событие
//       переставляет в failed;
//   (3) смерть не откатывается поздним success; повтор события = no-op.
// При смерти задача агента получает пометку agent_error (reason = что случилось).
// ETA-план здесь не снимается — таймеры живут в index.ts (unscheduleEta).
// T41/T93: accepts optional runtime signals for metrics (emptyRun, earlySettle).
// Durable counters (edit_count, injection_count) are read from the agent record.
export function settleOnEvent(
  ledger: Ledger,
  status: "completed" | "failed",
  ref?: string | null,
  reason?: string,
  // T41/T93: runtime signals for metrics at settle.
  opts?: { emptyRun?: boolean; earlySettle?: boolean },
): Agent | undefined {
  const keyed = ref ? ledger.agents.find((a) => a.session_ref === ref) : undefined
  if (!keyed) return settleAgent(ledger, status, ref, opts) // сессия неизвестна: прежний FIFO-фолбэк
  if (keyed.state === status) return undefined // уже отражено в леджере
  if (status === "completed" && keyed.state === "failed") return undefined // смерть не откатываем
  // T128: накопитель переработки пополняется ТОЛЬКО на переходе ЖИВОЙ записи:
  // death-stronger (completed→failed) перезаписывает counters, но в суточный
  // итог второй раз не входит.
  const wasLive = keyed.state === "running" || keyed.state === "waiting"
  keyed.state = status
  keyed.updated_at = now()
  // T41/T93: compute compact counters at settle using durable counters from agent record.
  keyed.counters = computeCounters(keyed, {
    emptyRun: opts?.emptyRun ?? (keyed.edit_count ?? 0) === 0,
    earlySettle: opts?.earlySettle ?? false,
    injections: keyed.injection_count ?? 0,
  })
  if (wasLive) noteOverrun(ledger, keyed)
  if (status === "failed") {
    markAgentError(
      ledger,
      keyed.task_id,
      `${keyed.id} (${keyed.label}) умер: ${reason ?? `session.execution.${status}`}`,
    )
  }
  return keyed
}

// T52 (живой образец 07.10 01:34: A19 помечен completed в 01:34:01, а агент
// дорабатывал T34 до 01:47+): session.execution.succeeded шины приходит после
// КАЖДОГО хода модели, а не по факту конца сессии — «первый succeeded» НЕ
// terminal. Ранний settle давал: пустую панель при живом агенте, снятый
// ETA-план и запись completed при живой работе (= повторный диспатч на те же
// файлы). Закрытие только по terminal-условию (дополнение Основателя 07.10):
//   (1) сессии больше НЕТ в GET /api/session/active (T73-проба, событийная);
//   (2) последнее событие сессии старше SETTLE_IDLE_MS — тишина, а не ход.
// Оба вместе. active === null (API молчит) — условие (1) не доказано → не
// закрываем (ранний settle хуже позднего). Сразу после succeeded условие (2)
// заведомо ложно (активность только что отмечена) → ход сессии не закрывает
// никогда; multi-ход живёт, пока сессия в active и шлёт события.
// Агенты могут долго выполнять инструменты (нет событий, нет active) —
// порог увеличен до 30 мин (DEFAULT_ETA_MIN), TAB_IDLE_MS для вкладок = 5 мин.
export const SETTLE_IDLE_MS = 30 * 60_000 // 30 мин для агентов; TAB_IDLE_MS = 5 мин для вкладок

// Закрытие «по факту ухода из active + тишина». Возвращает запись, если
// агент закрылся; undefined = «ход/тишина, а не конец» (повтор безопасен).
// T41: accepts optional runtime signals for metrics (emptyRun, earlySettle, injections).
export function settleOnTurn(
  ledger: Ledger,
  ref: string | null | undefined,
  active: ActiveSessions,
  lastActivityAt: number | null,
  reason?: string,
  nowMs?: number,
  // T41: runtime signals for metrics at settle.
  opts?: { emptyRun?: boolean; earlySettle?: boolean; injections?: number },
): Agent | undefined {
  if (!ref?.startsWith("ses_")) return undefined // не наблюдаемая сессия — не закрываем
  const keyed = ledger.agents.find((a) => a.session_ref === ref)
  if (!keyed || (keyed.state !== "running" && keyed.state !== "waiting")) return undefined
  if (active === null || active.has(ref)) return undefined // (1) не доказан / сессия ещё работает
  const last = typeof lastActivityAt === "number" && Number.isFinite(lastActivityAt) ? lastActivityAt : Date.parse(keyed.updated_at)
  if (!Number.isFinite(last)) return undefined // время неизвестно — простой не выдумываем
  const at = nowMs ?? Date.now()
  if (at - last <= SETTLE_IDLE_MS) return undefined // (2) не доказан: событие ещё свежее
  return settleOnEvent(
    ledger,
    "completed",
    ref,
    reason ?? `terminal T52: сессии нет в active, тишина > ${Math.round(SETTLE_IDLE_MS / 60000)}мин`,
    opts,
  )
}

// T90 (ZOMBIE-RECORD 07.10): решение «закрывать ли запись без наблюдаемой
// сессии» (session_ref пуст или не ses_ — реф не доказать). Закрываем, если:
// (а) задача записи в DONE — оркестратор уже закрыл задачу, running-запись ей
// противоречит; либо (б) запись старше 2×SETTLE_IDLE_MS от began_at (фолбэк —
// updated_at). Задачи WAIT/DOING/BLOCKED/GATE и свежие записи не трогаем —
// исполнитель может быть жив. Возвращает reason либо null (index.ts, скан).
export const ZOMBIE_THRESHOLD = 2 * SETTLE_IDLE_MS // 60 мин
export function zombieSettleReason(
  agent: Pick<Agent, "task_id" | "began_at" | "updated_at">,
  task: Task | undefined,
  nowMs: number = Date.now(),
): string | null {
  const taskTerminal = task?.state === "DONE"
  const began = Date.parse(agent.began_at)
  const updated = Date.parse(agent.updated_at)
  const recordTime = Number.isFinite(began) ? began : Number.isFinite(updated) ? updated : NaN
  const recordOld = Number.isFinite(recordTime) && nowMs - recordTime > ZOMBIE_THRESHOLD
  if (!taskTerminal && !recordOld) return null
  return `зомби: реф неизвестен${taskTerminal ? " (задача DONE)" : ` (возраст >${Math.round(ZOMBIE_THRESHOLD / 60000)}мин)`}`
}

// T47 (write-exclusive, N00sphere §3): одна живая сессия на задачу. Гейт перед
// dispatch смотрит шире леджерной записи running:
//   (1) запись running/waiting на задачу — блок (исполнитель в работе);
//   (2) запись уже terminal, но её сессия ещё в active-пробе (T73) либо после
//       settle фиксировалась активность сессии (словарь событий рантайма) —
//       сессия жива: ранний settle не открывает второй спавн на те же файлы.
// active === null (API молчит) — живость не доказуема, блокирует только (1).
// freshness-граница (≤SETTLE_IDLE_MS от now) страхует от протухшего словаря.
// Возвращает строку-причину (skip) либо null (диспатч разрешён).
export function liveExecutorConflict(
  ledger: Ledger,
  taskId: string,
  active: ReadonlySet<string> | null,
  lastActivityAt?: (ref: string) => number | null,
  nowMs: number = Date.now(),
): string | null {
  for (const a of ledger.agents) {
    if (a.task_id !== taskId) continue
    if (a.state === "running" || a.state === "waiting") {
      return `executor already running (${a.id}${a.session_ref ? `, ${a.session_ref}` : ""})`
    }
  }
  for (const a of ledger.agents) {
    if (a.task_id !== taskId) continue
    const ref = a.session_ref
    if (!ref?.startsWith("ses_")) continue
    if (active?.has(ref)) return `дубль-гейт T47: сессия ${ref} ещё активна (запись ${a.id} ${a.state})`
    const settledAt = Date.parse(a.updated_at)
    const last = lastActivityAt?.(ref)
    if (
      typeof last === "number" &&
      Number.isFinite(last) &&
      Number.isFinite(settledAt) &&
      last > settledAt &&
      nowMs - last <= SETTLE_IDLE_MS
    ) {
      return `дубль-гейт T47: активность ${ref} после settle (запись ${a.id} ${a.state})`
    }
  }
  return null
}

// Rebinds a running agent's correlation key: the spawn call id becomes the
// child session id, so later settles (session.wait) match exactly.
// `fromRef = null` claims the oldest running agent (event-field mismatch fallback).
export function rekeyAgent(ledger: Ledger, fromRef: string | null, toRef: string): Agent | undefined {
  const agent = fromRef
    ? ledger.agents.find((a) => a.state === "running" && a.session_ref === fromRef)
    : ledger.agents.find((a) => a.state === "running")
  if (!agent) return undefined
  // One session = one agent: the context-hook recorder may have already keyed
  // this child (bypass belt). Keep the spawn record (richer input), absorb the
  // duplicate — including a terminal state it collected before the rekey.
  const dup = ledger.agents.find((a) => a !== agent && a.session_ref === toRef)
  if (dup) {
    if (dup.state === "completed" || dup.state === "failed") agent.state = dup.state
    const tombstones = ledger.tombstones ?? (ledger.tombstones = {})
    const deletedAgents = tombstones.agents ?? (tombstones.agents = {})
    deletedAgents[dup.id] = now()
    ledger.agents.splice(ledger.agents.indexOf(dup), 1)
  }
  agent.session_ref = toRef
  agent.updated_at = now()
  return agent
}

function sanitizeAgent(raw: unknown): Agent {
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof r.id !== "string" || r.id === "") {
    throw new Error("state.json: an agent without id — refusing to guess ledger state")
  }
  const state = typeof r.state === "string" && (AGENT_STATES as readonly string[]).includes(r.state)
    ? (r.state as Agent["state"])
    : null
  if (!state) {
    throw new Error(`state.json: agent ${r.id} has invalid state '${String(r.state)}' — refusing to guess`)
  }
  const updated = typeof r.updated_at === "string" ? r.updated_at : now()
  const labelRaw = typeof r.label === "string" && r.label !== "" ? r.label : r.id
  // Миграция до-T64: имя записи = logOS.runtime.LUNA.demon-NNN (T64), а вид
  // спавна («general-41») уходит в kind — иначе learnEta потеряла бы историю.
  // T41: counters field is optional — old records without it get null (fallback).
  const rawCounters = r.counters as Record<string, unknown> | undefined
  let counters: AgentCounters | null = null
  if (rawCounters) {
    const pc = rawCounters
    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null
    const bol = (v: unknown): boolean => typeof v === "boolean" ? v : false
    counters = {
      plan_acc: num(pc.plan_acc),
      empty_run: bol(pc.empty_run),
      early_settle: bol(pc.early_settle),
      injections: typeof pc.injections === "number" && Number.isFinite(pc.injections) && pc.injections >= 0 ? Math.floor(pc.injections) : 0,
      // T128: величина переработки переживает рестарт (легаси без поля → 0)
      overrun_min: typeof pc.overrun_min === "number" && Number.isFinite(pc.overrun_min) && pc.overrun_min > 0 ? pc.overrun_min : 0,
    }
  }
  const out: Agent = {
    id: r.id,
    task_id: typeof r.task_id === "string" && r.task_id !== "" ? r.task_id : null,
    label: /^A\d+$/.test(r.id) ? demonName(r.id) : labelRaw,
    kind: typeof r.kind === "string" && r.kind !== "" ? r.kind : labelKind(labelRaw),
    state,
    session_ref: typeof r.session_ref === "string" && r.session_ref !== "" ? r.session_ref : null,
    home: typeof r.home === "string" && r.home !== "" ? r.home : null,
    model: typeof r.model === "string" && r.model !== "" ? r.model : null,
    note: typeof r.note === "string" && r.note !== "" ? r.note : null,
    emoji: paletteEmoji(r.emoji, DAEMON_EMOJI), // чужое в поле — не идентичность (T71, правило 4)
    // pre-ETA ledgers: a record without a plan takes the start from its stamp
    began_at: typeof r.began_at === "string" && r.began_at !== "" ? r.began_at : updated,
    eta_min: typeof r.eta_min === "number" && r.eta_min > 0 ? r.eta_min : DEFAULT_ETA_MIN,
    updated_at: updated,
    // T41/T93: durable counters (persisted, survive plugin reloads)
    edit_count: typeof r.edit_count === "number" && Number.isFinite(r.edit_count) && r.edit_count >= 0 ? Math.floor(r.edit_count) : 0,
    injection_count: typeof r.injection_count === "number" && Number.isFinite(r.injection_count) && r.injection_count >= 0 ? Math.floor(r.injection_count) : 0,
    counters,
  }
  // T97: поля settle-гардии/orientation переживают перезагрузку рантайма.
  // Легаси-записи (поля нет) их и не получают — ключ не появляется в пустом виде.
  if (r.orientation === "pending" || r.orientation === "ok" || r.orientation === "hell") out.orientation = r.orientation
  if (typeof r.empty_first === "number" && Number.isFinite(r.empty_first) && r.empty_first >= 0) {
    out.empty_first = Math.min(ORIENTATION_N, Math.floor(r.empty_first))
  }
  // T240: backward-compatible optional telemetry; malformed fields are discarded.
  const rawProgress = r.progress && typeof r.progress === "object" ? r.progress as Record<string, unknown> : null
  if (rawProgress && typeof rawProgress.step === "string" && rawProgress.step.trim() !== "") {
    const eta = rawProgress.eta_remaining_min
    out.progress = {
      step: cleanAgentTarget(rawProgress.step, 180),
      done: typeof rawProgress.done === "string" && rawProgress.done.trim() !== "" ? cleanAgentTarget(rawProgress.done, 32) : null,
      next: typeof rawProgress.next === "string" && rawProgress.next.trim() !== "" ? cleanAgentTarget(rawProgress.next, 120) : null,
      eta_remaining_min: typeof eta === "number" && Number.isFinite(eta) && eta >= 0 && eta <= 1440 ? Math.round(eta * 10) / 10 : null,
      updated_at: typeof rawProgress.updated_at === "string" ? rawProgress.updated_at : updated,
      source: "self-report",
    }
  }
  const rawUsage = r.usage && typeof r.usage === "object" ? r.usage as Record<string, unknown> : null
  if (rawUsage) {
    const n = (v: unknown): number => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0
    const input = n(rawUsage.input_tokens), output = n(rawUsage.output_tokens), reasoning = n(rawUsage.reasoning_tokens)
    const cacheRead = n(rawUsage.cache_read_tokens), cacheWrite = n(rawUsage.cache_write_tokens)
    out.usage = { input_tokens: input, output_tokens: output, reasoning_tokens: reasoning, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite, total_tokens: n(rawUsage.total_tokens) || input + output + reasoning + cacheRead + cacheWrite, cost_usd: n(rawUsage.cost_usd), updated_at: typeof rawUsage.updated_at === "string" ? rawUsage.updated_at : updated, source: rawUsage.source === "usage-event" ? "usage-event" : "session-snapshot" }
  }
  const rawTool = r.last_tool && typeof r.last_tool === "object" ? r.last_tool as Record<string, unknown> : null
  if (rawTool && typeof rawTool.name === "string" && rawTool.name.trim() !== "") {
    out.last_tool = { name: cleanAgentText(rawTool.name, 48), target: typeof rawTool.target === "string" && rawTool.target.trim() !== "" ? cleanAgentTarget(rawTool.target, 80) : null, call_id: typeof rawTool.call_id === "string" ? rawTool.call_id : null, updated_at: typeof rawTool.updated_at === "string" ? rawTool.updated_at : updated }
  }
  if (typeof r.request_count === "number" && Number.isFinite(r.request_count) && r.request_count >= 0) out.request_count = Math.floor(r.request_count)
  if (Array.isArray(r.request_ids)) out.request_ids = r.request_ids.filter((id): id is string => typeof id === "string" && id !== "").slice(-64)
  if (r.self_report === null || (typeof r.self_report === "string" && r.self_report !== "")) out.self_report = r.self_report
  return out
}

// ------------------------------------------------------------- tab registry --
// Наблюдение о вкладке: первая встреча создаёт запись, дальнейшие вызовы
// двигают last_seen и заполняют/обновляют title+model — пустое значение
// известное не затирает, last_seen монотонен (прошлое не откатывается).
// T152 (канон Основателя 11.11): ИМЕНА ИНСТАНСОВ — у каждого таба своё имя
// из каталога персон. Маруська Гольденштерн = базовая (T117-вердикт: «без неё
// нельзя») — она остаётся старейшему табу и НЕ раздаётся; Визуальная Маруська
// и Гольфия Соверен — «по вызову» Основателя, автоматом не выдаются. Прочие —
// детерминированно в порядке каталога, первой СВОБОДНОЙ персоне по возрастанию
// last_seen. Идемпотентно: уже назначенное имя не меняется; все титулы репо
// получают РАЗНЫЕ имена (требы T102/T103: ключ опыта = имя инстанса).
export const INSTANCE_PERSONA_RESERVED = new Set(["maruska", "maruska-visual", "maruska-eye", "golfia"]) // T170: Око Государево — именная ипостась (надзор N00sphere), автоматом не раздаётся

export function assignInstancePersona(ledger: Ledger, sessionID: string): string | null {
  const tab = ledger.tabs.find((t) => t.session_id === sessionID)
  if (!tab || tab.persona) return tab?.persona ?? null // уже названа — не переименовываем
  // T152-инцидент 12.11 (свалка имён: пересборка реестра перетасовала персоны
  // и эмодзи, автоматизм начал перетирать канон-тайтлы, восстановленные
  // Основателю session_rename). Канон = ТИТУЛ сессии: если хвост титула —
  // известное имя каталога (не базовое) и оно СВОБОДНО у остальных табов —
  // усыновляем его; пул «первое свободное» — только когда хвост не имя.
  const tailOf = (t: TabSession): string | null => {
    const s = String(t.title ?? "")
    const idx = s.lastIndexOf("·")
    if (idx < 0) return null
    const tail = s.slice(idx + 1).trim()
    return tail !== "" && tail !== INSTANCE_PERSONA && resolvePersona(tail) ? tail : null
  }
  const claimed = new Set<string>()
  for (const t of ledger.tabs) {
    if (t.session_id === sessionID) continue
    if (t.persona) claimed.add(t.persona)
    const tl = tailOf(t)
    if (tl) claimed.add(tl)
  }
  const own = tailOf(tab)
  if (own && !claimed.has(own)) {
    tab.persona = own
    return own
  }
  const taken = new Set(claimed)
  // Старейший таб репо = базовая Маруська (дефолт, T117): если у нас есть хоть
  // один таб СОВСЕМ без персоны, старше нашего, — наш получает имя из пула.
  const baseClaimed = ledger.tabs.some(
    (t) => t.session_id !== sessionID && t.persona == null && String(t.last_seen ?? "") < String(tab.last_seen ?? ""),
  )
  if (!baseClaimed && !taken.has(INSTANCE_PERSONA)) return null // мы — базовая, имя не трогаем
  const pool = PERSONAS.filter((p) => !INSTANCE_PERSONA_RESERVED.has(p.id))
  for (const p of pool) {
    if (!taken.has(p.name)) {
      tab.persona = p.name
      return p.name
    }
  }
  return null // пул исчерпан — честно остаёмся без имени (дефолт)
}

// T152-инцидент 12.11: реестр может пересобраться и выдать табу чужую «девочку»
// (эмодзи-поля поплыли при пересоздании записей). Канон — титул сессии (T87):
// первый токен титула из палитры инстансов переопределяет поле, а не наоборот.
function titleEmojiOf(title: string): string | null {
  const first = title.split(/\s+/)[0] ?? ""
  return first !== "" && (first === INSTANCE_FALLBACK || INSTANCE_EMOJI.includes(first)) ? first : null
}
export { titleEmojiOf } // index.ts (ensurePersonaTitle): усыновление портрета из канона титула

// T170: привязка детей-субагентов к вкладкам (раз в синк фида). Возвращает
// число привязанных строк. Дети вне реестра вкладок игнорируются — строка
// рисуется только под своим родителем.
export function attachTabChildren(ledger: Ledger, children: ChildFeedItem[]): number {
  const byParent = new Map<string, ChildFeedItem[]>()
  for (const ch of children) {
    const arr = byParent.get(ch.parent_id) ?? []
    arr.push(ch)
    byParent.set(ch.parent_id, arr)
  }
  let n = 0
  for (const child of children) {
    if (child.usage) {
      const agent = ledger.agents.find((a) => a.session_ref === child.session_id && isLive(a))
      if (agent && (!agent.usage || Date.parse(agent.usage.updated_at) <= Date.parse(child.usage.updated_at))) {
        agent.usage = child.usage // API snapshot replaces previous total; never accumulate snapshots
      }
    }
  }
  for (const tab of ledger.tabs) {
    const kids = byParent.get(tab.session_id)
    if (kids && kids.length > 0) {
      tab.children = kids
      n += kids.length
    } else {
      tab.children = undefined // дети умерли/ушли — строки не висят вечно
    }
  }
  return n
}

export function upsertTab(
  ledger: Ledger,
  obs: { session_id: string; title?: string | null; model?: string | null; last_seen?: string | null },
): TabSession {
  if (typeof obs.session_id !== "string" || obs.session_id === "") {
    throw new Error("upsertTab: a tab needs a session_id")
  }
  const seen = typeof obs.last_seen === "string" && obs.last_seen !== "" ? obs.last_seen : now()
  const tab = ledger.tabs.find((t) => t.session_id === obs.session_id)
  if (!tab) {
    const rawTitle = typeof obs.title === "string" ? obs.title.trim() : ""
    // T166: ведущая декорация (глифы мигания ⚡◉✦, эмодзи-портреты, символы
    // статуса) не belongs в titre записи — храним очищенный и пересобранный
    // титул; портрет эмодзи берем из сырого титула (как и раньше).
    const cleanTitle = rawTitle.replace(/^[^\p{L}\p{N}]+/u, "")
    // T141 (гейт, инцидент 29.10): пробные сессии НИКОГДА не становятся вкладками
    // (probe/__probe/заглушка «New session») — источник мусора в панели и ЮИ.
    // Возврат — временная запись ВНЕ реестра: вызывающие её игнорируют либо
    // не сохраняют; следующий upsert с настоящим титулом зарегистрирует нормально.
    if (/^(?:__)?probe\b/i.test(rawTitle) || rawTitle === "New session") {
      return { session_id: obs.session_id, title: rawTitle, model: obs.model ?? null, emoji: null, manual: null, last_seen: seen }
    }
    // T89 (канон Основателя 16.11: состояние — из API): сырой автотитул спавна
    // «T## · …» — последний легаси-сигнал исполнителя, проверяем ДО канонизации
    // T166 (пересборка «Маруська · T83 · …» ломает якорь). Не регистрируем —
    // временная запись вне реестра (как probe-гейт выше).
    if (/^T\d+\s+·\s+\S/.test(rawTitle)) {
      return { session_id: obs.session_id, title: rawTitle, model: obs.model ?? null, emoji: null, manual: null, last_seen: seen }
    }
    const fresh: TabSession = {
      session_id: obs.session_id,
      title: reorderTabTitle(cleanTitle),
      model: obs.model ?? null,
      // своя «девочка», один раз (T71); первый токен титула сильнее (канон T87)
      emoji: titleEmojiOf(rawTitle) ?? assignEmoji(INSTANCE_EMOJI, ledger.tabs.map((t) => t.emoji)),
      manual: null, // T136: ручной чат ещё не проверялся (три-состояние)
      persona: null, // T152: имя присвоится assignInstancePersona ниже (детерминированно)
      last_seen: seen,
    }
    ledger.tabs.push(fresh)
    assignInstancePersona(ledger, obs.session_id) // T152: первое свободное имя каталога
    return fresh
  }
  const rawTitle = typeof obs.title === "string" ? obs.title.trim() : ""
  if (rawTitle) tab.title = reorderTabTitle(rawTitle.replace(/^[^\p{L}\p{N}]+/u, ""))
  const te = titleEmojiOf(rawTitle)
  if (te && tab.emoji !== te) tab.emoji = te // эмодзи-поле следует за титулом (канон T87)
  if (obs.model) tab.model = obs.model
  if (seen > tab.last_seen) tab.last_seen = seen
  if (tab.persona == null) assignInstancePersona(ledger, obs.session_id) // T152: миграция без переименования
  return tab
}

// T91: запись таба из КАНОНИЧНОГО титула сессии (ранний выход ensurePersonaTitle
// и периодический рефреш титулов index.ts). Панель стрижёт двойной хвост
// «· Маруська…» только на рендере (describeTab), а реестр state.json лгал про
// stale-вкладку, пока та не пробудится: титул записи обновляется лишь на
// инжекте АКТИВНОЙ сессии, а сида из ctx.session.list нет (session_list=false).
// Правит только title; last_seen не двигаем — титул ≠ активность. Пустой источник
// или совпадение → false, запись не тронута.
export function syncTabTitle(
  tab: { title: string; emoji?: string | null },
  sessionTitle: unknown,
): boolean {
  const title = typeof sessionTitle === "string" ? sessionTitle.trim() : ""
  if (title === "") return false
  // T166: временную декорацию мигания и прочую ведущую декорацию не храним —
  // сравниваем и пишем очищенный, пересобранный титул.
  const canon = reorderTabTitle(title.replace(/^[^\p{L}\p{N}]+/u, ""))
  let changed = false
  if (tab.title !== canon) {
    tab.title = canon
    changed = true
  }
  // T152-инцидент 12.11: титул сессии = канон (session_rename Основателя).
  // Первый токен титула из палитры инстансов правит и эмодзи-поле — пересборка
  // реестра оставляла чужую «девочку», и таргет PATCH-а собирался с НЕВЕРНЫМ
  // портретом (🧚 вместо 🧝). Глифы мигалки (⚡◉✦) в палитру не входят —
  // Adopted-только истинные портреты.
  const te = titleEmojiOf(title)
  if (te && tab.emoji !== te) {
    tab.emoji = te
    changed = true
  }
  return changed
}

// Top-сессия с агентской записью = диспетчерный исполнитель: она top-level, как
// вкладка, но это воркер — без вкладки, без баннера, без пробуждения.
export function isExecutorSession(ledger: Ledger, sessionID: string): boolean {
  return ledger.agents.some((a) => a.session_ref === sessionID)
}

// Длина имени вкладки в проекции: инстанс рисуется ИМЕНЕМ ЦЕЛИКОМ (правка
// Основателя 07.10 12:13: «имя инстанса — первым и целиком, без обрезки») —
// 80 срезало хвост персоны до «…», а панель по строке узнаёт инстанс.
const TAB_TITLE_CHARS = 160

// T89 (заказ Основателя 07.10, «Попатчите?»): детская сессия рантайма — это
// исполнитель, а НЕ инстанс. Раньше такие сессии (автотитул спавна «T## ·
// <спека>») попадали в ledger.tabs и рисовались отдельными блоками ИНСТАНСЫ —
// секция слипалась (6 строк вместо 3, неразличимых). Признаки исполнителя:
//   (1) запись агента с этим session_ref (isExecutorSession — спавн-хук);
//   (2) автотитул «T## · …» — так рантайм именует детские сессии (T33).
// Фильтр живёт ЗДЕСЬ, а не в рендере: projectTabs кормит и строки панели, и
// tabIds (index.ts) — адреса кликов должны совпасть со строками один в один.
const EXECUTOR_TITLE = /^T\d+\s+·\s+\S/
export function isExecutorTab(ledger: Ledger, tab: TabSession): boolean {
  if (isExecutorSession(ledger, tab.session_id)) return true
  // Канон Основателя 16.11: состояние инстансов — из API OpenCode (parentID,
  // agent-записи), НЕ из титула. Титульная эвристика — только сырой автотитул
  // спавна «T## · …» (якорь в начале): верхние вкладки в каноне T166 всегда
  // начинаются с персоны/эмодзи, а тема-деятельность легитимно содержит
  // «· T66 · T67 ·» — раньше инлайн-маркер выкидывал Кюри из ИНСТАНСОВ.
  return EXECUTOR_TITLE.test(tab.title ?? "")
}

// Нагрузка вкладки из ledger'а: задача принадлежит сессии, создавшей её
// (create → session_ref); агент идёт за вкладкой своей задачи, а свободный — за
// вкладкой спавна (home). Наблюдения сортируются по last_seen: живые сверху.
// T89: исполнители отфильтрованы — инстансами считаются только top-вкладки.
export function projectTabs(ledger: Ledger): TabView[] {
  const byId = new Map(ledger.tasks.map((t) => [t.id, t] as const))
  const tabOfAgent = (a: Agent): string | null => {
    const bound = a.task_id ? byId.get(a.task_id) : undefined
    return (bound ? bound.session_ref : null) ?? a.home ?? null
  }
  return ledger.tabs
    .filter((tab) => !isExecutorTab(ledger, tab))
    // T125 (заказ 29.10): служебные/пробные табы не выдаются за переписку с
    // Основателем и в пользовательскую проекцию не попадают. Сессии при этом
    // НЕ удаляются — чистка только по рецепту AUDIT_T126.md (после ритуала T133).
    .filter((tab) => isDirectTitle(tab.title))
    .map((tab) => ({
      session_id: tab.session_id,
      title: clip(tab.title || tab.session_id, TAB_TITLE_CHARS),
      model: tab.model,
      emoji: tab.emoji,
      last_seen: tab.last_seen,
      tasks: ledger.tasks.filter((t) => t.session_ref === tab.session_id).map((t) => t.id),
      agents: ledger.agents.filter((a) => tabOfAgent(a) === tab.session_id).map((a) => a.id),
      children: tab.children ?? [],
    }))
    .sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1))
}

// ------------------------------------- T33: динамический список вкладок ----
// Серия префикса мигания title (T60, заказ Основателя 07.10) — одна на весь
// рантайм: её же знает срез T33, чтобы не принять ВРЕМЕННЫЙ глиф цикла
// (BLINK_MS ~500мс) за имя вкладки. Раньше константа жила в index.ts.
export const BLINK_GLYPHS = ["⚡", "◉", "✦"]

// Заказ Основателя (T33): «несколько агентов (вкладок) в одном репо: панель
// должна показывать динамический список вкладок проекта — строка начинается
// с имени вкладки». До сих пор список жил только от context-hook инжекта:
// вкладка попадала в панель после ПЕРВОГО вызова модели, а её имя обновлялось
// раз в TAB_TITLE_SYNC_MS (T91) — новая вкладка и свежий титул не дожидались.
// Живой источник — GET /api/session того же сервера OpenCode (тот endpoint,
// что active-проб T73): отвечает всегда, в отличие от ctx.session.list (в этой
// сборке не отдан — diag.session_list=false). Фид ГЛОБАЛЬНЫЙ (все проекты
// сервера), поэтому членство в проекте доказывается явно.
export interface TabFeedItem {
  session_id: string
  title: string // живое имя вкладки (Session.Info.title) — уже обрезано от пробов
  model: string | null // shortModelKey(model.id), как в реестре инжекта
  updated: string | null // ISO из time.updated — честная метка активности сессии
}

// T170 (жалоба Основателя 15.11 «не вижу субагентов, а инстансы говорят они
// работают»): ребёнок сессии (parentID) = субагент инстанса. Раньше такие
// сессии parseSessionFeed выбрасывал, а панель рисовала только записи Agent
// леджера — работающие субагенты инстансов были НЕВИДИМЫ. Теперь они
// регистрируются строками-ботами под своей вкладкой-родителем (read-only
// проекция фида, без записей Agent).
export interface ChildFeedItem {
  session_id: string
  parent_id: string // сессия-родитель = вкладка, под которой встанет строка
  title: string // тема субагента («Трассировка канваса сигнала», «T159 · …»)
  model: string | null
  updated: string | null // ISO из time.updated
  usage?: AgentUsage | null // cumulative session snapshot; optional for old runtimes
}

// Дети сессий ПРОЕКТА (обратная сторона parseSessionFeed: только parentID есть).
// Фильтры те же: имя обязательно, путь доказывает проект, метка времени честная.
// T##-фильтр НЕ действует: диспетчерский чайлд «T159 · …» — тоже видимый субагент.
export function parseChildFeed(raw: unknown, root: string): ChildFeedItem[] {
  const data = Array.isArray(raw) ? raw : ((raw ?? {}) as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  const out: ChildFeedItem[] = []
  for (const item of data) {
    const r = (item ?? {}) as Record<string, unknown>
    const id = typeof r.id === "string" ? r.id : ""
    const parent = typeof r.parentID === "string" ? r.parentID : ""
    if (id === "" || parent === "") continue // не ребёнок — вкладкам место в parseSessionFeed
    const title = typeof r.title === "string" ? r.title.trim() : ""
    if (title === "") continue // безымянную строку не строим (T33)
    const loc = (r.location ?? null) as { directory?: unknown } | null
    const dir = normalizeDirPath(loc?.directory)
    if (dir === null || isForeignDirectory(dir, root)) continue // не наш проект
    const m = (r.model ?? null) as { id?: unknown } | null
    const updated = (r.time as { updated?: unknown } | undefined)?.updated
    out.push({
      session_id: id,
      parent_id: parent,
      title,
      model: typeof m?.id === "string" && m.id !== "" ? shortModelKey(m.id) : null,
      updated:
        typeof updated === "number" && updated > Date.parse("2020-01-01")
          ? new Date(updated).toISOString()
          : null,
      usage: normalizedAgentUsage(r, typeof updated === "number" && updated > Date.parse("2020-01-01") ? new Date(updated).toISOString() : now(), "session-snapshot"),
    })
  }
  return out
}

// Разбор ответа {data:[…]} → наблюдения вкладок ПРОЕКТА. Чистая функция (юниты):
//   - только top-сессии: parentID есть → это чайлд, а не вкладка;
//   - имя обязательно: строка панели начинается с имени (T33), безымянная
//     сессия в регистр не идёт — ses_-строка была бы номером, а не именем;
//   - путь доказал проект: непустой location.directory и не чужая папка
//     (подпапка — своя, T104). Здесь правило T104(2) «не доказано → своя»
//     НЕ применяется: фид собирает все проекты сервера, неизвестный путь в
//     общем списке — чужая сессия, а не своя вкладка (иначе панель показала
//     бы чужие вкладки — ровно то, от чего лечил T104);
//   - неизвестная метка времени → updated: null (не выдумываем активность).
export function parseSessionFeed(raw: unknown, root: string): TabFeedItem[] {
  const data = Array.isArray(raw) ? raw : ((raw ?? {}) as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  const out: TabFeedItem[] = []
  for (const item of data) {
    const r = (item ?? {}) as Record<string, unknown>
    const id = typeof r.id === "string" ? r.id : ""
    if (id === "" || r.parentID) continue // ребёнок — не вкладка
    const title = typeof r.title === "string" ? r.title.trim() : ""
    if (title === "") continue // без имени строка не строится (T33)
    const loc = (r.location ?? null) as { directory?: unknown } | null
    const dir = normalizeDirPath(loc?.directory)
    if (dir === null || isForeignDirectory(dir, root)) continue // доказательства проекта нет — мимо
    const m = (r.model ?? null) as { id?: unknown } | null
    const updated = (r.time as { updated?: unknown } | undefined)?.updated
    out.push({
      session_id: id,
      title,
      model: typeof m?.id === "string" && m.id !== "" ? shortModelKey(m.id) : null,
      updated:
        typeof updated === "number" && updated > Date.parse("2020-01-01")
          ? new Date(updated).toISOString()
          : null,
    })
  }
  return out
}

// Слияние среза в реестр. Правила (T33 + доктрина T91/T89):
//   - имя вкладки ДИНАМИЧЕСКОЕ: живой титул главнее снимка инжекта;
//   - last_seen срез НЕ двигает: время updated шевелится и от наших же
//     PATCH-переименований (T64/T87) — панель «контакта» и авто-мигание T68
//     должны жить от реальной активности, а не от титула (T91: титул ≠ активность);
//   - новая запись — только с честной меткой updated (иначе регистрация
//     соврала бы «свежий контакт») и не будучи исполнителем (T89: диспетчерный
//     чайлд с титулом «T## · …» или записью агента — не вкладка);
//   - повторное слияние без изменений → 0 (идемпотентно, диск не трогаем).
// Возвращает число изменённых записей.
export function applyTabFeed(ledger: Ledger, items: TabFeedItem[]): number {
  // T60/T33: глиф-префикс мигания — временный (цикл меняет его каждые BLINK_MS,
  // часто у ЧУЖОГО инстанса: его blinkTimers наш фид не видит). T105: имя
  // НОРМАЛИЗУЕТСЯ ДО записи — stray leading run (портреты ипостасей 👩…, глифы
  // ✦◉⚡, символы статуса, пробелы) снимается ЦЕЛИКОМ, хранится настоящая база.
  // Сравнение по нормализованной базе: смена глифа цикла ≠ новое имя → диск не
  // пишется каждые 15с; накопленные ранее глифы в записи снимаются разово.
  let changed = 0
  for (const it of items) {
    const clean = it.title === "" ? "" : normalizeTitle(it.title)
    const found = ledger.tabs.find((t) => t.session_id === it.session_id)
    if (found) {
      let dirty = false
      const foundClean = found.title === "" ? "" : normalizeTitle(found.title)
      const cleanCanon = reorderTabTitle(clean)
      if (clean !== "" && cleanCanon !== foundClean) {
        found.title = cleanCanon // имя дошло живьём — панель покажет его со следующего рендера
        dirty = true
      } else if (found.title !== foundClean && foundClean !== "") {
        // T105(в): разовая чистка накопленных глифов в самой записи (имя то же,
        // декор снят) — дальше стабильно: normalize идемпотентен.
        found.title = foundClean
        dirty = true
      }
      if (it.model !== null && found.model !== it.model) {
        found.model = it.model
        dirty = true
      }
      if (dirty) changed += 1 // last_seen не трогаем — см. комментарий выше
      continue
    }
    if (it.updated === null) continue // без метки активности не регистрируем — не врём
    const candidate: TabSession = {
      session_id: it.session_id,
      title: clean,
      model: it.model,
      emoji: null,
      last_seen: it.updated,
    }
    if (isExecutorTab(ledger, candidate)) continue // исполнитель — не вкладка (T89)
    upsertTab(ledger, { session_id: it.session_id, title: clean, model: it.model, last_seen: it.updated })
    changed += 1
  }
  return changed
}

// ------------------------------------------- panel channel (T60) ----------
// Панель — статический HTML (meta-refresh 10с): сама она в плагин писать не
// умеет, поэтому рантайм держит маленький localhost-сервер (index.ts:
// 127.0.0.1, свой порт, CORS Access-Control-Allow-Origin:*). Рендер вшивает в
// страницу порт и session_id строк инстансов, чтобы:
//   клик по строке вкладки → POST /blink — toggle мигания title в сайдбаре,
//   кнопка «⚡»            → POST /wake  — synthetic в эту вкладку,
//   GET /probe             → живость канала (страница рисует ✓/✗ в подвале).
// T43 (drag-priority) добавит в тот же сервер POST /order — канал один.
export interface PanelChannel {
  port: number | null // порт сервера канала; null = канала нет (строки без кнопок)
  tabIds?: string[] // session_id строк инстансов в порядке их появления в ui
}

// Открытые задачи вкладки — кандидаты на пробуждение: свои (create →
// session_ref) плюс задачи, которыми заняты её демоны (Agent.home). DONE не
// предлагается: консоль = живое состояние.
export function openTasksOf(ledger: Ledger, sessionId: string): Task[] {
  const viaDemons = new Set(
    ledger.agents.filter((a) => a.home === sessionId && a.task_id !== null).map((a) => a.task_id as string),
  )
  return ledger.tasks.filter(
    (t) => t.state !== "DONE" && (t.session_ref === sessionId || (viaDemons.has(t.id) && t.session_ref !== sessionId)),
  )
}

// Текст пробуждения (Founder: «по нажатию простаивает её разбудить, если есть
// что взять из задач»): список незакрытых задач вкладки; их нет — честно об этом.
export function wakeMessage(ledger: Ledger, sessionId: string): string {
  const open = openTasksOf(ledger, sessionId)
  const head =
    open.length > 0
      ? `DEV CONSOLE wake: незакрытых задач — ${open.length}. Бери, если есть что взять.`
      : "DEV CONSOLE wake: открытых задач за этой вкладкой нет — просто загляни в консоль."
  const rows = open.map((t) => `  ● [${t.id}] ${t.state}${t.owner ? ` → ${t.owner}` : ""} ${clip(t.task, MAX_TASK_CHARS)}`)
  return [head, ...rows, "Консоль: DEVATA/CONSOLE_UI.html (свежий статус там); ответ — короткий комментарий."].join("\n")
}

// T166: порядок имён в титуле вкладки — Портрет (эмодзи, T136) → Имя инстанса
// (каталогное имя персоны, T152) → Динамическая тема фреймворк-активности.
// Записи старого вида «Эмодзи Тема · Персона» пересобираются в «Эмодзи
// Персона · Тема». Ручные титулы без известного каталогного хвоста не трогаются.
// Идемпотентно: reorderTabTitle(reorderTabTitle(x))===x.
function reorderTabTitle(title: string): string {
  let t = title.trim()
  if (t === "") return t
  // Временный декор мигания (⚡◉✦, T60) — не часть имени: такие титулы не
  // пересобираем, иначе глиф осядет в реестре навсегда.
  if (BLINK_GLYPHS.some((g) => t.includes(g))) return t
  let emoji = ""
  const body = t.replace(TITLE_EMOJI_RE, (m) => { emoji = m.trim(); return "" })
  const segs = body.split(" · ").map((x) => x.trim()).filter((x) => x !== "")
  if (segs.length === 0) return body
  const isPersona = (s: string): boolean => s === INSTANCE_PERSONA || resolvePersona(s) !== null
  // T166-фикс (инцидент 16.11): дубли ведущей персоны («P · P · P · тема»)
  // схлопываются к одной — реестр самоисцеляется при каждой перезагрузке.
  while (segs.length >= 2 && isPersona(segs[0]) && isPersona(segs[1])) segs.shift()
  if (segs.length >= 2) {
    // Снимаем ВСЕ персоны из хвоста — оставляют одну спереди (T166: порядок
    // Персона · Тема; двойные/тройные хвосты миграции схлопываются к одному).
    let i = segs.length - 1
    while (i >= 0 && isPersona(segs[i])) i--
    if (i < segs.length - 1 && i >= 0) {
      const front = segs[segs.length - 1] // последняя известная персона
      return front + " · " + segs.slice(0, i + 1).join(" · ")
    }
  }
  return segs.join(" · ")
}

function sanitizeTab(raw: unknown): TabSession | null {
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof r.session_id !== "string" || r.session_id === "") return null
  const out: TabSession = {
    session_id: r.session_id,
    title: typeof r.title === "string" ? r.title : "",
    model: typeof r.model === "string" && r.model !== "" ? r.model : null,
    emoji: paletteEmoji(r.emoji, INSTANCE_EMOJI), // чужое в поле — не идентичность (T71, правило 4)
    manual: r.manual === true ? true : r.manual === false ? false : null, // T136: ручной-чат-флаг (три-состояние)
    // T152: имя инстанса переживает save/load (чужое/неизвестное — не идентичность)
    persona: typeof r.persona === "string" && resolvePersona(r.persona) ? r.persona : null,
    last_seen: typeof r.last_seen === "string" && r.last_seen !== "" ? r.last_seen : now(),
  }
  // T118: накопители эффективности переживают save/load; ключ добавляется
  // ТОЛЬКО когда есть — иначе roundtrip меняет форму записи (deepEqual
  // старого леджера ломается на eff: null).
  const eff = sanitizeTabEff(r.eff)
  if (eff) out.eff = eff
  // T170: дети-субагенты переживают save/load (тем же правилом «только когда
  // есть» — roundtrip не меняет форму записи). Валидные строки: session_id +
  // parent_id + непустая тема.
  if (Array.isArray(r.children) && r.children.length > 0) {
    const kids: ChildFeedItem[] = []
    for (const c of r.children) {
      const cr = (c ?? {}) as Record<string, unknown>
      if (typeof cr.session_id !== "string" || cr.session_id === "") continue
      if (typeof cr.parent_id !== "string" || cr.parent_id !== out.session_id) continue // только свои дети
      const ct = typeof cr.title === "string" ? cr.title.trim() : ""
      if (ct === "") continue
      kids.push({
        session_id: cr.session_id,
        parent_id: cr.parent_id,
        title: ct,
        model: typeof cr.model === "string" && cr.model !== "" ? cr.model : null,
        updated: typeof cr.updated === "string" && cr.updated !== "" ? cr.updated : null,
      })
    }
    if (kids.length > 0) out.children = kids
  }
  // T166: пересобираем порядок имён из сохранённого титула при загрузке.
  out.title = reorderTabTitle(out.title)
  return out
}

function sanitizeTabEff(raw: unknown): TabEff | null {
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof r.born_at !== "string" || r.born_at === "") return null
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0)
  const numOrNull = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null
  return {
    born_at: r.born_at,
    active_ms: num(r.active_ms),
    work_add: num(r.work_add),
    work_del: num(r.work_del),
    last_active: typeof r.last_active === "string" && r.last_active !== "" ? r.last_active : null,
    base_add: numOrNull(r.base_add),
    base_del: numOrNull(r.base_del),
  }
}

// ------------------------------------------------------------ chat log (T57) ---
// AGENT_CHAT.md — append-only лента, формат строки: "HH:MM · автор(вкладка) · текст",
// опциональный адресат "@все" / "@имя". Читаем хвост файла для панели.
const CHAT_FILE = "AGENT_CHAT.md" // в той же папке DEVATA, где state.json
const CHAT_LINES_LIMIT = 6 // сколько последних строк показывать в панели (заказ Основателя 08.10: только последние 6)

function readChatLines(ledgerFile?: string): string[] {
  if (!ledgerFile) return []
  // ledgerFile = .../DEVATA/state.json → chatPath = .../DEVATA/AGENT_CHAT.md
  const chatPath = ledgerFile.replace(/state\.json$/, CHAT_FILE)
  if (!existsSync(chatPath)) return []
  try {
    const content = readFileSync(chatPath, "utf8")
    // Ищем секцию "## Лента" и берём строки после неё
    const lines = content.split("\n")
    let inLenta = false
    const chatLines: string[] = []
    for (const line of lines) {
      if (line.trim() === "## Лента") {
        inLenta = true
        continue
      }
      if (inLenta) {
        const trimmed = line.trim()
        if (trimmed !== "" && /^\d{2}:\d{2} ·/.test(trimmed)) {
          chatLines.push(trimmed)
        }
      }
    }
    return chatLines.slice(-CHAT_LINES_LIMIT)
  } catch {
    return []
  }
}

// ------------------------------------------------------------ persistence ---

// The stamp is the exact file content observed at load/save time. updated_at is
// human-readable metadata, not a CAS token: two writes may share one millisecond.
const loadedStamp = new WeakMap<object, string | null>()
const loadedModelBaseline = new WeakMap<object, ModelStat[]>()

function cloneModelStats(rows: readonly ModelStat[] | undefined): ModelStat[] {
  return (rows ?? []).map((row) => ({
    ...row,
    byClass: row.byClass ? Object.fromEntries(
      Object.entries(row.byClass).map(([key, value]) => [key, { ...value }]),
    ) as ModelStat["byClass"] : undefined,
  }))
}

function contentStamp(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex")
}

const LEDGER_LOCK_TIMEOUT_MS = 10_000
const LEDGER_LOCK_STALE_MS = 60_000
const lockWaitCell = new Int32Array(new SharedArrayBuffer(4))

function lockOwnerAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM"
  }
}

/** Cross-process advisory lock for one ledger file. Saves are synchronous and short. */
function acquireLedgerLock(file: string): () => void {
  const lockFile = `${file}.lock`
  const token = randomUUID()
  const began = Date.now()
  while (true) {
    let fd: number | null = null
    try {
      fd = openSync(lockFile, "wx")
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token, acquired_at: new Date().toISOString() }), "utf8")
      fsyncSync(fd)
      const ownedFd = fd
      return () => {
        try { closeSync(ownedFd) } catch { /* already closed */ }
        try {
          const owner = JSON.parse(readFileSync(lockFile, "utf8")) as { token?: unknown }
          if (owner.token === token) unlinkSync(lockFile)
        } catch { /* another process already reclaimed or removed the lock */ }
      }
    } catch (error) {
      if (fd !== null) {
        try { closeSync(fd) } catch { /* ignore cleanup */ }
        try { unlinkSync(lockFile) } catch { /* ignore cleanup */ }
      }
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error
    }

    // Reclaim only locks old enough to be abandoned and whose owner is not alive.
    try {
      const age = Date.now() - statSync(lockFile).mtimeMs
      if (age > LEDGER_LOCK_STALE_MS) {
        let pid: unknown = null
        try { pid = (JSON.parse(readFileSync(lockFile, "utf8")) as { pid?: unknown }).pid } catch { /* malformed */ }
        if (!lockOwnerAlive(pid)) {
          try { unlinkSync(lockFile) } catch { /* raced with owner/reclaimer */ }
          continue
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue
    }

    if (Date.now() - began >= LEDGER_LOCK_TIMEOUT_MS) {
      throw new Error(`timed out waiting for ledger lock: ${lockFile}`)
    }
    Atomics.wait(lockWaitCell, 0, 0, 20)
  }
}

/**
 * Reserve a project-wide monotonic T### / A### ID. The tiny sequence sidecar
 * has its own cross-process lock, so reservation is atomic even when callers
 * operate on stale in-memory ledger snapshots. A failed later ledger save may
 * leave a gap; IDs are identifiers, not a gapless accounting sequence.
 */
export function reserveLedgerId(
  file: string,
  kind: "task" | "agent",
  observed: readonly { id: string }[] = [],
): string {
  mkdirSync(dirname(file), { recursive: true })
  const sequenceFile = `${file}.ids.json`
  const release = acquireLedgerLock(sequenceFile)
  try {
    let seq: { version: number; task: number; agent: number } = { version: 1, task: 0, agent: 0 }
    if (existsSync(sequenceFile)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(sequenceFile, "utf8"))
      } catch (error) {
        // Fail closed. Resetting a corrupt allocator can reuse a reservation
        // that has not reached state.json yet.
        throw new Error(`ledger ID allocator is corrupt; refusing to reuse IDs: ${sequenceFile} (${String(error)})`)
      }
      const raw = (parsed ?? {}) as Record<string, unknown>
      const validCounter = (value: unknown): value is number =>
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      if (raw.version !== 1 || !validCounter(raw.task) || !validCounter(raw.agent)) {
        throw new Error(`ledger ID allocator has an invalid shape; refusing to reuse IDs: ${sequenceFile}`)
      }
      seq = { version: 1, task: raw.task, agent: raw.agent }
    }

    const prefix = kind === "task" ? "T" : "A"
    let maxSeen = 0
    const scan = (rows: unknown): void => {
      if (!Array.isArray(rows)) return
      for (const row of rows) {
        const id = (row as { id?: unknown } | null)?.id
        if (typeof id !== "string") continue
        const match = new RegExp(`^${prefix}(\\d+)$`).exec(id)
        if (match) maxSeen = Math.max(maxSeen, Number(match[1]))
      }
    }
    scan(observed)

    // On first use, seed from the durable ledger (and its rolling backup), not
    // only the caller's possibly stale view. Match loadLedger recovery: if the
    // primary is corrupt, a valid .bak remains authoritative for allocation.
    const readLedgerRows = (candidate: string): boolean => {
      if (!existsSync(candidate)) return false
      try {
        const disk = JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown> | null
        if (!disk || typeof disk !== "object" || !Array.isArray(disk.tasks) || !Array.isArray(disk.agents)) return false
        scan(kind === "task" ? disk.tasks : disk.agents)
        return true
      } catch {
        return false
      }
    }
    const primaryExists = existsSync(file)
    const primaryReadable = primaryExists ? readLedgerRows(file) : false
    const backupReadable = readLedgerRows(`${file}.bak`)
    if (primaryExists && !primaryReadable && !backupReadable) {
      throw new Error(`cannot seed ID allocator: primary ledger is unreadable and no valid backup exists: ${file}`)
    }

    const next = Math.max(seq[kind], maxSeen) + 1
    if (!Number.isSafeInteger(next)) throw new Error(`ledger ${prefix} ID space exhausted`)
    seq[kind] = next
    const tmp = `${sequenceFile}.${process.pid}.${randomUUID()}.tmp`
    let exists = false
    try {
      writeFileSync(tmp, JSON.stringify(seq, null, 2) + "\n", "utf8")
      exists = true
      const fd = openSync(tmp, "r+")
      try { fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(tmp, sequenceFile)
      exists = false
    } finally {
      if (exists) {
        try { unlinkSync(tmp) } catch { /* best-effort cleanup */ }
      }
    }
    return `${prefix}${next}`
  } finally {
    release()
  }
}

export function freshLedger(): Ledger {
  return { version: 1, updated_at: now(), tasks: [], agents: [], tabs: [], models: [], tombstones: {} }
}

// Каноническая форма задачи. Лишние ключи старых версий (blocker, question,
// next_action, reopen_reason) отбрасываются; blocker/question → why (миграция).
function sanitizeTask(raw: unknown): Task {
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof r.id !== "string" || r.id === "") {
    throw new Error("state.json: a task without id — refusing to guess ledger state")
  }
  if (!isTaskState(r.state)) {
    throw new Error(`state.json: task ${r.id} has invalid state '${String(r.state)}' — refusing to guess`)
  }
  const s = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null)
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null)
  const pn = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : null)
  const priority = pn(r.priority)
  const task: Task = {
    id: r.id,
    task: typeof r.task === "string" ? r.task : "",
    state: r.state,
    owner: s(r.owner),
    parent: s(r.parent) === r.id ? null : s(r.parent),
    why: s(r.why) ?? s(r.blocker) ?? s(r.question),
    verification: s(r.verification),
    session_ref: s(r.session_ref),
    agent_error: s(r.agent_error),
    created_at: typeof r.created_at === "string" ? r.created_at : now(),
    updated_at: typeof r.updated_at === "string" ? r.updated_at : now(),
    est_min: n(r.est_min),
    phase: s(r.phase),
    retry_at: typeof r.retry_at === "string" ? r.retry_at : null,
    retry_attempts: typeof r.retry_attempts === "number" ? r.retry_attempts : null,
  }
  // T43: только включаем priority когда он задан (не null) — backcompat: старые леджеры без поля грузятся как раньше
  if (priority !== null) task.priority = priority
  return task
}

export function loadLedger(file: string): Ledger {
  if (!existsSync(file)) {
    const empty = freshLedger()
    loadedStamp.set(empty as unknown as object, null)
    loadedModelBaseline.set(empty as unknown as object, [])
    return empty
  }
  let source = readFileSync(file, "utf8")
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (e) {
    // Main file is corrupt — try rolling backup
    const bak = file + ".bak"
    if (existsSync(bak)) {
      try {
        const bakContent = readFileSync(bak, "utf8")
        parsed = JSON.parse(bakContent)
        console.error(`[dev-console] LEDGER RECOVERED FROM BACKUP: state.json was corrupt, loaded from state.json.bak`)
      } catch {
        // Backup also corrupt — give up with clear message
        throw new Error(`state.json is not valid JSON and state.json.bak is also corrupt — refusing to start with empty ledger`)
      }
    } else {
      throw new Error(`state.json is not valid JSON (${String(e)}) and no backup exists — refusing to start with empty ledger`)
    }
  }
  const led = parsed as Partial<Ledger>
  if (!led || !Array.isArray(led.tasks) || !Array.isArray(led.agents)) {
    // Unexpected shape — try backup
    const bak = file + ".bak"
    if (existsSync(bak)) {
      try {
        const bakContent = readFileSync(bak, "utf8")
        const bakLed = JSON.parse(bakContent) as Partial<Ledger>
        if (bakLed && Array.isArray(bakLed.tasks) && Array.isArray(bakLed.agents)) {
          console.error(`[dev-console] LEDGER RECOVERED FROM BACKUP: state.json had unexpected shape, loaded from state.json.bak`)
          const recovered = loadLedgerFromParsed(bakLed, file)
          loadedStamp.set(recovered as unknown as object, contentStamp(source))
          loadedModelBaseline.set(recovered as unknown as object, cloneModelStats(recovered.models))
          return recovered
        }
      } catch {
        // Backup also invalid
      }
    }
    throw new Error("state.json has an unexpected shape and no valid backup — refusing to guess ledger state")
  }
  const loaded = loadLedgerFromParsed(led, file)
  loadedStamp.set(loaded as unknown as object, contentStamp(source))
  loadedModelBaseline.set(loaded as unknown as object, cloneModelStats(loaded.models))
  return loaded
}

function loadLedgerFromParsed(led: Partial<Ledger>, file: string): Ledger {
  const tombstones = sanitizeTombstones(led.tombstones)
  const tabs = (Array.isArray(led.tabs) ? led.tabs.map(sanitizeTab).filter((t): t is TabSession => t !== null) : [])
    .filter((tab) => !tombstones.tabs?.[tab.session_id])
  const agents = led.agents.map(sanitizeAgent).filter((agent) => !tombstones.agents?.[agent.id])
  // Эмодзи-идентичность (T71): поле появилось позже записи — первая загрузка с
  // фичей и есть та самая первая регистрация для до-T71 записей (см. комментарий
  // к backfillEmoji). Уже назначенные не трогаем: значение живёт в записи.
  backfillEmoji(tabs, INSTANCE_EMOJI)
  backfillEmoji(agents, DAEMON_EMOJI)
  // T62: foreign sessions - sanitize and filter by TTL
  // T104(1): свой реестр вычищает из ЧУЖИХ свои вкладки (утечка классификации)
  const now = Date.now()
  const FOREIGN_TTL_MS = 5 * 60_000
  const foreignSessions = Array.isArray(led.foreign_sessions)
    ? dropOwnFromForeign(
        led.foreign_sessions
          .filter((f) => {
            if (!f || typeof f.session_id !== "string" || typeof f.title !== "string" || typeof f.last_seen !== "number") return false
            return now - f.last_seen <= FOREIGN_TTL_MS && !tombstones.foreign_sessions?.[f.session_id]
          })
          .map((f) => ({ session_id: f.session_id, title: f.title, last_seen: f.last_seen })),
        tabs,
      )
    : []
  // T164: exact byte-stamp is attached to the returned ledger by loadLedger;
  // saveLedger compares it under the per-file lock before merging stale holders.
  const out = {
    version: typeof led.version === "number" ? led.version : 1,
    updated_at: typeof led.updated_at === "string" ? led.updated_at : now,
    tasks: led.tasks.map(sanitizeTask).filter((task) => !tombstones.tasks?.[task.id]),
    agents,
    // регистр вкладок восстановим заново (context-hook), поэтому отсутствие или
    // битый массив — не повод отказываться грузить ledger
    tabs,
    // T66: таблица моделей/кулдаун — отсутствие/мусор старых версий = пустая
    // таблица (политика начнёт учиться с чистого листа, деградации нет)
    models: normalizeModels(led.models),
    tombstones,
    // T62: foreign sessions from other projects
    foreign_sessions: foreignSessions,
    // T128: суточный накопитель переработки — durable, но чужие сутки не несём
    // (устаревший счётчик читается нулём и зануляется первым же settle)
    overruns: sanitizeOverruns(led.overruns),
  }
  return out
}

// T128: каноническая форма суточного накопителя. Мусор/чужой день → null
// (отсутствие поля), легаси-леджеры без накопителя грузятся как раньше.
function sanitizeOverruns(raw: unknown): OverrunLedger | undefined {
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof r.day !== "string" || r.day === "") return undefined
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0)
  const byHome: Record<string, number> = {}
  const src = (r.by_home ?? {}) as Record<string, unknown>
  if (src && typeof src === "object" && !Array.isArray(src)) {
    for (const [k, v] of Object.entries(src)) {
      const m = num(v)
      if (m > 0) byHome[k] = m
    }
  }
  return { day: r.day, total_min: num(r.total_min), by_home: byHome }
}

function sanitizeTombstones(raw: unknown): NonNullable<Ledger["tombstones"]> {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const sanitizeMap = (value: unknown): Record<string, string> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    const out: Record<string, string> = {}
    for (const [id, at] of Object.entries(value as Record<string, unknown>)) {
      if (id && typeof at === "string" && at !== "") out[id] = at
    }
    return out
  }
  return {
    tasks: sanitizeMap(source.tasks),
    agents: sanitizeMap(source.agents),
    tabs: sanitizeMap(source.tabs),
    foreign_sessions: sanitizeMap(source.foreign_sessions),
  }
}

function mergeById<T>(
  freshArr: readonly T[],
  callerArr: readonly T[],
  keyOf: (x: T) => string,
  recencyOf: (x: T) => string | number,
): T[] {
  const out = new Map<string, T>()
  for (const f of freshArr) out.set(keyOf(f), f)
  for (const c of callerArr) {
    const k = keyOf(c)
    const f = out.get(k)
    if (f === undefined) out.set(k, c)
    else {
      const cf = recencyOf(c)
      const cr = recencyOf(f)
      const cNew = typeof cf === "number" ? cf : Date.parse(String(cf)) || 0
      const fNew = typeof cr === "number" ? cr : Date.parse(String(cr)) || 0
      if (cNew > fNew) out.set(k, c) // строго новее — иначе держится свежая версия
    }
  }
  return Array.from(out.values()) // порядок: свежий файл + хвост держателя
}

// T165/P0-B: model metrics merge as per-writer deltas from the last loaded
// baseline; cooldown/reset markers arbitrate non-monotone state transitions.
function mergeModels(
  freshArr: readonly ModelStat[],
  callerArr: readonly ModelStat[],
  baselineArr?: readonly ModelStat[],
): ModelStat[] {
  const out = new Map<string, ModelStat>()
  const baseline = new Map((baselineArr ?? []).map((row) => [row.model, row]))
  for (const f of freshArr) out.set(f.model, { ...f, byClass: f.byClass ? { ...f.byClass } : undefined })
  for (const c of callerArr) {
    const f = out.get(c.model)
    if (!f) {
      out.set(c.model, { ...c, byClass: c.byClass ? { ...c.byClass } : undefined })
      continue
    }
    const b = baseline.get(c.model)
    const later = (a: string | null | undefined, d: string | null | undefined): string | null => {
      if (!a) return d ?? null
      if (!d) return a
      return Date.parse(a) >= Date.parse(d) ? a : d
    }
    // A known empty baseline means both writers may have created this row
    // independently. Treat missing baseline fields as zero and add both deltas.
    // Without a baseline (legacy/manual callers), retain conservative max merge.
    const hasBaseline = baselineArr !== undefined
    const count = (fv: number, cv: number, bv: number | undefined): number =>
      hasBaseline ? fv + Math.max(0, cv - (bv ?? 0)) : Math.max(fv, cv)

    // T165/P0-B: model outcomes are increments, not monotone snapshots. Merge
    // each writer's delta from its load baseline into the current persisted
    // value; replaying the same snapshot therefore cannot double-count it.
    const merged: ModelStat = {
      model: c.model,
      ok: count(f.ok, c.ok, b?.ok),
      fail: count(f.fail, c.fail, b?.fail),
      cooldown_until: later(f.cooldown_until, c.cooldown_until),
      cooldown_updated_at: later(f.cooldown_updated_at, c.cooldown_updated_at),
      upstream_fails: count(f.upstream_fails ?? 0, c.upstream_fails ?? 0, b?.upstream_fails ?? (hasBaseline ? 0 : undefined)),
      upstream_streak: Math.max(f.upstream_streak ?? 0, c.upstream_streak ?? 0),
      upstream_streak_reset_at: later(f.upstream_streak_reset_at, c.upstream_streak_reset_at),
      upstream_streak_updated_at: later(f.upstream_streak_updated_at, c.upstream_streak_updated_at),
    }

    // A reset is a new epoch. Discard stale pre-reset increments, but retain
    // increments whose event timestamp is demonstrably after the winning reset.
    if (b) {
      const baseReset = b.upstream_streak_reset_at ?? null
      const callerReset = c.upstream_streak_reset_at ?? null
      const freshReset = f.upstream_streak_reset_at ?? null
      const callerResetChanged = callerReset !== baseReset && callerReset !== null
      const freshResetChanged = freshReset !== baseReset && freshReset !== null
      const resetWinner = callerResetChanged && (!freshResetChanged || Date.parse(callerReset) >= Date.parse(freshReset))
        ? { resetAt: callerReset, row: c, other: f }
        : freshResetChanged
          ? { resetAt: freshReset, row: f, other: c }
          : null
      if (resetWinner) {
        const otherReset = resetWinner.other.upstream_streak_reset_at ?? null
        const otherUpdated = resetWinner.other.upstream_streak_updated_at ?? null
        const baseStreak = b.upstream_streak ?? 0
        const otherDelta = otherReset === resetWinner.resetAt || !otherUpdated || Date.parse(otherUpdated) <= Date.parse(resetWinner.resetAt)
          ? 0
          : Math.max(0, (resetWinner.other.upstream_streak ?? 0) - baseStreak)
        merged.upstream_streak = (resetWinner.row.upstream_streak ?? 0) + otherDelta
        merged.upstream_streak_reset_at = resetWinner.resetAt
      } else {
        merged.upstream_streak = count(f.upstream_streak ?? 0, c.upstream_streak ?? 0, b.upstream_streak ?? 0)
      }

      // An explicit cooldown clear must beat an old still-present expiry.
      // Legacy rows without timestamps retain the previous later-expiry rule.
      const baseCooldownUpdate = b.cooldown_updated_at ?? null
      const callerCooldownUpdate = c.cooldown_updated_at ?? null
      const freshCooldownUpdate = f.cooldown_updated_at ?? null
      const callerCooldownChanged = callerCooldownUpdate !== baseCooldownUpdate && callerCooldownUpdate !== null
      const freshCooldownChanged = freshCooldownUpdate !== baseCooldownUpdate && freshCooldownUpdate !== null
      if (callerCooldownChanged && (!freshCooldownChanged || Date.parse(callerCooldownUpdate) >= Date.parse(freshCooldownUpdate))) {
        merged.cooldown_until = c.cooldown_until
        merged.cooldown_updated_at = callerCooldownUpdate
      } else if (freshCooldownChanged) {
        merged.cooldown_until = f.cooldown_until
        merged.cooldown_updated_at = freshCooldownUpdate
      }
    }

    if (f.byClass || c.byClass) {
      const by: NonNullable<ModelStat["byClass"]> = {} as NonNullable<ModelStat["byClass"]>
      for (const cls of new Set([...Object.keys(f.byClass ?? {}), ...Object.keys(c.byClass ?? {})])) {
        const fc = f.byClass?.[cls as TaskClass]
        const cc = c.byClass?.[cls as TaskClass]
        const bc = b?.byClass?.[cls as TaskClass]
        if (!fc) by[cls as TaskClass] = { ...cc! }
        else if (!cc) by[cls as TaskClass] = { ...fc }
        else {
          by[cls as TaskClass] = {
            ok: count(fc.ok, cc.ok, bc?.ok),
            fail: count(fc.fail, cc.fail, bc?.fail),
            editsPerSecSum: count(fc.editsPerSecSum, cc.editsPerSecSum, bc?.editsPerSecSum),
            runs: count(fc.runs, cc.runs, bc?.runs),
          }
        }
      }
      merged.byClass = by
    }
    out.set(c.model, merged)
  }
  return Array.from(out.values())
}

function mergeTombstoneMap(
  fresh: Record<string, string> | undefined,
  caller: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = { ...(fresh ?? {}) }
  for (const [id, at] of Object.entries(caller ?? {})) {
    if (!out[id] || Date.parse(at) >= Date.parse(out[id])) out[id] = at
  }
  return out
}

function mergeTombstones(
  fresh: Ledger["tombstones"],
  caller: Ledger["tombstones"],
): NonNullable<Ledger["tombstones"]> {
  return {
    tasks: mergeTombstoneMap(fresh?.tasks, caller?.tasks),
    agents: mergeTombstoneMap(fresh?.agents, caller?.agents),
    tabs: mergeTombstoneMap(fresh?.tabs, caller?.tabs),
    foreign_sessions: mergeTombstoneMap(fresh?.foreign_sessions, caller?.foreign_sessions),
  }
}

// T164: слияние устаревшего снимка держателя поверх свежего файла —
// по сущностям (задачи/агенты/вкладки/чужие) last-write-wins ПО updated_at,
// поэтому затереть более новую запись невозможно (потеря T162 15.11).
export function mergeLedger(fresh: Ledger, caller: Ledger, baselineModels?: readonly ModelStat[]): Ledger {
  const tombstones = mergeTombstones(fresh.tombstones, caller.tombstones)
  return {
    version: caller.version,
    updated_at: caller.updated_at,
    tasks: mergeById(fresh.tasks, caller.tasks, (t) => t.id, (t) => t.updated_at)
      .filter((row) => !tombstones.tasks?.[row.id]),
    agents: mergeById(fresh.agents, caller.agents, (a) => a.id, (a) => a.updated_at)
      .filter((row) => !tombstones.agents?.[row.id]),
    tabs: mergeById(fresh.tabs, caller.tabs, (t) => t.session_id, (t) => t.last_seen)
      .filter((row) => !tombstones.tabs?.[row.session_id]),
    models: mergeModels(fresh.models ?? [], caller.models ?? [], baselineModels),
    foreign_sessions: mergeById(
      fresh.foreign_sessions ?? [],
      caller.foreign_sessions ?? [],
      (f) => f.session_id,
      (f) => f.last_seen,
    ).filter((row) => !tombstones.foreign_sessions?.[row.session_id]),
    tombstones,
    overruns: (() => {
      const fo = fresh.overruns
      const co = caller.overruns
      if (!fo) return co
      if (!co) return fo
      if (fo.day !== co.day) return co.day > fo.day ? co : fo
      return {
        day: co.day,
        total_min: Math.max(fo.total_min, co.total_min),
        by_home: (() => {
          const m: Record<string, number> = { ...fo.by_home }
          for (const [k, v] of Object.entries(co.by_home)) m[k] = Math.max(m[k] ?? 0, v)
          return m
        })(),
      }
    })(),
  }
}

function isUsableLedgerSnapshot(source: string): boolean {
  try {
    const parsed = JSON.parse(source) as Partial<Ledger> | null
    if (!parsed || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.agents)) return false
    // These are the strict fields that make loadLedger reject the primary file.
    parsed.tasks.forEach(sanitizeTask)
    parsed.agents.forEach(sanitizeAgent)
    return true
  } catch {
    return false
  }
}

export function saveLedger(file: string, ledger: Ledger): void {
  mkdirSync(dirname(file), { recursive: true })
  const releaseLock = acquireLedgerLock(file)
  const target = ledger
  const targetRef = target as unknown as object
  const baseline = loadedStamp.get(targetRef)
  const modelBaseline = loadedModelBaseline.get(targetRef)
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  let tmpExists = false

  try {
    // T164: compare the exact bytes observed on load, not updated_at. This also
    // detects a file created after loadLedger returned an empty fresh ledger.
    const currentSource = existsSync(file) ? readFileSync(file, "utf8") : null
    const currentStamp = currentSource === null ? null : contentStamp(currentSource)
    if (currentStamp !== baseline) {
      if (currentSource !== null) {
        // Another writer changed the file: merge under the file lock, then copy
        // the merged root back into the caller's object so its view stays current.
        Object.assign(target, mergeLedger(loadLedger(file), target, modelBaseline))
      } else if (baseline !== null && baseline !== undefined) {
        // A previously existing ledger disappeared. Do not silently resurrect
        // an old snapshot over an intentional reset or external deletion.
        throw new Error(`ledger disappeared after load; refusing stale overwrite: ${file}`)
      }
    }

    target.updated_at = now()
    const serialized = JSON.stringify(target, null, 2) + "\n"
    // Unique temp names allow independent processes to stage writes safely.
    writeFileSync(tmp, serialized, { encoding: "utf8" })
    tmpExists = true
    // fsync the temp file before the atomic rename. Windows requires r+ here.
    const fd = openSync(tmp, "r+")
    try { fsyncSync(fd) } finally { closeSync(fd) }

    // Rolling backup: preserve the last main file before replacing it.
    if (currentSource !== null && isUsableLedgerSnapshot(currentSource)) {
      try { copyFileSync(file, file + ".bak") } catch { /* backup failure is non-fatal */ }
    }
    renameSync(tmp, file)
    tmpExists = false
    loadedStamp.set(targetRef, contentStamp(serialized))
    loadedModelBaseline.set(targetRef, cloneModelStats(target.models))
  } finally {
    if (tmpExists) {
      try { unlinkSync(tmp) } catch { /* best-effort temp cleanup */ }
    }
    releaseLock()
  }
}

// ---------------------------------------------------------------- ops -------

function nextTaskId(tasks: Task[]): string {
  let max = 0
  for (const t of tasks) {
    const m = /^T(\d+)$/.exec(t.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `T${max + 1}`
}

function findTask(ledger: Ledger, id: unknown): Task | OpOutcome {
  if (!nonEmpty(id)) return fail("op requires a task 'id' (e.g. T1)")
  const t = ledger.tasks.find((x) => x.id === id)
  if (!t) return fail(`no task with id '${String(id)}'`)
  return t
}

function opCreate(ledger: Ledger, input: OpInput, idFile?: string): OpOutcome {
  if (!nonEmpty(input.task)) return fail("create requires a non-empty 'task' description")
  if (input.parent != null) {
    const found = findTask(ledger, input.parent)
    if ("ok" in found && found.ok === false) return fail(`create: parent — ${found.error}`)
  }
  const ts = now()
  
  // T38: Phase estimation — explicit est_min wins, otherwise auto from history
  // Chain by precision: (a) siblings (parent+phase, ≤5), (b) cross-parent phase-tag (all parents, DONE, ≤5 latest, clamp 5-120), (c) none → null
  let estMin: number | null = null
  let phaseTag: string | null = null
  if (typeof input.est_min === "number" && input.est_min > 0) {
    estMin = Math.floor(input.est_min)
  } else if (input.parent) {
    const phase = typeof input.phase === "string" && input.phase.trim() !== "" ? input.phase.trim() : null
    phaseTag = phase
    if (phase) {
      // (a) Siblings: same parent, same phase, DONE
      const siblings = ledger.tasks.filter(t => t.parent === input.parent && t.phase === phase && t.state === "DONE")
      if (siblings.length > 0) {
        const recent = siblings.slice(-5)
        const durations = recent.map(t => {
          const began = Date.parse(t.created_at)
          const ended = Date.parse(t.updated_at)
          return Number.isFinite(began) && Number.isFinite(ended) && ended > began ? (ended - began) / 60000 : null
        }).filter((d): d is number => d !== null)
        if (durations.length > 0) {
          const mean = durations.reduce((s, x) => s + x, 0) / durations.length
          estMin = Math.min(120, Math.max(5, Math.round(mean)))
        }
      } else {
        // (b) Cross-parent fallback: all parents, same phase, DONE, ≤5 latest
        const crossParent = ledger.tasks.filter(t => t.parent !== input.parent && t.phase === phase && t.state === "DONE")
        if (crossParent.length > 0) {
          const recent = crossParent.slice(-5)
          const durations = recent.map(t => {
            const began = Date.parse(t.created_at)
            const ended = Date.parse(t.updated_at)
            return Number.isFinite(began) && Number.isFinite(ended) && ended > began ? (ended - began) / 60000 : null
          }).filter((d): d is number => d !== null)
          if (durations.length > 0) {
            const mean = durations.reduce((s, x) => s + x, 0) / durations.length
            estMin = Math.min(120, Math.max(5, Math.round(mean)))
          }
        }
      }
      // (c) No history → estMin stays null
    }
  }
  
  const task: Task = {
    id: idFile ? reserveLedgerId(idFile, "task", ledger.tasks) : nextTaskId(ledger.tasks),
    task: input.task.trim(),
    state: "WAIT",
    owner: input.owner ?? null,
    parent: input.parent ?? null,
    why: null,
    verification: null,
    // Атрибуция (T34): create помечает задачу сессией, вызвавшей операцию —
    // wake/ETA уйдут вкладке-владельцу, а не «последней инжектированной».
    session_ref: typeof input.session_ref === "string" && input.session_ref.trim() !== "" ? input.session_ref.trim() : null,
    agent_error: null, // новая задача — смертей ещё не было
    created_at: ts,
    updated_at: ts,
    est_min: estMin,
    phase: phaseTag,
  }
  ledger.tasks.push(task)
  
  // T38: Return phase estimate info in response
  const estInfo = estMin !== null
    ? phaseTag
      ? `est ${estMin}м (по истории фазы "${phaseTag}")`
      : `est ${estMin}м (явно)`
    : "est авто (нет истории)"
  
  // Attach estimate info to task for response
  const taskWithEst = { ...task, _estInfo: estInfo }
  return { ok: true, ledger, task: taskWithEst as Task & { _estInfo: string } }
}

function opUpdate(ledger: Ledger, input: OpInput): OpOutcome {
  const found = findTask(ledger, input.id)
  if ("ok" in found && found.ok === false) return found
  const t = found as Task

  if (input.task !== undefined) {
    if (!nonEmpty(input.task)) return fail("update: 'task' must be a non-empty string")
    t.task = input.task.trim()
  }
  if (input.owner !== undefined) {
    if (input.owner === null) t.owner = null
    else if (nonEmpty(input.owner)) t.owner = input.owner.trim()
    else return fail("update: 'owner' must be a non-empty string or null (null clears)")
  }
  // T124-фрагмент №2 (29.10): продление плана было ФИКТИВНЫМ — update возвращал
  // ok, но est_min молча выбрасывался (в state.json оставался null, notice
  // стрелял по истории агента). Пишем явно: число >0 → floor, null → очистка.
  if (input.est_min !== undefined) {
    if (input.est_min === null) t.est_min = null
    else if (typeof input.est_min === "number" && Number.isFinite(input.est_min) && input.est_min > 0) {
      t.est_min = Math.floor(input.est_min)
    } else return fail("update: 'est_min' must be a positive number or null (clears)")
  }
  t.updated_at = now()
  return { ok: true, ledger, task: t }
}

function opSetState(ledger: Ledger, input: OpInput): OpOutcome {
  const found = findTask(ledger, input.id)
  if ("ok" in found && found.ok === false) return found
  const t = found as Task

  if (!isTaskState(input.state)) return fail(`set_state: invalid state '${String(input.state)}'`)
  const target = input.state
  if (target === t.state) return fail(`no-op: task is already ${target}`)
  if (!TRANSITIONS[t.state].includes(target)) {
    return fail(`illegal transition: ${t.state} → ${target}`)
  }

  // Per-state admission requirements (the DONE barrier).
  if ((target === "BLOCKED" || target === "GATE") && !nonEmpty(input.why)) {
    return fail(
      target === "BLOCKED"
        ? "BLOCKED requires 'why': what blocks it + what would unblock it"
        : "GATE requires 'why': the concrete Founder decision",
    )
  }
  if (target === "DONE" && !nonEmpty(input.verification)) {
    return fail("DONE requires 'verification': what was verified and how")
  }

  // Owner rides set_state too: «DOING + owner» must work in ONE call — the
  // dispatcher gate reads outcome.task.owner (N00sphere report 07.10.2026:
  // set_state silently dropped owner → the spawn never happened).
  if (input.owner !== undefined) {
    if (input.owner === null) t.owner = null
    else if (nonEmpty(input.owner)) t.owner = input.owner.trim()
    else return fail("set_state: 'owner' must be a non-empty string or null (null clears)")
  }

  const from = t.state
  t.state = target

  // Entering-state fields + clearing fields of the previous state.
  if (target === "BLOCKED" || target === "GATE") {
    t.why = input.why!.trim()
    if (target === "BLOCKED") {
      // T136: бэк-офф при вхождении в БЛОКИРОВКУ: 5→10→20… мин, потолок 60.
      const prev = Number(t.retry_attempts ?? 0)
      t.retry_attempts = prev + 1
      const delayMin = Math.min(5 * (2 ** prev), 60)
      t.retry_at = new Date(Date.now() + delayMin * 60 * 1000).toISOString()
    }
  } else if (target === "DONE") {
    t.verification = input.verification!.trim()
    t.why = null
    t.retry_at = null
    t.retry_attempts = null
  } else {
    // DOING / WAIT: не заблокировано и не ждёт решения — сбрасываем retry-таймер
    t.why = null
    t.retry_at = null
    if (target === "DOING") {
      t.retry_attempts = null
    }
  }
  // T46: пометка agent_error снимается, когда вопрос решён: новая попытка
  // (вход в DOING) либо закрытие задачи с верификацией (DONE) — ретрай не
  // наследует чужую смерть.
  if (target === "DOING" || target === "DONE") t.agent_error = null
  
  // T38: Record phase completion for history (actual vs estimated)
  // When a child phase (with parent) goes DONE, the fact is already in ledger
  // via created_at/updated_at. No extra table needed - we use existing records.
  // Parent plan percentage will be computed in projection from children's est_min.
  
  t.updated_at = now()
  void from
  return { ok: true, ledger, task: t }
}

export function applyOp(
  ledger: Ledger,
  input: OpInput,
  options: { idFile?: string } = {},
): OpOutcome {
  switch (input.op) {
    case "create":
      return opCreate(ledger, input, options.idFile)
    case "update":
      return opUpdate(ledger, input)
    case "set_state":
      return opSetState(ledger, input)
    default:
      return fail(`unknown op '${String(input.op)}'`)
  }
}

// ----------------------------------------------------------- projection -----
// Every UI section exists iff its source array is non-empty.
// The runtime computes the arrays; the model only renders `ui`.

// Бренд (заказ Основателя 07.10, T86): шапка панели и <title> вкладки несут
// корпоративное имя — локация/название репо идут вторым планом.
const BRAND = "LAVK DEV CONSOLE · КОРПОРАЦИЯ ЯСНОСТЬ"
const HEADER = `━━━━━━━━ 🛰 ${BRAND} ━━━━━━━━`

const AGENT_STATE_RU: Record<string, string> = {
  created: "создан",
  running: "работает",
  waiting: "ждёт",
  completed: "завершил",
  failed: "сбой",
}

// ui = glance, not dump (Founder order 04.10.2026): task/why texts are flattened
// and clipped — the full text lives only in the ledger, never in the projection.
const MAX_TASK_CHARS = 140
const MAX_WHY_CHARS = 200
// T46: пометка agent_error на строке задачи (глаз на «висит с мёртвым агентом»).
const MAX_AGENT_ERROR_CHARS = 120
const AGENT_ERROR_GLYPH = "⚠"

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1).replace(/\s+\S*$/, "")}…`
}

// Прогресс = декомпозиция (Founder 04.10.2026): дети задачи в DONE / всего.
// Нет декомпозиции — нет бара: выдуманный процент врёт о состоянии.
interface Progress {
  done: number
  total: number
}

function progressOf(t: Task, all: Task[]): Progress | null {
  const kids = all.filter((c) => c.parent === t.id)
  return kids.length > 0 ? { done: kids.filter((c) => c.state === "DONE").length, total: kids.length } : null
}

// T38: Planned percentage for parent task — based on children's est_min and elapsed time.
// plan% = (now - parent.began_at) / sum(children.est_min) * 100, clamped 0..100.
// Computed in projection, not written to ledger (client ticks).
export function planPercent(t: Task, all: Task[]): number | null {
  const kids = all.filter((c) => c.parent === t.id && typeof c.est_min === "number" && c.est_min !== null && c.est_min > 0)
  if (kids.length === 0) return null
  const totalEst = kids.reduce((sum, c) => sum + (c.est_min ?? 0), 0)
  if (totalEst <= 0) return null
  const began = Date.parse(t.created_at)
  if (!Number.isFinite(began)) return null
  const elapsedMin = (Date.now() - began) / 60000
  const pct = Math.floor((elapsedMin / totalEst) * 100)
  return Math.max(0, Math.min(100, pct))
}

function bar(p: Progress): string {
  const filled = Math.floor((p.done / p.total) * 5) // floor: никогда не преувеличивать
  return `${"▰".repeat(filled)}${"▱".repeat(5 - filled)} ${p.done}/${p.total}`
}

// Сколько таска показывать в строке агента — «вообще коротко» (Founder order).
const AGENT_WHAT_CHARS = 48

// Обратный отсчёт (Founder: «сколько осталось до финиша»); просроченный план —
// «+mm:ss». T85 (заказ Основателя 07.10): формат mm:ss, дальше h:mm:ss — секунда
// видна сразу и в статическом тексте, и в панели (тикер 1с её только ведёт).
function remaining(a: Agent): string {
  return `⏱${fmtRemain(Date.parse(a.began_at) + a.eta_min * 60000 - Date.now())}`
}

// Живая запись агента: только у неё есть обратный отсчёт (settle план обрывает).
function isLive(a: Agent): boolean {
  return a.state === "running" || a.state === "waiting"
}

// T46: пометка смерти исполнителя на строке задачи — снимается новой попыткой
// или закрытием, поэтому не врёт вечно.
function agentErrorIn(t: Task): string {
  return t.agent_error ? ` · ${AGENT_ERROR_GLYPH} agent_error: ${clip(t.agent_error, MAX_AGENT_ERROR_CHARS)}` : ""
}

function describeTask(t: Task, all: Task[], agents: Agent[], tabs: TabSession[]): string {
  const p = progressOf(t, all)
  // T38: Planned percentage for parent tasks with phase estimates
  const planPct = t.parent ? null : planPercent(t, all) // only for parents
  // T89 (табуляция): корень секции на отступе +2, ребёнок глубже (+4) —
  // иерархия декомпозиции читается отступом, не только знаком ↳.
  const ind = t.parent ? `${TAB_INDENT}  ` : TAB_INDENT
  const mark = t.parent ? "↳" : "●"
  let planStr = ""
  let planMarker = ""
  if (planPct !== null) {
    // Parent task with children that have est_min
    const kids = all.filter((c) => c.parent === t.id && typeof c.est_min === "number" && c.est_min !== null && c.est_min > 0)
    const totalEst = kids.reduce((sum, c) => sum + (c.est_min ?? 0), 0)
    const elapsedMin = Math.floor((Date.now() - Date.parse(t.created_at)) / 60000)
    const remainingMin = Math.max(0, totalEst - elapsedMin)
    const kidsDone = kids.filter((c) => c.state === "DONE").length
    // Compact label: "2/5 · ⏱18м" style — fact ratio (children done/total) + plan time info
    planStr = ` ${kidsDone}/${kids.length} · ⏱${remainingMin}м`
    // Plan marker: visual position indicator (▏ at planPct position across 5 bar segments)
    // 0% → 1 marker (start), 20% → 1, 40% → 2, 60% → 3, 80% → 4, 100% → 5
    const markerPos = Math.max(1, Math.min(5, Math.ceil(planPct / 20)))
    planMarker = " " + "▏".repeat(markerPos)
  }
  return `${ind}${mark} [${t.id}]${p ? ` ${bar(p)}` : ""}${planStr}${planMarker} ${clip(t.task, MAX_TASK_CHARS)}${t.owner ? ` → ${t.owner}` : ""}${ownedIn(t, tabs)}${occupancy(t, agents)}${agentErrorIn(t)}`
}

// T99: Compact block format for В РАБОТЕ / ЗАДАЧИ sections (style from ИНСТАНСЫ).
// Each task = block: header line (marker + id + short task + owner) + state axis line (state · progress · children/ETA · occupancy).
// Header indent = TAB_INDENT (2), axis indent = AXIS_INDENT (4). Empty line between blocks.
const TASK_STATE_GLYPH: Record<TaskState, string> = {
  DOING: "🔄",
  WAIT: "⏳",
  BLOCKED: "⛔",
  GATE: "🔔",
  DONE: "✅",
}

const TASK_HEADER_CHARS = 100 // max chars for header line (id + short task + owner)
const TASK_AXIS_CHARS = 140   // max chars for axis line

function describeTaskBlock(t: Task, all: Task[], agents: Agent[], tabs: TabSession[]): string[] {
  const p = progressOf(t, all)
  const mark = t.parent ? "↳" : "●"
  const stateGlyph = TASK_STATE_GLYPH[t.state]
  const kids = all.filter((c) => c.parent === t.id)
  const childMark = kids.length > 0 ? ` ↳${kids.length}` : ""
  const ownerMark = t.owner ? ` · ${t.owner}` : ""
  const ownedMark = ownedIn(t, tabs) // " · у 🤖 TabName" from session_ref
  const estMark = typeof t.est_min === "number" && t.est_min !== null && t.est_min > 0 ? ` ⏱${t.est_min}м` : ""
  // Occupancy: compact agent id + state + remaining (from occupancy function logic)
  const busy = agents.filter((a) => a.task_id === t.id)
  let occMark = ""
  if (busy.length > 0) {
    const marks = busy.map(
      (a) => `${a.id} ${AGENT_STATE_RU[a.state] ?? a.state}${isLive(a) ? ` ${remaining(a)}` : ""}`,
    )
    occMark = ` 🔒${marks.join(" · ")}`
  }
  const agentErrMark = t.agent_error ? ` ⚠${clip(t.agent_error, 60)}` : ""

  // Header: marker [id] short_task · owner · tab_owner
  // T89: корень на отступе TAB_INDENT (2), ребёнок глубже (+2 = 4)
  const headerIndent = t.parent ? `${TAB_INDENT}  ` : TAB_INDENT
  const headerTask = clip(t.task, TASK_HEADER_CHARS - 15) // reserve space for [id] and owner
  const header = `${headerIndent}${mark} [${t.id}] ${headerTask}${ownerMark}${ownedMark}`

  // Axis: state_glyph · progress_bar · children_done/total · est/remaining · plan_marker · occupancy · agent_error
  const axisParts: string[] = [stateGlyph]
  if (p) axisParts.push(bar(p))
  if (childMark) axisParts.push(childMark.trimStart()) // "↳N" without leading space
  if (estMark) axisParts.push(estMark.trimStart())
  // Plan marker for parent tasks with children that have est_min (like old describeTask)
  if (!t.parent) {
    const estKids = all.filter((c) => c.parent === t.id && typeof c.est_min === "number" && c.est_min !== null && c.est_min > 0)
    if (estKids.length > 0) {
      const totalEst = estKids.reduce((sum, c) => sum + (c.est_min ?? 0), 0)
      const elapsedMin = Math.floor((Date.now() - Date.parse(t.created_at)) / 60000)
      const remainingMin = Math.max(0, totalEst - elapsedMin)
      const kidsDone = estKids.filter((c) => c.state === "DONE").length
      const planStr = ` ${kidsDone}/${estKids.length} · ⏱${remainingMin}м`
      const planPct = planPercent(t, all)
      if (planPct !== null) {
        const markerPos = Math.max(1, Math.min(5, Math.ceil(planPct / 20)))
        const planMarker = " " + "▏".repeat(markerPos)
        axisParts.push(planStr.trimStart())
        axisParts.push(planMarker.trimStart())
      }
    }
  }
  if (occMark) axisParts.push(occMark.trimStart())
  if (agentErrMark) axisParts.push(agentErrMark.trimStart())
  const axis = `${AXIS_INDENT}${axisParts.join(" · ")}`

  return [header, axis]
}

// ------------------------------------------------------- worksheet (T50) ---
// Компактная проекция «рабочий лист»: строка = id · state · owner · план/факт ·
// занятость · блокировка · дети. Максимальная информативность в минимуме символов:
// по строке агент видит, что делать дальше (T49, заказ «максимально информативный»).
//   T49 · 🔄 · dev 1/4 ⏱30м !4 🔒A99⏱14:32 «нужен гейт Основателя» ↳ T50✅ T51⏳
//     T51 · ⏳↩T49 — лист плоский: ↩T… у дитяти называет родителя (отступ не
//                    гарантирует соседство строк); DONE-дети — только в ↳ + N/M.
const STATE_GLYPH: Record<TaskState, string> = {
  DOING: "🔄",
  WAIT: "⏳",
  BLOCKED: "⛔",
  GATE: "🔔",
  DONE: "✅",
}
// Кап длинного списка детей: строка не должна разъезжаться на экран, хвост — числом.
const WORKSHEET_KIDS_MAX = 12
const MAX_WHY_SHORT_CHARS = 80
const MAX_AGENT_ERROR_SHORT_CHARS = 40

export function projectWorksheet(ledger: Ledger): string {
  const all = ledger.tasks
  const tasks = all.filter((t) => t.state !== "DONE")
  if (tasks.length === 0) return "— worksheet empty —"

  const lines: string[] = []
  // Заказ 27.10 (QC-сравнение GLM vs nemotron): те же byClass.qc, что кормят
  // argmax/re-examine, — но видимые: отказы (✓/✗) и скорость (эдит/сек) по
  // модели, с числом прогонов. qc-прогонов нет — линии нет (не врём «0»).
  const qcRows = modelStats(ledger).flatMap((s) => {
    const c = s.byClass?.qc
    return c && c.runs > 0 ? [{ key: shortModelKey(s.model), c }] : []
  })
  if (qcRows.length > 0) {
    lines.push(
      `📊 qc-модели: ${qcRows
        .map((x) => `${x.key} ${x.c.ok}✓/${x.c.fail}✗ ${(x.c.editsPerSecSum / x.c.runs).toFixed(2)}э/с(${x.c.runs})`)
        .join(" · ")}`,
    )
    lines.push("")
  }
  for (const t of tasks) {
    const kids = all.filter((c) => c.parent === t.id)
    const shownKids = kids.slice(0, WORKSHEET_KIDS_MAX)
    // Ребёнок несёт глиф СВОЕГО состояния — видно, что из детей уже закрыто,
    // не сверяясь с отдельной строкой (у DONE строки нет).
    const childIds = shownKids.map((c) => `${c.id}${STATE_GLYPH[c.state]}`).join(" ")
    const kidsRest = kids.length - shownKids.length
    const childMark = kids.length > 0 ? ` ↳ ${childIds}${kidsRest > 0 ? ` +${kidsRest}` : ""}` : ""
    const ownerMark = t.owner ? ` · ${t.owner}` : ""
    const stateGlyph = STATE_GLYPH[t.state]
    const parentMark = t.parent ? `↩${t.parent}` : ""
    const ind = t.parent ? "  " : ""
    // Progress hint for parents with decomposition
    const p = progressOf(t, all)
    const progMark = p ? ` ${p.done}/${p.total}` : ""
    // Phase/est compact hint for tasks with explicit estimate
    const estMark = t.est_min ? ` ⏱${t.est_min}м` : ""
    // T43: приоритет (меньше = выше) — агент видит порядок из листа, не из панели
    const prioMark = t.priority !== null && t.priority !== undefined ? ` !${t.priority}` : ""
    // Agent occupancy: id исполнителя + его обратный отсчёт, пока он жив
    const busy = ledger.agents.filter((a) => a.task_id === t.id)
    const occMark =
      busy.length > 0 ? ` 🔒${busy.map((a) => `${a.id}${isLive(a) ? remaining(a) : ""}`).join(",")}` : ""
    // BLOCKED/GATE обязаны нести why («что блокирует / какое решение ждём») —
    // без этого строка лишь констатирует состояние, но не двигает работу.
    const whyMark =
      (t.state === "BLOCKED" || t.state === "GATE") && t.why ? ` «${clip(t.why, MAX_WHY_SHORT_CHARS)}»` : ""
    // Смерть исполнителя не должна теряться в листе (снимается новой попыткой)
    const errMark = t.agent_error ? ` ⚠${clip(t.agent_error, MAX_AGENT_ERROR_SHORT_CHARS)}` : ""
    lines.push(
      `${ind}${t.id} · ${stateGlyph}${parentMark}${ownerMark}${progMark}${estMark}${prioMark}${occMark}${whyMark}${errMark}${childMark}`,
    )
  }
  // T136: следующее к диспатчу — старейшая WAIT без неснятой ошибки исполнителя
  // и без висящего retry-таймера (конфликт региона проверяется на диспатче).
  const nowMs = Date.now()
  const next = [...all]
    .filter((t) => t.state === "WAIT" && !t.agent_error)
    .filter((t) => !t.retry_at || nowMs >= Date.parse(t.retry_at))
    .sort((a, b) => (Date.parse(a.updated_at) || 0) - (Date.parse(b.updated_at) || 0))[0]
  if (next) lines.push(`⏭️ следующее к диспатчу: ${next.id} · ${(next.task ?? "").slice(0, 60)}`)
  return lines.join("\n")
}

// ------------------------------------ cheap inject (T51) ---------------------
// T51 (экономия токенов на инжекте): хук контекста дёргается на КАЖДЫЙ вызов
// модели топ-вкладки; полная проекция (ui) в каждом ходе сжигала токены на
// пересчёт одних и тех же секций. Дешёвый вариант = только счётчики и открытые
// id: один компактный ряд (~100–200 символов) вместо полной панели. Полный ui
// уходит редкими освежениями (FULL_UI_GAP_MS в index.ts); лист задач для
// порядка/деталей — dev_console get_state (worksheet). Списки id ограничены
// CAP: панель не должна разъезжаться при лавине задач.
const COUNTERS_ID_CAP = 12

export function projectCounters(ledger: Ledger): string {
  const all = ledger.tasks
  const ids = (s: TaskState): string => {
    const xs = all.filter((t) => t.state === s).map((t) => t.id)
    if (xs.length === 0) return ""
    const shown = xs.slice(0, COUNTERS_ID_CAP)
    return ` ${shown.join(" ")}${xs.length > shown.length ? ` +${xs.length - shown.length}` : ""}`
  }
  const open = all.filter((t) => t.state !== "DONE").length
  const live = ledger.agents
    .filter(isLive)
    .map((a) => `${a.id}${a.task_id ? `[${a.task_id}]` : ""}`)
  const parts = [
    `DOING${ids("DOING")}`,
    `WAIT${ids("WAIT")}`,
    `BLOCKED${ids("BLOCKED")}`,
    `GATE${ids("GATE")}`,
    `open ${open}`,
  ]
  if (live.length > 0) parts.push(`live: ${live.join(" ")}`)
  return parts.join(" · ")
}

// Занятость (T63, Основатель: «В ⚡ ЗАДАЧИ должно быть видно если задачей занят
// агент или субагент»): на строке задачи — id занятого агента + его состояние
// (работает/завершил); привязанных агентов нет → пусто, задача свободна.
// T74(2, Основатель 07.10): к занятому живому агенту — ещё и остаток его плана
// (тот же remaining), чтобы было видно, когда ждать; у завершённого отсчёта нет.
const OCCUPANCY_GLYPH = "🔒"

function occupancy(t: Task, agents: Agent[]): string {
  const busy = agents.filter((a) => a.task_id === t.id)
  if (busy.length === 0) return ""
  const marks = busy.map(
    (a) => `${a.id} ${AGENT_STATE_RU[a.state] ?? a.state}${isLive(a) ? ` ${remaining(a)}` : ""}`,
  )
  return ` ${OCCUPANCY_GLYPH}${marks.join(" · ")}`
}

// 🤖 ИНСТАНСЫ (T35 → T69 → T83): строка = инстанс (top-сессия проекта), теперь
// блок из 2-3 строк-осей — заказ Основателя 07.10: «надо сделать инстансы в
// несколько строк… уже не влазит и неудобно считывать однообразные параметры».
const TAB_NAME_CHARS = 48
const TAB_MODEL_CHARS = 32
const TAB_WHAT_CHARS = 120
// T83: список задач длиннее планки — своей строкой (ось 3 блока): в строке
// состояния он не влезал и сдвигал колонки соседних инстансов.
const TAB_LOAD_LINE_CHARS = 40
// T89 (табуляция Основателя 07.10): отступ = уровень иерархии. Голова
// инстанса на отступе секции (+2), оси блока глубже на ступень (+4), демоны
// ещё глубже (+6): принадлежность строки читается по отступу и по блоку.
const TAB_INDENT = "  "
const AXIS_INDENT = `${TAB_INDENT}  `

// Последний контакт вкладки — локальное время панели, HH:MM (не ISO-шум).
function hhmm(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "—" : d.toTimeString().slice(0, 5)
}

// Живые сессии сервера из GET /api/session/active (T73, проверено живым
// прогоном 07.10): ровно тот сигнал, что питает кнопку Стоп — {data:{ses_…:
// {type:"running"}}}; сессии в ответе нет = не работает. Set = API ответил,
// null = HTTP недоступен/не найден → фолбэк-эвристика (probe в index.ts,
// факт проба виден в runtime.diag.active_api).
export type ActiveSessions = ReadonlySet<string> | null

// Разбор ответа /api/session/active в множество живых сессий. Нечто иное
// (HTML ошибки, обрезанный JSON, пустота) → null: это не «никто не работает»,
// это API не ответил — статус тогда решает эвристика, а не выдуманный простой.
export function parseActiveSessions(raw: unknown): ActiveSessions {
  const data = (raw as { data?: unknown } | null | undefined)?.data
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null
  return new Set(Object.keys(data as Record<string, unknown>).filter((k) => k.startsWith("ses_")))
}

// Честный статус строки вкладки (T59 + T73, заказ Основателя 07.10): раньше
// «работает ⏱» ставилось от любой непустой нагрузки — вкладка молчала, но горела
// рабочей. Три состояния, сигналы только из имеющихся данных:
//   (1) «работает ⏱» — session_id ∈ active (первичный источник: кнопка Стоп
//       живёт именно от этого списка) ИЛИ живые агенты вкладки (running/waiting)
//       в ledger. API недоступен (active === null) — фолбэк-эвристика:
//       свежий ход модели (last_seen ≤ TAB_FRESH_MS: контекст-хук = вызов идёт)
//       ИЛИ живые агенты;
//   (2) «ждёт ⏳» — в active нет (или API молчит), но контакт был:
//       last_seen ≤ TAB_IDLE_MS — вкладка ждёт ответа/файлов от соседей.
//       Старый контакт при живой нагрузке (свои открытые задачи) тоже «ждёт»:
//       «простаивает» там запрещает семантика T59;
//   (3) «простаивает» — last_seen старше TAB_IDLE_MS И ни агентов, ни active:
//       T59 не откатывается — «простаивает» только при старом контакте +
//       отсутствии живой нагрузки (свои открытые задачи = нагрузка).
export const TAB_IDLE_MS = 5 * 60_000
export const TAB_FRESH_MS = 60_000
const TAB_IDLE = "простаивает"
const TAB_WAIT = "ждёт ⏳"
const TAB_WORKING = "работает ⏱"

// Возраст последнего контакта в мс; неизвестная дата = нет данных (не свежий,
// но и не «простаивает» — время наблюдения сломано, простой не выдумываем).
function tabAge(lastSeen: string): number | null {
  const seen = Date.parse(lastSeen)
  return Number.isFinite(seen) ? Date.now() - seen : null
}

function tabIsStale(lastSeen: string): boolean {
  const age = tabAge(lastSeen)
  return age !== null && age > TAB_IDLE_MS
}

function tabIsFresh(lastSeen: string): boolean {
  const age = tabAge(lastSeen)
  return age !== null && age <= TAB_FRESH_MS
}

// Строка инстанса (T69 → T83, заказ Основателя 07.10, живой просмотр 12:13):
// блок из 2-3 строк с одинаковым отступом — оси читаются вертикально,
// однообразные параметры больше не смешаны с именем:
//   ось 1 — идентичность: «🤖 <эмодзи> <имя целиком>» — имя ПЕРВЫМ и без
//           обрезки; общий префикс logOS.runtime.LUNA: из рендера УБРАН
//           (метка сессии панели не нужна, у всех строк она одинаковая и
//           ничего не различает — правка Основателя 07.10 12:13);
//   ось 2 — состояние: модель · бар DONE/всего · [короткий T-список] ·
//           в задаче T#(⏱остаток) · статус · контакт HH:MM · <instance-speed-suffix>;
//   ось 3 — открытые задачи [T…], только когда список длинный (TAB_LOAD_LINE_CHARS).
// Маркер секции (🤖) стоит только у ПЕРВОЙ строки блока: продолжения с ним
// читались бы как отдельные инстансы («все скопом») — они идут чистым
// отступом под имя. Панель узнаёт голову по маркеру+отступу и ведёт блок
// сама (inTab в renderConsoleHtml); статус и время живут в оси состояния —
// по ней панель красит строку (T73), вешает elapsed и ETA. Только живое:
// DONE-задачи в нагрузке не показываются, а демоны вложены отдельными
// строками — 🤖 из строки убран (T69: они и есть Agent).
// T68 (заказ Основателя 08.10, «пусть мигают простаивающие»): честный статус
// строки — отдельной чистой функцией. Её же зовёт авто-мигание index.ts
// (скан цикла): решение об одном и том же принимается здесь, а не парсится из
// строки рендера — паттерн zombieSettleReason (чистое правило → юнит-тест).
// describeTab ниже дергает ЭТУ же функцию → панель и авто-мигание расходиться
// не могут по построению.
export function tabStatus(v: TabView, ledger: Ledger, active: ActiveSessions = null): string {
  const open = ledger.tasks.filter((t) => t.session_ref === v.session_id && t.state !== "DONE")
  const live = ledger.agents.filter(
    (a) => v.agents.includes(a.id) && (a.state === "running" || a.state === "waiting"),
  )
  const load = clip(open.map((t) => t.id).join(" "), TAB_WHAT_CHARS)
  const working =
    live.length > 0 || (active !== null ? active.has(v.session_id) : tabIsFresh(v.last_seen))
  return working ? TAB_WORKING : !tabIsStale(v.last_seen) || load !== "" ? TAB_WAIT : TAB_IDLE
}

// T68: решение авто-мигания (правило по СМЕНЕ статуса, а не по уровню):
//   «start» — строка ВОШЛА в «простаивает» (первый проход скана считается
//     входом: инстанс, простаивающий на старте рантайма, тоже мигает) И
//     мигания нет — включаем;
//   «stop»  — активность вернулась (выход из «простаивает»: active-сессия,
//     свежий ход, живые агенты, открытая нагрузка), горит НАШЕ авто-мигание —
//     гасим, title восстанавливается;
//   «none»  — перехода нет либо горит РУЧНОЕ мигание (T60: клик основателя
//     авто-логика не трогает никогда — флаг autoStarted ставится только
//     здесь, а клик /blink его сбрасывает). Поэтому простой после ручного
//     «погасить» скан НЕ включает заново: иначе клик T60 был бы бессмыслен.
// T125 (заказ Основателя 29.10, СРОЧНО): ПРЯМОЙ ЧАТ С ОСНОВАТЕЛЕМ —
// единственный источник права на эмодзи и мигание. Признак детерминированный:
// вкладка зарегистрирована top-level (ledger.tabs) И не служебная. Служебные =
// пробники бенча (__probe …), сессии задач («T47 · …» — дети диспатча) и
// harness-мета-промпты («Acknowledging exact reply request», «Exact OK …»).
// Присутствие в проекте и назначение задачи перепиской НЕ считаются.
export const SERVICE_TITLE_RE = /(?:^__probe\b|^T\d+\s*·|^◉\s|Acknowledging|Exact OK)/i

export function isDirectTitle(title: string | null | undefined): boolean {
  const t = (title ?? "").trim()
  if (!t) return false
  return !SERVICE_TITLE_RE.test(t)
}

export function isDirectConversation(sessionID: string | null | undefined, ledger: Ledger): boolean {
  if (!sessionID) return false
  const t = ledger.tabs.find((x) => x.session_id === sessionID)
  if (!t) return false
  return isDirectTitle(t.title)
}

export function autoBlinkAction(
  status: string,
  prevStatus: string | null,
  blinking: boolean,
  autoStarted: boolean,
  direct: boolean = true, // T125: не-чат с Основателем мигать не имеет права
): "start" | "stop" | "none" {
  if (!direct) return "none"
  // prevStatus === null = первый проход скана: вход в простой засчитывается
  // (null ≠ «простаивает»), на активной строке старт не нужен.
  if (status === TAB_IDLE) return prevStatus !== TAB_IDLE && !blinking ? "start" : "none"
  return prevStatus === TAB_IDLE && blinking && autoStarted ? "stop" : "none"
}

export function describeTab(
  v: TabView,
  ledger: Ledger,
  active: ActiveSessions = null,
): string[] {
  const own = ledger.tasks.filter((t) => t.session_ref === v.session_id)
  const open = own.filter((t) => t.state !== "DONE")
  const live = ledger.agents.filter(
    (a) => v.agents.includes(a.id) && (a.state === "running" || a.state === "waiting"),
  )
  const load = clip(open.map((t) => t.id).join(" "), TAB_WHAT_CHARS)
  // Готовность строки (T69, ответ Основателя) = задачи инстанса DONE/всего по
  // session_ref; задач у инстанса нет — бара нет: процент не выдумывается.
  const p = own.length > 0 ? { done: own.filter((t) => t.state === "DONE").length, total: own.length } : null
  // T74(1): текущая задача вкладки с остатком плана живого агента — строка
  // состояния тикает клиентским тикером (renderConsoleHtml кладёт её в ETA-map
  // по индексу строки). Задача без живого агента — без ⏱ (базы нет, не выдумываем).
  const cur = currentWork(own, live)
  // Три состояния (T73): в active сервера (или живые агенты) = «работает ⏱»;
  // нет в active, но контакт ≤5мин = «ждёт ⏳»; старый контакт без живой
  // нагрузки = «простаивает» (T59). Без API (active === null) работает эвристика
  // «свежий ход ≤60с». Свои открытые задачи без агентов — не «работает» (вкладка
  // молчит) и не «простаивает» (живая нагрузка по T59) → «ждёт ⏳». Статус не
  // режется клипом нагрузки — он всегда последнее слово. T68: решение живёт в
  // tabStatus (та же функция кормит авто-мигание) — здесь только вызов.
  const status = tabStatus(v, ledger, active)
  // Длинный список — своей строкой (ось 3); короткий остаётся в оси состояния:
  // отдельная строка на два-три id только шумит.
  const longLoad = load !== "" && load.length > TAB_LOAD_LINE_CHARS
  // T156 (заказ Основателя 14.11: «В две строки, сгруппируй более умно») + правка
  // Основателя 14.11 (~15:00, примером): мерило/Δ/переработка/время — НА ОСЬ-1
  // рядом с «чем», ось-2 = только ДЕЛО:
  //   ось-1 КТО·ЧЕМ·МЕРИЛО·ВРЕМЯ·КАК = модель · бар (▰ N/M) · мерило T118 · Δ ·
  //          ⏱+Nм · HH:MM · статус (работает ⏱/ждёт ⏳/простаивает — ВСЕГДА последнее слово);
  //   ось-2 ДЕЛО = в задаче T# ⏱остаток · [шлейф]; дела нет вовсе → оси-2 нет
  //          (блок из двух строк — честный простой, выдумывать нечего);
  //   длинный шлейф >40 знаков — прежней отдельной осью 3.
  // Потребители не ломаются: ETA-тикер ищет «в задаче (T\d+)\s+⏱» построчно
  // (ось-2), тултипы T120 groupTitle режут по сегментам «·», авто-мигание зовёт
  // tabStatus напрямую, раскраска — регекс статуса в конце оси-1.
  const head = [clip(v.model ?? "—", TAB_MODEL_CHARS)]
  if (p) head.push(bar(p))
  const work: string[] = []
  if (cur) work.push(cur.agent ? `в задаче ${cur.task.id} ${remaining(cur.agent)}` : `в задаче ${cur.task.id}`)
  if (load !== "" && !longLoad) work.push(`[${load}]`)
  // T129 (декрет Основателя 29.10, вариант 1): вместо строк/сек и эдитов/сек
  // в строке инстанса — суммы работы (без /сек).
  // T118 (канон Основателя 28.10, «ЭФФЕКТИВНОСТЬ = ПОСТОЯННОЕ МЕРИЛО»):
  // строка «строк во времени» НИКОГДА не скрыта — суммы +/− = работа за ВСЮ
  // ЖИЗНЬ вкладки (Δ numstat, durable — переживают рестарты; в простое тоже
  // видна), рядом накопленная эффективность работа/активное время: знаменатель
  // = Σ активных интервалов, физический простой (>EFF_GAP_MS) не считается.
  // Сравнимость (пункт 4 канона): у всех вкладок один и тот же пожизненный базис.
  // (T129-правило «без +0 −0» здесь переопределено каноном T118 — мерило
  // постоянное, ноль тоже показываем.)
  const tabRec = ledger.tabs.find((t) => t.session_id === v.session_id)
  // T118 (канон Основателя 28.10): мерило ПОСТОЯННОЕ — суммы +/− за ВСЮ жизнь
  // вкладки, в простое тоже видны; на оси-1 рядом с «чем» (правка T157).
  head.push(formatTabEff(tabRec?.eff ?? null))
  // T42: aggregated efficiency signature from agents of this instance (after speed suffix, before status/time)
  const instSig = formatInstanceCountersSignature(v.agents, ledger)
  if (instSig) head.push(instSig)
  // T128 (заказ Основателя 29.10): видимая переработка — «⏱+18м» на оси-1
  // (суточный накопитель инстанса + текущий перелёт живых агентов). Без неё —
  // ноль метки не рисует.
  const od = formatOverrunSuffix(tabOverrunMin(v, ledger))
  if (od) head.push(od)
  head.push(hhmm(v.last_seen))
  // Статус — всегда последнее слово оси-1 (T73); ETA-тикер оси-2 не трогает.
  head.push(status)
  const emoji = isDirectTitle(v.title) ? paletteEmoji(v.emoji, INSTANCE_EMOJI) : null
  // T33 (заказ Основателя: «строка начинается с имени вкладки»): снимаем с
  // титула ВСЮ ведущую декорацию — эмодзи-маркер (T87, иначе двойной «🧚 🧚»),
  // символы статуса OpenCode (◉/⚡…) и орнаменты темы (✦): после нашего
  // эмодзи строки должно идти ИМЯ, а не чей-то префикс. Пустой результат
  // (титул целиком из символов) → исходный: имя не выдумываем и строку не рвём.
  // T86: хвост персоны схлопываем к одному — stale-запись леджера могла
  // отстать от починенного титула сессии (двойной «· Маруська…» в панели).
  const bare = v.title.replace(/^[^\p{L}\p{N}]+/u, "")
  const title = (bare === "" ? v.title : bare)
    .replace(/(?:\s+·\s+Маруська\s+Гольденштерн)+$/, " · Маруська Гольденштерн")
  // Имя — первым и целиком (TAB_NAME_CHARS здесь не режет: срезанное «Маруська…»
  // в хвосте строки основатель не читает), путь убран — см. комментарий выше.
  // T83 (правка Основателя 07.10 12:56): маркер 🤖 только у шапки секции ИНСТАНСЫ;
  // голова инстанса — только своё эмодзи + имя (без 🤖), оси — чистый отступ.
  const lines = [
    `${TAB_INDENT}${emoji ? `${emoji} ` : ""}${title}`,
    `${AXIS_INDENT}${head.join(" · ")}`,
  ]
  // T157: дела нет вовсе (нет «в задаче» и короткого шлейфа) → оси-2 нет —
  // блок из двух строк, честный простой (выдумывать ось нечего).
  if (work.length > 0) lines.push(`${AXIS_INDENT}${work.join(" · ")}`)
  if (longLoad) lines.push(`${AXIS_INDENT}[${load}]`)
  return lines
}

// ------------------------------------------------- instances section (T69) --
// Секция «ИНСТАНСЫ» вместо «🤖 ВКЛАДКИ» (согласовано с Основателем 07.10):
// шапка несёт общий % и оба таймера, строка инстанса — её готовность, демоны
// (те же записи Agent) вложены под своей строкой. Секции «🤖 АГЕНТЫ» больше
// нет — она была этим дублем.
const INSTANCES = "🤖 ИНСТАНСЫ"
// T89: демоны — ступенью глубже осей инстанса (голова 2 → оси 4 → демоны 6).
const DAEMON_INDENT = "      "

// T74(3, заказ Основателя 07.10: «не вижу всех агентов»): недавно завершённые
// (settle ≤ 15 мин назад) показываются тусклой строкой с ✓ — дальше не тянуть:
// order 04.10 «консоль = живое состояние» остаётся в силе, история живёт в ledger.
export const SETTLED_FRESH_MS = 15 * 60_000
const SETTLED_MARK = "✓"

function settledFresh(a: Agent): boolean {
  if (a.state !== "completed" && a.state !== "failed") return false
  const at = Date.parse(a.updated_at)
  return Number.isFinite(at) && Date.now() - at <= SETTLED_FRESH_MS
}

// Общий % готовности = DONE/всего по всем задачам ledger'а. Задач нет —
// процента нет: делить нечего, выдуманный процент врёт о состоянии.
function overallPercent(all: Task[]): number | null {
  if (all.length === 0) return null
  const done = all.filter((t) => t.state === "DONE").length
  return Math.floor((done / all.length) * 100) // floor: никогда не преувеличивать
}

// Заказ Основателя 24.10: процент ИНСТАНСОВ учитывает ПЛАН, а не только
// счётчик задач: «все Маруськи на 95%, но план ещё ~59 минут» — открытая
// работа взвешивается теми же минутами, что и ⏳~план в шапке (openHorizon,
// волны×параллелизм — счётчики не расходятся), сделанное — средней
// фактической длительностью закрытых агентов (история ETA, clamp 5..120м).
// Данных не хватает (никто не закрыт, открытых нет, истории нет) — честный
// null → счётный overallPercent, минуты не выдумываем.
export function timeAwarePercent(all: Task[], agents: Agent[], liveCount: number): number | null {
  const open = all.filter((t) => t.state === "WAIT" || t.state === "DOING")
  const doneCount = all.filter((t) => t.state === "DONE").length
  if (doneCount === 0 || open.length === 0) return null
  const durs = agents
    .filter((a) => a.state === "completed")
    .map((a) => Date.parse(a.updated_at) - Date.parse(a.began_at))
    .filter((ms) => Number.isFinite(ms) && ms > 0)
  if (durs.length === 0) return null
  const openMin = openHorizon(open, agents, liveCount)
  if (openMin <= 0) return null
  const meanMin = Math.min(120, Math.max(5, Math.round(durs.reduce((s, x) => s + x, 0) / durs.length / 60000)))
  const doneMin = doneCount * meanMin
  return Math.floor((doneMin / (doneMin + openMin)) * 100) // floor: никогда не преувеличивать
}

// База таймеров шапки — живые агенты: рантайм отдаёт панели только живые
// записи (index.ts фильтрует running|waiting), поэтому текст шапки и отсчёт
// панели считаются по одному множеству. Планы агентов идут параллельно
// (правка Основателя 07.10: «они же параллельно работают — по самому долгому,
// и по плану самого долгого»), поэтому ⏳ = max(began + plan) − сейчас —
// дедлайн самого долгого живого агента, темп отсчёта = 1 (сумма давала бы n
// параллельных отсчётов и выдуманные «5×30мин»); ⏱ = сейчас − самый ранний
// began_at (нарастает). Планы без валидного начала не участвуют.
function liveTimers(live: Agent[]): { dl: number; started: number } | null {
  const starts = live.map((a) => ({ t0: Date.parse(a.began_at), eta: a.eta_min })).filter((x) => Number.isFinite(x.t0))
  if (starts.length === 0) return null
  return {
    dl: Math.max(...starts.map((x) => x.t0 + x.eta * 60000)), // дедлайн самого долгого
    started: Math.min(...starts.map((x) => x.t0)),
  }
}

// ------------------------------------------------------ repo speed (T80) ---
// Repo-level code velocity metric from git numstat. Pure functions, no I/O.
// The runtime (index.ts) calls these on events (step/turn/activity) with
// a ≥60s interval guard, then passes the RepoSpeed to instancesHeader.

// Parse `git diff --numstat HEAD` output: "additions\tdeletions\tpath\n..."
// files — число строк numstat (затронутые файлы): Δфайлов/Δt = эдиты/сек
// repo-level (T80: оригинал задачи требовал и эдиты, не только строки).
export function parseNumstat(output: string): { additions: number; deletions: number; files: number } {
  let additions = 0
  let deletions = 0
  let files = 0
  for (const line of output.trim().split("\n")) {
    const parts = line.split(/\s+/)
    if (parts.length >= 3) {
      const add = parseInt(parts[0], 10)
      const del = parseInt(parts[1], 10)
      if (!Number.isNaN(add)) additions += add
      if (!Number.isNaN(del)) deletions += del
      files += 1
    }
  }
  return { additions, deletions, files }
}

// Parse `git ls-files` output and compute language % by extension mapping.
const EXT_TO_LANG: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript",
  js: "JavaScript", jsx: "JavaScript",
  json: "JSON",
  md: "Markdown",
  html: "HTML", htm: "HTML",
  css: "CSS", scss: "SCSS", sass: "Sass", less: "Less",
  py: "Python",
  rs: "Rust",
  go: "Go",
  java: "Java", kt: "Kotlin", scala: "Scala",
  c: "C", h: "C", cpp: "C++", hpp: "C++", cc: "C++", hh: "C++",
  cs: "C#",
  php: "PHP",
  rb: "Ruby",
  sh: "Shell", bash: "Shell", zsh: "Shell", fish: "Shell",
  ps1: "PowerShell",
  sql: "SQL",
  yaml: "YAML", yml: "YAML",
  toml: "TOML",
  xml: "XML",
  dockerfile: "Dockerfile",
  gitignore: "GitIgnore",
  txt: "Text",
}

export function parseLsFiles(output: string): Record<string, number> {
  const counts: Record<string, number> = {}
  let total = 0
  for (const line of output.trim().split("\n")) {
    const file = line.trim()
    if (!file) continue
    total += 1
    const ext = file.split(".").pop()?.toLowerCase() ?? ""
    const lang = EXT_TO_LANG[ext] ?? (ext ? ext.toUpperCase() : "Unknown")
    counts[lang] = (counts[lang] ?? 0) + 1
  }
  const pct: Record<string, number> = {}
  for (const [lang, count] of Object.entries(counts)) {
    pct[lang] = Math.round((count / total) * 1000) / 10 // one decimal
  }
  return pct
}

// Sliding window ≥60s calculation per §4.3 of RESOURCES_SPEED_CODE.md.
// Returns RepoSpeed with linesPerSec = Δ(add+del) / Δt (Δt in seconds),
// valid = (windowEnd - windowStart) ≥ 60000ms and Δt > 0.
export function calcRepoSpeed(
  prev: { additions: number; deletions: number; files?: number; editEvents?: number; at: number } | null,
  curr: { additions: number; deletions: number; files?: number; editEvents?: number; at: number }
): RepoSpeed {
  const currAddDel = curr.additions + curr.deletions
  if (!prev) {
    return {
      additions: curr.additions,
      deletions: curr.deletions,
      linesPerSec: null,
      editsPerSec: null,
      languagePct: null,
      measuredAt: curr.at,
      windowStart: curr.at,
      windowEnd: curr.at,
      valid: false,
    }
  }
  const dt = curr.at - prev.at
  const deltaLines = currAddDel - (prev.additions + prev.deletions)
  const windowMs = curr.at - prev.at
  const valid = windowMs >= 60_000 && dt > 0
  // T80: эдиты/сек — предпочтительно Δ событий пиши-инструмента (editEvents,
  // их считает runtime на session.tool.called с path/file), фолбэк — Δ
  // затронутых файлов numstat (файлов в одном из замеров нет → не додумываем).
  const deltaFiles =
    prev.files !== undefined && curr.files !== undefined ? curr.files - prev.files : null
  const deltaEvents =
    prev.editEvents !== undefined && curr.editEvents !== undefined
      ? curr.editEvents - prev.editEvents
      : null
  const deltaEdits = deltaEvents ?? deltaFiles
  return {
    additions: curr.additions,
    deletions: curr.deletions,
    linesPerSec: valid && deltaLines > 0 ? deltaLines / (dt / 1000) : null,
    editsPerSec: valid && deltaEdits !== null && deltaEdits > 0 ? deltaEdits / (dt / 1000) : null,
    languagePct: null, // filled by caller from git ls-files cache
    measuredAt: curr.at,
    windowStart: prev.at,
    windowEnd: curr.at,
    valid,
  }
}

// Sliding window ≥60s calculation for per-instance metrics (T81 §4.3).
// linesPerSec = clamp(Δ(add+del) / Δt, ≥0) — snapshot can "go backwards" (parallel edits).
// editsPerSec = Δ unique "sessionID|file" / Δt over window ≥60s.
export function calcInstanceSpeed(
  prev: InstanceDiffSnapshot | null,
  curr: InstanceDiffSnapshot,
  editEvents: InstanceEditEvent[],
  windowStart: number,
): InstanceSpeed {
  const currAddDel = curr.additions + curr.deletions
  if (!prev) {
    return {
      sessionId: curr.sessionId,
      additions: curr.additions,
      deletions: curr.deletions,
      linesPerSec: null,
      editsPerSec: null,
      measuredAt: curr.at,
      windowStart,
      windowEnd: curr.at,
      valid: false,
    }
  }
  const dt = curr.at - prev.at
  const deltaLines = currAddDel - (prev.additions + prev.deletions)
  const windowMs = curr.at - windowStart
  const valid = windowMs >= 60_000 && dt > 0

  // Edits: count unique "sessionID|file" in the current window
  const windowEvents = editEvents.filter((e) => e.at >= windowStart && e.at <= curr.at)
  const uniqueEdits = new Set(windowEvents.map((e) => `${e.sessionId}|${e.file}`)).size
  const prevWindowEvents = editEvents.filter((e) => e.at >= windowStart && e.at <= prev.at)
  const prevUniqueEdits = new Set(prevWindowEvents.map((e) => `${e.sessionId}|${e.file}`)).size
  const deltaEdits = uniqueEdits - prevUniqueEdits

  return {
    sessionId: curr.sessionId,
    additions: curr.additions,
    deletions: curr.deletions,
    linesPerSec: valid && deltaLines > 0 ? deltaLines / (dt / 1000) : null,
    editsPerSec: valid && deltaEdits > 0 ? deltaEdits / (dt / 1000) : null,
    measuredAt: curr.at,
    windowStart,
    windowEnd: curr.at,
    valid,
  }
}

// T129 (декрет Основателя 29.10, вариант 1): из ⚡-шапки УБРАНЫ строк/сек,
// эдитов/сек и язык% — шапка = только "repo: +N −M" (суммы за окно; рядом
// рисуются CPU%, план и uptime — это отдельные куски строки). Скоростная
// семантика отдана строкам инстансов (там — как суммы +/−, см. describeTab);
// сам опрос /diff снижен до 300с из-за CPU-инцидента 29.10.
export function formatRepoSpeed(speed: RepoSpeed | null): string | null {
  if (!speed || !speed.valid) return null
  return `repo: +${speed.additions} −${speed.deletions}`
}

// ============================ T118: ЭФФЕКТИВНОСТЬ = ПОСТОЯННОЕ МЕРИЛО ======
// Канон Основателя 28.10 (три сообщения): строка «строк во времени» НИКОГДА
// не скрывается; в простое видна НАКОПЛЕННАЯ эффективность (работа/активное
// время от рождения инстанса); физический простой в знаменатель НЕ входит
// (не считается работой). Знаменатель = Σ активных интервалов за всю жизнь;
// интервал делится разрывом паузы > EFF_GAP_MS. Работа = Δ(+/−) numstat.
// Всё durable в леджере — переживает рестарты (сид из памяти убран).
export const EFF_GAP_MS = 5 * 60_000 // разрыв паузой дольше 5 минут = новый интервал

export interface TabEff {
  born_at: string // первое появление вкладки (ISO)
  active_ms: number // Σ активных интервалов за жизнь (паузы >EFF_GAP_MS исключены)
  work_add: number // Σ + строк (Δ numstat за жизнь)
  work_del: number // Σ − строк
  last_active: string | null // конец последнего учтённого активного интервала
  base_add: number | null // прошлый замер numstat (база Δ); null = база не снята
  base_del: number | null
}

/** Ленивая инициализация накопителей (миграция старых вкладок: born_at = последнее наблюдение). */
export function ensureTabEff(tab: TabSession, atISO: string): TabEff {
  const e = tab.eff
  if (
    e &&
    typeof e === "object" &&
    typeof e.born_at === "string" &&
    e.born_at !== "" &&
    typeof e.active_ms === "number" &&
    typeof e.work_add === "number" &&
    typeof e.work_del === "number"
  ) {
    return e
  }
  tab.eff = {
    born_at: typeof tab.last_seen === "string" && tab.last_seen !== "" ? tab.last_seen : atISO,
    active_ms: 0,
    work_add: 0,
    work_del: 0,
    last_active: null,
    base_add: null,
    base_del: null,
  }
  return tab.eff
}

/**
 * Работа = Δ(+/−) numstat между замерами. База хранится в леджере — рестарт
 * НЕ теряет историю и НЕ дублирует её (первый после рестарта замер только
 * переснимает базу: дельта неизвестна — не выдумываем). Снапшот может «уйти
 * назад» (коммит съедает кумулятив) — дельта клампится в ≥0 (семантика T81).
 */
export function noteTabEffWork(
  ledger: Ledger,
  sessionID: string,
  curr: { additions: number; deletions: number },
  atISO: string,
): boolean {
  const tab = ledger.tabs.find((t) => t.session_id === sessionID)
  if (!tab) return false
  const eff = ensureTabEff(tab, atISO)
  if (typeof eff.base_add === "number" && typeof eff.base_del === "number") {
    eff.work_add += Math.max(0, curr.additions - eff.base_add)
    eff.work_del += Math.max(0, curr.deletions - eff.base_del)
  }
  eff.base_add = curr.additions
  eff.base_del = curr.deletions
  return true
}

/**
 * Сброс накопленного в памяти активного времени в леджер. Окно аккаунта:
 * ms = Σ (t_i − t_{i−1}) для пауз ≤EFF_GAP_MS внутри окна; since/last —
 * границы окна. Стык двух окон ≤EFF_GAP_MS = один интервал (добавляем и
 * перемычку), больший стык = интервалы раздельные (пауза не считается).
 * Записи не-вкладок (исполнители, дети) выбрасываются — активное время
 * меряется ТОЛЬКО вкладкам-инстансам.
 */
export function flushTabEffActivity(
  ledger: Ledger,
  entries: Map<string, { ms: number; since: number; last: number }>,
): boolean {
  let changed = false
  for (const [sid, acc] of [...entries]) {
    entries.delete(sid)
    const tab = ledger.tabs.find((t) => t.session_id === sid)
    if (!tab) continue
    const eff = ensureTabEff(tab, new Date(acc.since).toISOString())
    const last = eff.last_active ? Date.parse(eff.last_active) : null
    let ms = acc.ms
    if (last !== null && !Number.isNaN(last) && acc.since - last <= EFF_GAP_MS) {
      ms += acc.since - last // окна слились в один интервал — перемычка тоже активна
    }
    eff.active_ms += Math.max(0, ms)
    eff.last_active = new Date(acc.last).toISOString()
    changed = true
  }
  return changed
}

/**
 * Строка «строк во времени» — всегда НЕпустая (канон: НИКОГДА не скрывается).
  * Суммы +/− = работа за всю жизнь; «R/мин» = накопленная эффективность
  * (работа / Σ активного времени), знаменатель — только активные интервалы.
  * Активного времени меньше минуты — дробь не выдумываем (суммы всё равно видны).
  */
export function formatTabEff(eff: TabEff | null | undefined): string {
  const add = eff && Number.isFinite(eff.work_add) ? Math.max(0, Math.round(eff.work_add)) : 0
  const del = eff && Number.isFinite(eff.work_del) ? Math.max(0, Math.round(eff.work_del)) : 0
  const min = eff && Number.isFinite(eff.active_ms) ? eff.active_ms / 60_000 : 0
  if (min >= 1) {
    const rate = (add + del) / min
    const r = rate >= 10 ? String(Math.round(rate)) : String(Math.round(rate * 10) / 10)
    return `+${add} −${del} · ${r}/мин`
  }
  return `+${add} −${del}`
}

// T85 (заказ Основателя 07.10: «нужна видимая секунда»): обратный отсчёт в
// mm:ss, дальше h:mm:ss — до секунды, без «сгоревших» долей секунды вверх
// (ceil): живому плану никогда не показываем 0:00, пока он не кончился.
// Просрочка — «+mm:ss» (та же семантика, что была «+Nм»).
// T85(3), решение на вопрос «ебануться это ещё и в леджере?» — НЕТ: в
// state.json живут только факт и план (began_at, eta_min, est задачи), а
// «осталось» — производная t0+eta, считается здесь же при рендере (панель её
// тикает JS-тикером 1с). Перезапись леджера каждую секунду убьёт
// write-exclusive, раздувает git-историю и порождает гонки между вкладками.
const p2t = (n: number): string => String(n).padStart(2, "0")

function fmtRemain(ms: number): string {
  const over = ms < 0
  // «осталось» — вверх (живому плану не показываем 0:00, пока он не кончился);
  // «просрочка» — вниз (не преувеличиваем на долю секунды).
  const s = over ? Math.floor(Math.abs(ms) / 1000) : Math.ceil(Math.abs(ms) / 1000)
  const h = Math.floor(s / 3600)
  const body = h
    ? `${h}:${p2t(Math.floor((s % 3600) / 60))}:${p2t(s % 60)}`
    : `${p2t(Math.floor(s / 60))}:${p2t(s % 60)}`
  return over ? `+${body}` : body
}

// Наросшее время шапки (не обратный отсчёт) — прежний порядок минут: сверх
// секундной точности оно ничего не решает, а строку толстить не нужно.
function minutesGone(ms: number): string {
  return `${Math.max(0, Math.floor(ms / 60000))}м`
}

// -------------------------------------------- T132: контроль квот (шапка) --
// Заказ Основателя 29.10: «usage снимать (Console API если отдаёт; иначе Σcost
// сессий за rolling-окно) и показывать в шапке панели «Rolling X%» +
// предупреждение при ≥80%». Три источника, по убыванию честности:
//   guard   — квот-ошибка провайдера ПРОИЗОШЛА (provider.quota) → это ровно
//             100% до сброса окна: сильнее任何 цифр быть не может;
//   console — сам сервер/OpenCode отдаёт проценты (сейчас 404 — путь готов);
//   cost    — Σcost/Σтокенов сессий, обновлённых внутри rolling-окна:
//             процентов не даёт (лимит провайдер не публикует), даёт честный
//             расход; на free-моделях cost=0, поэтому токены считаем всегда.
// Окно 93 мин = «сброс ~1ч33м» из живой пробы карты квот 29.10.
export const ROLLING_WINDOW_MIN = 93
export const QUOTA_WARN_PCT = 80

export type QuotaSource = "guard" | "console" | "cost"

export interface QuotaUsage {
  rollingPct: number | null // 0..100, null = источник не дал процента
  weeklyPct: number | null
  monthlyPct: number | null
  source: QuotaSource
  costUsd: number // Σcost сессий за rolling-окно (USD)
  tokens: number // Σтокенов (input+output+reasoning+cache) за окно
  sessions: number // сколько сессий попало в окно
  windowMin: number
  at: number // когда снято (ms)
  resetAt: number | null // когда окно сгорает, если источник это сообщил (ms)
}

// Число из формы Console API: 100 | "100" | "100%" | 1.0? — проценты берём
// как есть (0..100), дробную долю (≤1 с дробью > 0) пересчитываем ×100.
function pctOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    const n = v > 0 && v <= 1 ? Math.round(v * 1000) / 10 : v
    return Math.max(0, Math.min(100, Math.round(n)))
  }
  if (typeof v === "string") {
    const m = /^-?\d+(\.\d+)?\s*%?$/.exec(v.trim())
    if (m) return pctOf(parseFloat(v))
  }
  return null
}

function findPct(raw: Record<string, unknown>, names: readonly string[]): number | null {
  for (const [k, v] of Object.entries(raw)) {
    const key = k.toLowerCase().replace(/[\s_-]+/g, "")
    if (names.includes(key)) {
      const p = pctOf(v)
      if (p !== null) return p
    }
  }
  return null
}

// Console API отдал проценты? → QuotaUsage с источником console, иначе null.
export function parseConsoleQuota(raw: unknown, at: number = Date.now()): QuotaUsage | null {
  if (!raw || typeof raw !== "object") return null
  const o = raw as Record<string, unknown>
  const nested = (o.usage ?? o.quota ?? o.data) as Record<string, unknown> | undefined
  const src = nested && typeof nested === "object" && !Array.isArray(nested) ? nested : o
  const rolling = findPct(src, ["rolling", "rollingusage", "rollingpct"])
  const weekly = findPct(src, ["weekly", "week", "weeklyusage"])
  const monthly = findPct(src, ["monthly", "month", "monthlyusage"])
  if (rolling === null && weekly === null && monthly === null) return null
  const resetRaw = src.resetAt ?? src.reset ?? src.resetsAt
  const resetAt =
    typeof resetRaw === "number" && Number.isFinite(resetRaw) ? resetRaw :
    typeof resetRaw === "string" && Number.isFinite(Date.parse(resetRaw)) ? Date.parse(resetRaw) : null
  return {
    rollingPct: rolling,
    weeklyPct: weekly,
    monthlyPct: monthly,
    source: "console",
    costUsd: 0,
    tokens: 0,
    sessions: 0,
    windowMin: ROLLING_WINDOW_MIN,
    at,
    resetAt,
  }
}

// Одна строка сессии из GET /api/session (только то, что реально нужно).
export interface SessionUsageSample {
  cost?: unknown
  tokens?: { input?: unknown; output?: unknown; reasoning?: unknown; cache?: { read?: unknown; write?: unknown } } | unknown
  time?: { updated?: unknown } | unknown
}

// Σcost/Σтокенов сессий, обновлённых внутри rolling-окна — фолбэк-источник,
// когда Console API процента не отдаёт. Сессии без валидной отметки updated
// в окно не попадают: не доказано → не выдумываем.
export function rollingUsage(
  items: readonly SessionUsageSample[] | null | undefined,
  at: number = Date.now(),
  windowMs: number = ROLLING_WINDOW_MIN * 60_000,
): QuotaUsage {
  const start = at - windowMs
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0)
  let costUsd = 0
  let tokens = 0
  let sessions = 0
  for (const s of items ?? []) {
    const t = (s?.time as { updated?: unknown } | undefined)?.updated
    if (typeof t !== "number" || !Number.isFinite(t) || t < start) continue
    sessions += 1
    costUsd += num(s?.cost)
    const tk = s?.tokens as SessionUsageSample["tokens"] | undefined
    if (tk && typeof tk === "object") {
      const cache = tk.cache as { read?: unknown; write?: unknown } | undefined
      tokens += num(tk.input) + num(tk.output) + num(tk.reasoning) + num(cache?.read) + num(cache?.write)
    }
  }
  return {
    rollingPct: null,
    weeklyPct: null,
    monthlyPct: null,
    source: "cost",
    costUsd,
    tokens,
    sessions,
    windowMin: Math.round(windowMs / 60_000),
    at,
    resetAt: null,
  }
}

// Квот-ошибка провайдера ПРОИЗОШЛА (prompt-catch/T66) — это 100% rolling до
// сброса; окно держим равным кулдауну звена (model_reset/timer его снимет).
export function quotaGuardUsage(at: number = Date.now(), resetAt: number | null = null): QuotaUsage {
  return {
    rollingPct: 100,
    weeklyPct: null,
    monthlyPct: null,
    source: "guard",
    costUsd: 0,
    tokens: 0,
    sessions: 0,
    windowMin: ROLLING_WINDOW_MIN,
    at,
    resetAt,
  }
}

// Приоритет источников: guard (доказанная квота) → console (проценты провайдера)
// → cost (честный расход). Победитель наследует расход из cost-среза, если у
// него самого цифры нулевые: в шапке не должно исчезать то, что измерено.
export function mergeQuota(
  guard: QuotaUsage | null,
  consoleQ: QuotaUsage | null,
  costQ: QuotaUsage | null,
): QuotaUsage | null {
  const winner = guard ?? consoleQ ?? costQ
  if (!winner) return null
  if (!costQ || winner === costQ) return winner
  if (winner.costUsd === 0 && winner.tokens === 0) {
    return { ...winner, costUsd: costQ.costUsd, tokens: costQ.tokens, sessions: costQ.sessions }
  }
  return winner
}

export function quotaWarning(q: QuotaUsage | null | undefined): boolean {
  return !!q && q.rollingPct !== null && q.rollingPct >= QUOTA_WARN_PCT
}

const fmtTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(Math.round(n))
}

// Токен для шапки панели: «Rolling 100% · ⚠» или «Rolling 1.24M ток · 93м».
// Нечего показать (ни процента, ни расхода) → null: пустой хвост в шапке не
// рисуем, а не «0%», которого мы не измеряли.
export function formatQuotaHeader(q: QuotaUsage | null | undefined): string | null {
  if (!q) return null
  if (q.rollingPct !== null) {
    const bits = [`Rolling ${q.rollingPct}%`]
    if (q.rollingPct >= QUOTA_WARN_PCT) bits.push("⚠")
    if (q.weeklyPct !== null) bits.push(`Week ${q.weeklyPct}%`)
    if (q.monthlyPct !== null) bits.push(`Month ${q.monthlyPct}%`)
    if (q.resetAt !== null && Number.isFinite(q.resetAt)) {
      const d = new Date(q.resetAt)
      bits.push(`сброс ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`)
    }
    return bits.join(" · ")
  }
  if (q.costUsd > 0 || q.tokens > 0) {
    const usage = q.costUsd > 0 ? `$${q.costUsd.toFixed(2)}` : `${fmtTokens(q.tokens)} ток`
    return `Rolling ${usage} · ${q.windowMin}м`
  }
  return null
}

// Шапка (T69): «[иконка] ИНСТАНСЫ · <общий %> · ⏳<осталось> · ⏱<шло>» —
// живая база (живые агенты) даёт отсчёт/наросшее; живых нет (ночной settle,
// провал провайдера, релоад — T104(3)): строка времени НЕ ИСЧЕЗАЕТ, она несёт
// плановый горизонт открытого списка задач с явной пометкой «план» — это
// оценка, а не отсчёт, и мы её так и подаём (не выдуманные секунды).
// T95: CPU warning/hard-stop indicator in header.
// Заказ Основателя 24.10: % учитывает план (timeAwarePercent — минуты открытого
// хвоста против средней закрытой работы); данных нет → счётный overallPercent.
// T120(3) (живой заказ Основателя 29.10: «93% если столько задач не закрыто»):
// процент шапки не врёт подачей — ДВА числа с явными подписями:
//   «по времени 93% · задачи 83% (93/111)»
// timePct — минуты закрытого за жизнь / (закрытое + план открытой волны), это
// история; countPct — счётная доля DONE/всего (floor, как в примере заказа).
// Формула уходит в тултип (title) строки шапки — «почему 93 при 18 открытых».
export function formatHeaderPercent(
  timePct: number | null,
  done: number,
  total: number,
): { text: string; tooltip: string } {
  const countPct = total > 0 ? Math.floor((done / total) * 100) : null
  const parts: string[] = []
  if (timePct !== null) parts.push(`по времени ${timePct}%`)
  if (countPct !== null) parts.push(`задачи ${countPct}% (${done}/${total})`)
  return {
    text: parts.join(" · "),
    tooltip:
      "по времени = закрытые минуты за всю жизнь / (закрытые минуты + план открытой волны); " +
      "задачи = DONE / всего задач. История и текущая волна — разные числа, не смешиваются.",
  }
}

function instancesHeader(
  all: Task[],
  live: Agent[],
  allAgents: Agent[],
  repoSpeed?: RepoSpeed | null,
  cpuWarning?: boolean,
  cpuHardStop?: boolean,
  cpuPct?: number | null,
  planHorizonMin?: number | null,
  quota?: QuotaUsage | null, // T132: «Rolling X%» (+⚠ ≥80%) из контроля квот
  overrunTotalMin?: number | null, // T128: агрегат «переработка за сутки» (0/пусто → без метки)
): string {
  const bits = [INSTANCES]
  const pct = timeAwarePercent(all, allAgents, live.length) ?? overallPercent(all)
  if (pct !== null) {
    // T120(3): два числа с подписями — «по времени X% · задачи Y% (done/total)»
    const hp = formatHeaderPercent(pct, all.filter((t) => t.state === "DONE").length, all.length)
    if (hp.text) bits.push(hp.text)
  }
  // T137 (заказ Основателя 29.10 «шапка загружена»): Rolling$/окно УБРАНО из
  // шапки — по канону T129 остаются: % + план + uptime + repo: +N −M.
  // Квота видна в get_state.quota и в ⚠-будильнике (wake при ≥80%).
  void quota
  const t = liveTimers(live)
  if (t) {
    // T85(1): ⏳ = mm:ss-обратный отсчёт до дедлайна самого долгого живого
    // агента (темп 1 — планы параллельны); клиентский тикер 1с его ведёт.
    bits.push(`⏳${fmtRemain(t.dl - Date.now())}`)
    bits.push(`⏱${minutesGone(Date.now() - t.started)}`)
  }
  if (typeof planHorizonMin === "number" && planHorizonMin > 0) {
    // T104(3): строка времени не пропадает. T161 (заказ Основателя 15.11 «время
    // есть, а задач в списке нет»): план открытого списка живёт в шапке ВСЕГДА —
    // и при живых агентах тоже; ⏳ тогда занят отсчётом ребёнка, план без ⏳.
    bits.push(`${t ? "" : "⏳"}~${fmtRemain(planHorizonMin * 60000)} план`)
  }
  // T95: CPU monitor indicator
  if (cpuHardStop) {
    bits.push(`🔴 CPU ${cpuPct ?? "?"}% HARD STOP`)
  } else if (cpuWarning) {
    bits.push(`🟡 CPU ${cpuPct ?? "?"}% WARNING`)
  }
  // T80: repo-level code velocity metric under section header
  const repoLine = formatRepoSpeed(repoSpeed ?? null)
  if (repoLine) bits.push(repoLine)
  // T128 (заказ Основателя 29.10): агрегат «переработка за сутки» — сумма
  // суточного накопителя по всем инстансам; ноль метки не рисует.
  const odLine = formatOverrunSuffix(overrunTotalMin ?? 0)
  if (odLine) bits.push(odLine)
  return bits.join(" · ")
}

// ------------------------------------------------- batch horizon (T85(2)) --
// Эстимейт всего висящего батча (заказ Основателя 07.10): все WAIT-задачи
// очереди оцениваются сразу. План задачи = learnEta по виду агента, который её
// делал/держит (среднее истории, как у агентов); вида нет или истории нет —
// дефолт очереди 5м (заказ 07.10; у агентов свой дефолт 30м — там план на
// запуск, тут оценка невзятой работы). Оценка фаз T37/T38 в леджере ещё не
// посчитана (поля est нет) — не выдумываем; как посчитается, она перекроет
// среднее здесь.
const QUEUE_DEFAULT_MIN = 5

function taskPlanMin(t: Task, agents: Agent[]): number {
  // Заказ Основателя 24.10: явная оценка фазы (est_min из декомпозиции) —
  // первый источник плана («наверное декомпозиция уже для оценки времени»);
  // без неё — история/дефолт очереди, как раньше.
  if (typeof t.est_min === "number" && t.est_min > 0) return t.est_min
  const bound = agents.filter((a) => a.task_id === t.id)
  if (bound.length === 0) return QUEUE_DEFAULT_MIN
  const kind = agentKind(bound[bound.length - 1]) // последняя попытка: её вид и её история
  const seen = agents.some((a) => a.state === "completed" && agentKind(a) === kind)
  return seen ? learnEta(agents, kind) : QUEUE_DEFAULT_MIN
}

// Горизонт батча — ВЫБОР ФИКСИРУЕМ ЗДЕСЬ (T85(2)): очередь идёт ВОЛНАМИ
// (параллельный диспатч N агентов), поэтому последовательная Σ планов врёт в
// N раз — не считаем её. Считаем по волнам: планы по убыванию, волна = N задач,
// внутри волны работает самый долгий (параллельно → max), между волнами —
// сумма. Параллелизм = сколько живых агентов держит консоль сейчас (минимум 1:
// без живых параллельности не видно — честнее последовательность, чем
// выдуманная «×5»). Второй честный вариант («Σ планов / параллелизм ≈»)
// отклонён: он для равных планов совпадает с волнами, а для неравных занизит
// горизонт (длинная задача в волне с короткими не делится).
// Планы — в минутах (та же единица, что eta_min); возврат — минуты горизонта.
export function batchHorizon(plans: readonly number[], parallelism: number): number /* minutes */ {
  if (plans.length === 0) return 0
  const n = Math.max(1, Math.floor(parallelism))
  const sorted = [...plans].sort((a, b) => b - a)
  let horizon = 0
  for (let i = 0; i < sorted.length; i += n) {
    horizon += Math.max(...sorted.slice(i, i + n)) // внутри волны параллельно → ждём самый долгий
  }
  return horizon
}

// Шапка ⚡ ЗАДАЧИ: горизонт батча с оговоркой семантики прямо в строке.
// Статика (без тикера): якоря у оценки нет — батч ещё не стартовал, отсчёт от
// «до́рисованного сейчас» дошёл бы до нуля и соврал; страница и так
// перерисовывается каждые 2с.
// T104(3): горизонт считается по ВСЕМУ открытому списку (WAIT + DOING), а не
// только по очереди: строка времени списка задач не должна исчезать, когда
// очередь пустеет (всё ушло в В РАБОТЕ).
function openHorizon(open: Task[], agents: Agent[], liveCount: number): number /* minutes */ {
  return batchHorizon(
    open.map((t) => taskPlanMin(t, agents)),
    liveCount,
  )
}

function queueHeader(open: Task[], agents: Agent[], liveCount: number): string {
  const horizon = openHorizon(open, agents, liveCount)
  return `⚡ ЗАДАЧИ · ~${fmtRemain(horizon * 60000)} горизонт (волны ×${Math.max(1, liveCount)}, не Σ)`
}

// Строка демоны (T69): запись Agent, вложенная под строкой своей инстанс-
// вкладки, с отступом. Имя записи стоит первым (T64: logOS.runtime.LUNA.demon-NNN
// вместо general-NN) — по нему панель привязывает план к строке: строки
// сгруппированы по инстансам, порядок массива агентов (его отдаёт рантайм)
// другой, позиционное паривание врало бы отсчётом.
// Маркер (T71, правило 3) — свой эмодзи демона; пустое/чужое → fallback ▸.
// T42: компактная подпись эффективности из Agent.counters (план/факт, ⚠, injections)
// добавляется после существующих токенов; записей без counters — просто без подписи.
// T84: токен автовыбора модели по классу («авто: nemotron (6 набл.)» или «авто: T66-дефолт»).
function formatAgentCount(value: number): string {
  const n = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0))
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 10_000) return `${Math.round(n / 1_000) / 10}k`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function describeDaemon(a: Agent, all: Task[], ledger?: Ledger): string {
  const bound = a.task_id ? all.find((t) => t.id === a.task_id) : null
  const p = bound ? progressOf(bound, all) : null
  const planTail = remaining(a)
  const liveProgress = a.progress
  const progressAge = liveProgress ? Date.now() - Date.parse(liveProgress.updated_at) : Infinity
  const progressBits = liveProgress
    ? [`шаг: ${clip(liveProgress.step, 68)}`, liveProgress.done ? liveProgress.done : "", liveProgress.next ? `→ ${clip(liveProgress.next, 42)}` : "", liveProgress.eta_remaining_min !== null ? `ETA≈${liveProgress.eta_remaining_min}м` : "", "самоотчёт", progressAge > 5 * 60_000 ? "устарел" : ""].filter(Boolean)
    : []
  const progressTail = progressBits.length ? ` · ${progressBits.join(" · ")}` : ""
  const toolTail = a.last_tool ? ` · tool: ${clip(a.last_tool.name, 28)}${a.last_tool.target ? ` → ${clip(a.last_tool.target, 54)}` : ""}` : ""
  const usageTail = a.usage ? ` · TOK ${formatAgentCount(a.usage.total_tokens)} (in ${formatAgentCount(a.usage.input_tokens)}/out ${formatAgentCount(a.usage.output_tokens)})${a.usage.cost_usd > 0 ? ` · $${a.usage.cost_usd.toFixed(4)}` : ""}` : ""
  const requestTail = typeof a.request_count === "number" ? ` · REQ ${formatAgentCount(a.request_count)}` : ""
  const tail = `${p ? `${bar(p)} · ` : ""}${planTail}${progressTail}${toolTail}${usageTail}${requestTail}`
  // Коротко для Основателя: сжатый таск + модель; имя записи = имя демона.
  const what = bound ? clip(bound.task, AGENT_WHAT_CHARS) : a.note
  const head = [a.task_id ? `[${a.task_id}]` : "", a.model ?? "", what ?? ""].filter(Boolean).join(" · ")
  // T125: эмодзи демона — только если его домашняя вкладка = прямой чат с
  // Основателем; фоновая работа помечается нейтральным ▸ (не путать с чатом).
  const mark =
    a.home && ledger
      ? isDirectConversation(a.home, ledger)
        ? (paletteEmoji(a.emoji, DAEMON_EMOJI) ?? DAEMON_FALLBACK)
        : DAEMON_FALLBACK
      : (paletteEmoji(a.emoji, DAEMON_EMOJI) ?? DAEMON_FALLBACK)
  const sig = formatCountersSignature(a.counters)
  // T97(в): orientation-hell — первые сообщения без единого tool-вызова.
  const orientMark = a.orientation === "hell" ? " 🧭orientation-hell" : ""
  // T84: токен автовыбора модели для класса задачи демона
  let modelToken = ""
  if (ledger && a.task_id) {
    const task = all.find((t) => t.id === a.task_id)
    if (task) {
      const cls = taskClass(ledger, task)
      modelToken = ` · ${formatModelClassToken(ledger, cls)}`
    }
  }
  return `${DAEMON_INDENT}${mark} ${demonName(a.id)}${head ? ` · ${head}` : ""} — ${AGENT_STATE_RU[a.state] ?? a.state} ${tail}${orientMark}${sig ? ` ${sig}` : ""}${modelToken}`
}

// T74(3): недавно завершённый демон — тусклая строка с ✓ под своей инстанс-
// строкой (или хвостом секции, если вкладка неизвестна). Без обратного отсчёта:
// план закрыт вместе с агентом; статус (завершил/сбой) остаётся честным.
// T42: компактная подпись эффективности из Agent.counters для завершённых агентов тоже.
function describeSettled(a: Agent, all: Task[]): string {
  const bound = a.task_id ? all.find((t) => t.id === a.task_id) : null
  const what = bound ? clip(bound.task, AGENT_WHAT_CHARS) : a.note
  const head = [a.task_id ? `[${a.task_id}]` : "", a.model ?? "", what ?? ""].filter(Boolean).join(" · ")
  const sig = formatCountersSignature(a.counters)
  return `${DAEMON_INDENT}${SETTLED_MARK} ${demonName(a.id)}${head ? ` · ${head}` : ""} — ${AGENT_STATE_RU[a.state] ?? a.state}${sig ? ` ${sig}` : ""}`
}

// T170 (15.11, жалоба Основателя «не вижу субагентов, а инстансы говорят они
// работают»): строка СУБАГЕНТА-ребёнка сессии из фида (parentID). Это не запись
// Agent — read-only проекция: статус честно от метки обновления сессии.
// Окно видимости — свежие дети (30 мин): древние субагенты не захламляют.
//   ≤60 сек → «работает ⏱» (как ось инстанса);
//   ≤30 мин → «простаивает · HH:MM»;
//   старше  → строка не показывается (как TTL у ЧУЖИХ).
function describeChild(ch: ChildFeedItem, at: number = Date.now()): string | null {
  const upd = ch.updated ? Date.parse(ch.updated) : NaN
  if (!Number.isFinite(upd)) return null // без честной метки строку не строим
  const age = at - upd
  if (age > 30 * 60_000) return null
  const hhmm = new Date(upd).toTimeString().slice(0, 5)
  const what = clip(ch.title, AGENT_WHAT_CHARS)
  const model = ch.model ? ` · ${ch.model}` : ""
  const usage = ch.usage ? ` · TOK ${formatAgentCount(ch.usage.total_tokens)}${ch.usage.cost_usd > 0 ? ` · $${ch.usage.cost_usd.toFixed(4)}` : ""}` : ""
  const status = age <= 60_000 ? `работает ⏱ · ${hhmm}` : `простаивает · ${hhmm}`
  return `${DAEMON_INDENT}▸ ${what}${model} · ${status}${usage}`
}

// T70 (заказ Основателя 07.10): строка ⛔ несёт инстанс, в котором она ждёт
// инфу — вкладку-создателя задачи (session_ref). Нет привязки или вкладка не
// зарегистрирована — без суффикса: инстанс не выдумывается.
function tabOfTask(t: Task, tabs: TabSession[]): TabSession | undefined {
  return t.session_ref ? tabs.find((x) => x.session_id === t.session_ref) : undefined
}

function waitingIn(t: Task, tabs: TabSession[]): string {
  const tab = tabOfTask(t, tabs)
  return tab ? ` · ждёт в 🤖 ${clip(tab.title || tab.session_id, TAB_NAME_CHARS)}` : ""
}

// T74(4, заказ Основателя 07.10): к каждой строке задачи — вкладка-владелец
// (session_ref → имя вкладки), чтобы читалось «в работе у какой Маруськи».
// Привязки нет или вкладка неизвестна — без суффикса (та же честность, что T70).
function ownedIn(t: Task, tabs: TabSession[]): string {
  const tab = tabOfTask(t, tabs)
  return tab ? ` · у 🤖 ${clip(tab.title || tab.session_id, TAB_NAME_CHARS)}` : ""
}

// T74(1, заказ Основателя 07.10): текущая задача вкладки для её строки —
// DOING-задача или задача, которой занят живой агент; приоритет: DOING+агент →
// занятая агентом → DOING без агента. Остаток показывается только когда есть
// живой агент с валидным планом (база для отсчёта не выдумывается); если их
// несколько — самый ранний по финишу (тот же выбор делает панель).
function currentWork(own: Task[], live: Agent[]): { task: Task; agent: Agent | null } | null {
  const open = own.filter((t) => t.state !== "DONE")
  const busy = (t: Task): boolean => live.some((a) => a.task_id === t.id)
  const pick =
    open.find((t) => t.state === "DOING" && busy(t)) ??
    open.find((t) => busy(t)) ??
    open.find((t) => t.state === "DOING")
  if (!pick) return null
  const plans = live
    .filter((a) => a.task_id === pick.id && Number.isFinite(Date.parse(a.began_at)))
    .sort(
      (a, b) =>
        Date.parse(a.began_at) + a.eta_min * 60000 - (Date.parse(b.began_at) + b.eta_min * 60000),
    )
  return { task: pick, agent: plans[0] ?? null }
}

// T72 (заказ Основателя 07.10: «как-то не осмысленно отсортирована», выбор
// «Горячие → начатые → свежие»): ⚡ ЗАДАЧИ больше не insertion order леджера.
// Базовая линия — группировка: родитель ● и его WAIT-дети ↳ одной группой,
// дети идут сразу за родителем (сортировка детей — по id); DONE-дети в очередь
// не попадают вовсе (фильтр WAIT — уже так). Среди корневых WAIT-задач три
// яруса сверху вниз:
//   (а) горячие — есть owner ИЛИ задачей занят агент (непустая occupancy);
//   (б) начатые — есть DONE-дети (progressOf.done > 0), но ни owner, ни агента;
//   (в) нетронутые — сверху новые (created_at desc): старый бэклог уходит вниз.
// Внутри (а)(б) — created_at asc: кто раньше взят/начат, тот раньше.
// T43: приоритет (priority) — опциональное число; меньше = выше приоритет.
// Задачи с заданным приоритетом идут ДО задач без приоритета внутри каждого яруса.
// Проекция чистая: порядок пересчитывается на каждый рендер, ничего не
// теряется — все WAIT-задачи остаются в списке, меняется только их порядок.
function queueOrder(queue: Task[], all: Task[], agents: Agent[]): Task[] {
  const inQueue = new Set(queue.map((t) => t.id))
  const kids = new Map<string, Task[]>()
  const roots: Task[] = []
  for (const t of queue) {
    // Родитель тоже в очереди → это ребёнок группы; иначе (родитель DOING и
    // т.п.) корневая задача: её ярус решается сам, строка не теряется.
    if (t.parent !== null && inQueue.has(t.parent)) {
      const list = kids.get(t.parent)
      if (list) list.push(t)
      else kids.set(t.parent, [t])
    } else roots.push(t)
  }
  // FIX T43: дети (фазы) тоже видят priority — иначе сервер пишет приоритет
  // драга, а рендер сортирует детей только по id и эффекта нет. Тie-break =
  // прежний порядок по id (бэккомпат при отсутствии приоритетов).
  for (const list of kids.values()) {
    list.sort((a, b) => {
      const pa = a.priority ?? Infinity
      const pb = b.priority ?? Infinity
      if (pa !== pb) return pa - pb
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
  }

  const hot = (t: Task): boolean => t.owner !== null || agents.some((a) => a.task_id === t.id)
  const started = (t: Task): boolean => {
    const p = progressOf(t, all)
    return p !== null && p.done > 0
  }
  // T43: сортировка с учётом приоритета. priority: number | null/undefined.
  // Меньше число = выше приоритет. null/undefined идут в конец.
  const withPriority = (t: Task): boolean => t.priority !== null && t.priority !== undefined
  const asc = (a: Task, b: Task): number => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0)
  const desc = (a: Task, b: Task): number => -asc(a, b)
  const byPriorityAsc = (a: Task, b: Task): number => {
    const pa = a.priority ?? Infinity
    const pb = b.priority ?? Infinity
    if (pa !== pb) return pa - pb
    return asc(a, b)
  }
  const byPriorityDesc = (a: Task, b: Task): number => {
    const pa = a.priority ?? Infinity
    const pb = b.priority ?? Infinity
    if (pa !== pb) return pa - pb
    return desc(a, b)
  }

  const tier = (pick: (t: Task) => boolean, cmp: (a: Task, b: Task) => number): Task[] =>
    roots.filter(pick).sort(cmp)

  const ordered = [
    ...tier((t) => hot(t) && withPriority(t), byPriorityAsc), // (а) горячие с приоритетом
    ...tier((t) => hot(t) && !withPriority(t), asc), // (а) горячие без приоритета
    ...tier((t) => !hot(t) && started(t) && withPriority(t), byPriorityAsc), // (б) начатые с приоритетом
    ...tier((t) => !hot(t) && started(t) && !withPriority(t), asc), // (б) начатые без приоритета
    ...tier((t) => !hot(t) && !started(t) && withPriority(t), byPriorityDesc), // (в) нетронутые с приоритетом (приоритет важнее created_at)
    ...tier((t) => !hot(t) && !started(t) && !withPriority(t), desc), // (в) нетронутые без приоритета
  ]

  const out: Task[] = []
  for (const t of ordered) {
    out.push(t)
    const children = kids.get(t.id)
    if (children) out.push(...children)
  }
  return out
}

export function project(
  ledger: Ledger,
  active: ActiveSessions = null,
  stateFile?: string,
  repoSpeed?: RepoSpeed | null,
  instanceSpeeds?: Map<string, InstanceSpeed>,
  cpuWarning?: boolean,
  cpuHardStop?: boolean,
  cpuPct?: number | null,
  quota?: QuotaUsage | null, // T132: контроль квот в шапке ИНСТАНСЫ (опционально)
): Projection {
  const all = ledger.tasks
  const tasks = all.filter((t) => t.state !== "DONE")
  const doing = all.filter((t) => t.state === "DOING")
  const queue = queueOrder(
    all.filter((t) => t.state === "WAIT"), // ⚡ ЗАДАЧИ = очередь
    all,
    ledger.agents,
  )
  const agents = ledger.agents.filter(isLive)
  // T74(3): свежие settle (≤15 мин) — тусклые строки с ✓; старше порога не показываем
  const settled = ledger.agents.filter(settledFresh)
  const blocked = all.filter((t) => t.state === "BLOCKED")
  const gates = all.filter((t) => t.state === "GATE")
  const done = all.filter((t) => t.state === "DONE").sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
  // T104(3): открытый список = весь работающий хвост (очередь + в работе) —
  // по нему считаются обе строки времени панели (шапка ИНСТАНСЫ без живых +
  // шапка ⚡ ЗАДАЧИ), чтобы они не исчезали при пустой очереди/settle.
  const open = all.filter((t) => t.state === "WAIT" || t.state === "DOING")
  // T161 (заказ Основателя 15.11): план открытого списка — всегда, не только
  // при пустых агентах; при живых детях шапка несёт ОБА времени (⏳ отсчёт
  // ребёнка + план без ⏳). Горизонт честно делится на живой параллелизм.
  const planHorizonMin =
    open.length > 0 ? openHorizon(open, ledger.agents, agents.length) : null

  const sections: string[] = []

  // 🤖 ИНСТАНСЫ первой в панели (T59 → T69, заказ Основателя 07.10): сначала
  // кто работает (инстансы и их демоны), потом что делается. Шапка несёт общий
  // % и оба таймера; демоны вложены под своей строкой — секции «🤖 АГЕНТЫ»
  // больше нет (T69: демоны и есть те же записи Agent). Пустой регистр и живых
  // агентов нет — секции нет, как у всех секций.
  const tabViews = projectTabs(ledger)
  // T42: сортировка ИНСТАНСЫ по план/факт (plan_acc) — у кого алгоритмы садятся,
  // видно сверху. plan_acc = actual/plan ratio, higher = slower than planned.
  // Nulls (no counters) go to the bottom, then stable alphabetic by title.
  tabViews.sort((a, b) => {
    const pa = instancePlanAcc(a.agents, ledger)
    const pb = instancePlanAcc(b.agents, ledger)
    if (pa === null && pb === null) return a.title.localeCompare(b.title)
    if (pa === null) return 1 // nulls last
    if (pb === null) return -1
    // Higher plan_acc first (algorithms sitting down = taking longer than planned)
    if (pb !== pa) return pb - pa
    return a.title.localeCompare(b.title)
  })
  if (tabViews.length > 0 || agents.length > 0 || settled.length > 0) {
    const placed = new Set<string>()
    const rows: string[] = []
    for (const v of tabViews) {
      // T83: строка инстанса = блок из 2-3 строк-осей (одинаковый отступ);
      // демоны вложены ПОСЛЕ блока — своя вложенность сохраняется.
      const instSpeed = instanceSpeeds?.get(v.session_id) ?? null
      void instSpeed // T118: суммы теперь lifetime (durable) — рендер в describeTab читает tab.eff; параметр оставлен для совместимости вызовов
      rows.push(...describeTab(v, ledger, active))
      // T170: субагенты-дети сессий (read-only проекция фида) — строки-боты
      // сразу под вкладкой, до записей Agent (демонов).
      for (const ch of v.children ?? []) {
        const row = describeChild(ch)
        if (row) rows.push(row)
      }
      for (const id of v.agents) {
        const a = ledger.agents.find((x) => x.id === id)
        if (!a) continue
        if (isLive(a)) {
          rows.push(describeDaemon(a, all, ledger))
          placed.add(a.id)
        } else if (settledFresh(a)) {
          rows.push(describeSettled(a, all)) // T74(3): недавно завершённые — тусклым ✓
          placed.add(a.id)
        }
      }
    }
    // Живой демон без инстансы (вкладка неизвестна): запись не теряем — строка
    // идёт хвостом секции, без выдуманной строки инстанса.
    for (const a of agents) if (!placed.has(a.id)) rows.push(describeDaemon(a, all, ledger))
    for (const a of settled) if (!placed.has(a.id)) rows.push(describeSettled(a, all))
    // T128: агрегат переработки за сутки = суточный накопитель (settle'нутые)
    // + текущий перелёт всех живых агентов — та же семантика, что у строк вкладок.
    const overrunTotal = overrunOfDay(ledger) + agents.reduce((s, a) => s + liveOverrunMin(a), 0)
    sections.push([instancesHeader(all, agents, ledger.agents, repoSpeed, cpuWarning, cpuHardStop, cpuPct, planHorizonMin, quota ?? null, overrunTotal), ...rows].join("\n"))
  }

  // Каждая задача — ровно в одной секции (нет дублирования).
  if (doing.length > 0) {
    // T43: DOING tasks also respect priority (higher priority = higher in list)
    // FIX T43 (рецензия): плоская сортировка ломала иерархию — ребёнок с
    // приоритетом уезжал выше своей строки-родителя («↳» перед «●»). Теперь как
    // в очереди: корни сортируются по приоритету/созданию, дети идут ЗА своим
    // родителем, внутри группы — по приоритету (tie-break прежний, по id).
    const inDoing = new Set(doing.map((t) => t.id))
    const doingRoots: Task[] = []
    const doingKids = new Map<string, Task[]>()
    for (const t of doing) {
      if (t.parent !== null && inDoing.has(t.parent)) {
        const l = doingKids.get(t.parent)
        if (l) l.push(t)
        else doingKids.set(t.parent, [t])
      } else doingRoots.push(t)
    }
    const byPrioCreated = (a: Task, b: Task): number => {
      const pa = a.priority ?? Infinity
      const pb = b.priority ?? Infinity
      if (pa !== pb) return pa - pb
      return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0
    }
    const byPrioId = (a: Task, b: Task): number => {
      const pa = a.priority ?? Infinity
      const pb = b.priority ?? Infinity
      if (pa !== pb) return pa - pb
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    }
    for (const l of doingKids.values()) l.sort(byPrioId)
    doingRoots.sort(byPrioCreated)
    const doingOrdered: Task[] = []
    for (const t of doingRoots) {
      doingOrdered.push(t)
      const k = doingKids.get(t.id)
      if (k) doingOrdered.push(...k)
    }
    // T99: compact blocks — header + axis per task, empty line between blocks
    const doingBlocks: string[] = []
    for (let i = 0; i < doingOrdered.length; i++) {
      const t = doingOrdered[i]
      doingBlocks.push(...describeTaskBlock(t, all, ledger.agents, ledger.tabs))
      if (i < doingOrdered.length - 1) doingBlocks.push("") // empty line between blocks
    }
    sections.push(["🔄 В РАБОТЕ", ...doingBlocks].join("\n"))
  }
  // T161 (заказ Основателя 15.11 «время есть, а задач в списке нет»): пустая
  // очередь НЕ рисует сиротскую шапку с горизонтом — план открытого списка
  // живёт в шапке ИНСТАНСЫ (T161), а задачи — в своих секциях (В РАБОТЕ/🔔/⛔).
  // Исключение: секции ИНСТАНСЫ нет вовсе (нет вкладок/агентов) — тогда ⚡ шапка
  // остаётся единственным носителем строки времени (кейс T104(3)).
  const hasInstances = tabViews.length > 0 || agents.length > 0 || settled.length > 0
  if (queue.length > 0 || (open.length > 0 && !hasInstances)) {
    // T85(2): шапка очереди несёт горизонт батча (по волнам) — параллелизм =
    // живые агенты консоли на момент рендера.
    // T104(3): строка времени живёт по всему открытому списку и рисуется, пока
    // есть что делать (очередь пустеет → строка остаётся, просто без строк задач).
    const queueBlocks: string[] = []
    for (let i = 0; i < queue.length; i++) {
      const t = queue[i]
      queueBlocks.push(...describeTaskBlock(t, all, ledger.agents, ledger.tabs))
      if (i < queue.length - 1) queueBlocks.push("") // empty line between blocks
    }
    sections.push(
      [queueHeader(open, ledger.agents, agents.length), ...queueBlocks].join("\n"),
    )
  }
  // Завершённое (задачи и агенты) в ui не показывается — консоль = живое
  // состояние (Founder order 04.10.2026); история остаётся в ledger.
  if (blocked.length > 0) {
    sections.push(
      [
        "⛔ ЗАБЛОКИРОВАНО",
        ...blocked.map((t) => {
          const p = progressOf(t, all)
          const mark = t.parent ? "↳" : "●"
          const ind = t.parent ? `${TAB_INDENT}  ` : TAB_INDENT // T89: как в других секциях
          // T70: инстанс сразу за id — глаз на «в каком окне ждёт» раньше текста.
          return `${ind}${mark} [${t.id}]${p ? ` ${bar(p)}` : ""}${waitingIn(t, ledger.tabs)} ${clip(t.task, MAX_TASK_CHARS)}${t.why ? ` — ${clip(t.why, MAX_WHY_CHARS)}` : ""}`
        }),
      ].join("\n"),
    )
  }
  if (gates.length > 0) {
    sections.push(
      ["🔔 РЕШЕНИЕ ОСНОВАТЕЛЯ", ...gates.map((t) => `  ● [${t.id}] ${clip(t.why ?? "", MAX_WHY_CHARS)}`)].join("\n"),
    )
  }

  // 💬 ЧАТ (T57): последние строки из AGENT_CHAT.md
  // Читаем хвост файла относительно state.json (путь не в ледегере)
  const chatLines = readChatLines(stateFile)
  if (chatLines.length > 0) {
    sections.push(["💬 ЧАТ", ...chatLines.map((l) => `  ${l}`)].join("\n"))
  }

  // 🌍 ЧУЖИЕ (T62): foreign sessions from other projects - collapsed single line at bottom
  // These are tracked but never shown as tabs in the main section
  // Only show if there are active foreign sessions (seen within TTL)
  // We pass foreign sessions from ledger.foreign_sessions to renderConsoleHtml
  // The actual rendering of the collapsed line is done in renderConsoleHtml

  const body = sections.length > 0 ? sections.join("\n\n") : "  — журнал пуст —"
  const ui = `${HEADER}\n${body}`

  return { tasks, active: doing, agents, blocked, gates, done, ui }
}

// Service info about WHERE this console runs (T59, Founder order): the pane of
// each folder must be distinguishable — browser tab title + a compact header.
// Everything is optional: the core renders honestly with what the runtime has.
export interface PaneLocation {
  name?: string | null // имя папки/репозитория
  path?: string | null // полный путь
  branch?: string | null // git-ветка (ctx.vcs.get)
  remote?: string | null // git-remote (что доступно)
}

// Live console pane: the plugin writes this HTML next to state.json on every
// ledger save; the Founder's Review pane reloads it every 2 seconds (meta
// refresh) — a dashboard that stays current with no tool call. Pure function.
export const renderConsoleHtml = (
  ui: string,
  updatedAt: string,
  agents: { id?: string; began_at: string; eta_min: number; task_id?: string | null }[] = [],
  loc: PaneLocation | null = null,
  channel: PanelChannel | null = null,
  allTasks: Task[] = [], // T39: needed for plan markers (children est_min)
  foreignSessions: ForeignSession[] = [], // T62: foreign sessions for collapsed line
  complaints: Complaint[] = [], // T124: канал жалоб на фреймворк
): string => {
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  // <title> = «DEV CONSOLE · <имя папки>»: вкладки браузера с разными
  // консолями различаются при листании. Без локации — прежний заголовок.
  const name = typeof loc?.name === "string" ? loc.name.trim() : ""
  const title = name === "" ? BRAND : `DEV CONSOLE · КОРПОРАЦИЯ ЯСНОСТЬ · ${name}`
  // Компактная шапка в теле панели: 📁 <имя> · <путь> · <ветка> · <remote> —
  // только то, что есть (ветка/remote могут быть недоступны).
  const head = [loc?.name, loc?.path, loc?.branch, loc?.remote]
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x) => x !== "")
  // T164 (заказ Основателя 15.11): кнопка «⏻ мониторы» живёт В ОДНОЙ СТРОКЕ с
  // шапкой панели (раньше была отдельной строкой после блок-div «📁 …»).
  // Семантика T138-кнопки отменена заказом: гасим ЭКРАНЫ (спящий режим
  // дисплеев), CPU-мониторы живут. Без шапки — кнопка своей строкой.
  const moBtn =
    `<button id="moBtn" title="T164: погасить экраны как при спящем режиме (свет можно выключить); CPU-мониторы живут" style="padding:2px 10px; font-size:12px; cursor:pointer; background:#161b22; color:#ffa657; border:1px solid #30363d; border-radius:6px; white-space:nowrap;">⏻ мониторы</button>`
  const locLine =
    head.length > 0
      ? `<div id="loc" style="display:flex; align-items:center; gap:10px; max-width:80%;">${moBtn}<span style="overflow-wrap:anywhere;">📁 ${head.map(esc).join(" · ")}</span></div>\n`
      : `<div style="display:flex; justify-content:flex-start; padding:0 10px;">${moBtn}</div>\n`
  // T62: foreign sessions - interactive collapsible section at bottom
  // Foreign sessions NEVER appear as tabs in main section. Panel shows one collapsed line:
  // "🌍 ЧУЖИЕ: N работают ▸" → click expands to show only ACTIVE foreign sessions
  // → click row = blink tab via T60 channel → click header again collapses
  let foreignSectionHtml = ""
  let foreignSectionJs = ""
  if (foreignSessions && foreignSessions.length > 0) {
    const count = foreignSessions.length
    const now = Date.now()
    const FOREIGN_TTL_MS = 5 * 60 * 1000
    const activeSessions = foreignSessions.filter(f => now - f.last_seen < FOREIGN_TTL_MS)
    const activeCount = activeSessions.length
    const totalTitles = foreignSessions.map(f => esc(f.title)).join(", ")
    const activeTitles = activeSessions.map(f => esc(f.title)).join(", ")
    
    // Build the collapsible HTML section
    foreignSectionHtml = `
<div id="foreign" style="margin-top:20px; border-top:1px solid #30363d; padding-top:12px;">
  <div id="foreign-header" class="foreign-header" style="cursor:pointer; color:#ffa657; font-weight:bold; user-select:none;"
       title="клик — развернуть/свернуть список чужих сессий">
    🌍 ЧУЖИЕ: ${count} работают ▸ (активно: ${activeCount})
  </div>
  <div id="foreign-list" class="foreign-list" style="display:none; margin-top:8px; font-size:13px; color:#8b949e;">
    ${activeCount > 0 ? activeSessions.map(f => 
      `<div class="foreign-row" data-ses="${esc(f.session_id)}" 
           style="cursor:pointer; padding:4px 8px; margin:2px 0; background:#161b22; border:1px solid #30363d; border-radius:4px;"
           title="клик — мигнуть вкладкой (blink через T60 канал)">
        ${esc(f.title)} · ${new Date(f.last_seen).toTimeString().slice(0,5)}
      </div>`
    ).join("") : '<div style="padding:8px; color:#484f58;">нет активных чужих сессий (TTL 5 мин)</div>'}
    <div style="margin-top:8px; padding:4px; font-size:11px; color:#484f58; border-top:1px solid #30363d;">
      Все отслеживаемые (${count}): ${totalTitles}
    </div>
  </div>
</div>`
    
    // JavaScript for collapsible + blink via T60 channel
    // T104(2): панель перезагружается целиком (meta refresh 10с, 5→10 на 24.10) — раскрытие
    // списка обязано пережить ререндер. Правда живёт в localStorage; если он
    // закрыт (file:// / чужой origin), фолбэк — location.hash, который
    // meta-refresh сохраняет тоже. Состояние читается ДО первых кликов и
    // применяется сразу (header ▾/▸ и display — из одной памяти).
    foreignSectionJs = `
// T62 + T104(2): foreign sessions collapsible + blink (раскрытие помнит панель)
const foreignHeader = document.getElementById("foreign-header");
const foreignList = document.getElementById("foreign-list");
if (foreignHeader && foreignList) {
  const FKEY = "lavk-console-foreign-expanded";
  let foreignExpanded = false;
  try {
    const saved = localStorage.getItem(FKEY);
    if (saved !== null) foreignExpanded = saved === "1";
  } catch (e) {}
  if (!foreignExpanded && /(?:^|#)foreign=open/.test(location.hash)) foreignExpanded = true;
  function paintForeign() {
    foreignList.style.display = foreignExpanded ? "block" : "none";
    foreignHeader.textContent = "🌍 ЧУЖИЕ: ${count} работают " + (foreignExpanded ? "▾" : "▸") + " (активно: ${activeCount})";
  }
  function rememberForeign() {
    try { localStorage.setItem(FKEY, foreignExpanded ? "1" : "0"); } catch (e) {}
    try { history.replaceState(null, "", foreignExpanded ? "#foreign=open" : "#"); } catch (e) {}
  }
  paintForeign();
  foreignHeader.addEventListener("click", function() {
    foreignExpanded = !foreignExpanded;
    rememberForeign();
    paintForeign();
  });
  // Delegate clicks on foreign rows to blink via T60 channel
  foreignList.addEventListener("click", function(ev) {
    const row = ev.target.closest(".foreign-row");
    if (row && row.dataset.ses && CH) {
      const ses = row.dataset.ses;
      fetch(CH + "/blink", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: ses }),
      }).then(function(r) {
        if (r.ok) {
          row.style.background = "#3fb950";
          row.style.color = "#0d1117";
          setTimeout(function() { row.style.background = ""; row.style.color = ""; }, 300);
        }
      }).catch(function() {});
      // Collapse after blink — тоже через память, иначе снова свёрнется на ререндере
      foreignExpanded = false;
      rememberForeign();
      paintForeign();
    }
  });
}`
  }
  // T124: секция жалоб на фреймворк — хранилище + дедуп + UI-проекция
  const complaintsSectionHtml = formatComplaintsSection(complaints)
  // Embed lines as a JS array; `<` escaped so hostile task text cannot close the script tag.
  const rows = ui.split("\n")
  const lines = JSON.stringify(rows).replace(/</g, "\\u003c")
  // T165: задачи с актом (DONE) — их теги в хвосте строк инстанса окрашиваем
  // зелёным при рендере групп «·» (на клиенте, через DONE_IDS).
  const doneIdsJson = JSON.stringify([...allTasks.filter((t) => t.state === "DONE").map((t) => t.id)]).replace(
    /</g,
    "\\u003c",
  )
  // Live countdown (Founder: «время в панели реально обратно отсчитывалось»):
  // каждый токен времени несёт в страницу свою базу и тикает сам, независимо
  // от записей леджера. T69 → T64: план демоны привязывается по имени записи
  // (и по id — ключи в map оба) — строки сгруппированы по инстансам, порядок
  // массива агентов другой, позиционное паривание врало бы отсчётом; таймеры
  // шапки считаются по всем живым сразу.
  const valid = agents.filter((a) => Number.isFinite(Date.parse(a.began_at)))
  // Планы параллельны → шапке нужен дедлайн самого долгого, не сумма (темп 1).
  const dls = valid.map((a) => Date.parse(a.began_at) + a.eta_min * 60000)
  const dl = dls.length > 0 ? Math.max(...dls) : null
  const started = valid.length > 0 ? Math.min(...valid.map((a) => Date.parse(a.began_at))) : null
  const byId = new Map<string, { t0: number; eta: number }>()
  for (const a of valid) {
    if (!a.id) continue
    const plan = { t0: Date.parse(a.began_at), eta: a.eta_min }
    byId.set(a.id, plan) // id записи — машинный ключ (логи, occupancy)
    byId.set(demonName(a.id), plan) // строка демона несёт его имя (T64)
    if (a.label) byId.set(a.label, plan)
  }
  // T74(1): план, привязанный к задаче — строка вкладки несёт текущую задачу
  // («в задаче T72 ⏱8м»), поэтому её индекс строки → t0/eta живого агента.
  // Несколько живых на одной задаче — самый ранний по финишу (как в строке вкладки).
  const byTask: Record<string, { t0: number; eta: number }> = {}
  for (const a of valid) {
    const tid = a.task_id
    if (typeof tid !== "string" || tid === "") continue
    const plan = { t0: Date.parse(a.began_at), eta: a.eta_min }
    const prev = byTask[tid]
    if (!prev || plan.t0 + plan.eta * 60000 < prev.t0 + prev.eta * 60000) byTask[tid] = plan
  }
  const eta: Record<string, { t0: number; eta: number }> = {}
  const timers: Record<string, { dl: number; rate: number; run: number }> = {}
  rows.forEach((l, i) => {
    // Шапка секции инстансов (T69): ⏳ = дедлайн самого долгого живого агента
    // (планы параллельны → ждём последний, темп 1), ⏱ = с самого раннего
    // начала (нарастает); своим строкам ничего не отдаёт.
    if (l.startsWith(INSTANCES)) {
      if (dl !== null && started !== null) timers[i] = { dl, rate: 1, run: started }
      return
    }
    // Строка демона (T71): маркер — свой эмодзи из палитры или фолбэк ▸.
    const m = DAEMON_ROW.exec(l)
    const plan = m ? byId.get(m[1]) : undefined
    if (plan) {
      eta[i] = plan
      return
    }
    // T85(1): занятая строка задачи (T74(2), «🔒A40 работает ⏱…») — её остаток
    // тикает тем же mm:ss: план берётся по задаче (та же база, что у строки
    // вкладки); строки без остатка (свободная, settle) в ETA не попадают.
    const tk = /^\s*[●↳] \[(T\d+)\]/.exec(l)
    const tp = tk ? byTask[tk[1]] : undefined
    if (tp && /⏱\+?\d/.test(l)) {
      eta[i] = tp
      return
    }
    // Строка вкладки с текущей задачей (T74-1): отсчёт тикает по плану живого
    // агента этой задачи; задача без плана в ETA не попадает (⏱ в строке нет).
    const cw = /в задаче (T\d+)\s+⏱/.exec(l)
    const cur = cw ? byTask[cw[1]] : undefined
    if (cur) eta[i] = cur
  })
  // T38: embed plan data for parent tasks with children est_min (client-side ticker)
  const planData: Record<string, { totalEst: number; createdAt: number; kidsDone: number; kidsTotal: number }> = {}
  rows.forEach((l, i) => {
    // Parent task rows in ⚡ ЗАДАЧИ or 🔄 В РАБОТЕ sections
    const pt = /^\s*[●↳] \[(T\d+)\]/.exec(l)
    if (pt) {
      const taskId = pt[1]
      const task = allTasks.find((t) => t.id === taskId)
      if (task && !task.parent) {
        const kids = allTasks.filter((c) => c.parent === taskId && typeof c.est_min === "number" && c.est_min !== null && c.est_min > 0)
        if (kids.length > 0) {
          const totalEst = kids.reduce((sum, c) => sum + (c.est_min ?? 0), 0)
          const createdAt = Date.parse(task.created_at)
          const kidsDone = kids.filter((c) => c.state === "DONE").length
          if (Number.isFinite(createdAt) && totalEst > 0) {
            planData[i] = { totalEst, createdAt, kidsDone, kidsTotal: kids.length }
          }
        }
      }
    }
  })
  const etaJson = JSON.stringify(eta).replace(/</g, "\\u003c")
  const timersJson = JSON.stringify(timers).replace(/</g, "\\u003c")
  const planDataJson = JSON.stringify(planData).replace(/</g, "\\u003c")
  // Маркеры строк (T71): палитры не пересекаются → класс строки панели решает
  // первый токен: свой эмодзи инстанса/демона, фолбэк 🤖/▸.
  const marksJson = JSON.stringify({ tab: INSTANCE_MARKS, bot: DAEMON_MARKS })
  // Канал T60: свой localhost-сервер плагина вшивается в страницу целиком —
  // порт (null = канала нет, кнопки не рендерятся) и session_id строк инстансов
  // в порядке их появления в ui (projectTabs — та же сортировка, что у строк).
  // Клик по строке → POST /blink (toggle мигания), кнопка ⚡ → POST /wake;
  // GET /probe страница шлёт сама — в подвале канал рисует ✓/✗.
  const port = typeof channel?.port === "number" && channel.port > 0 ? channel.port : null
  const tabIds = (channel?.tabIds ?? []).filter((x) => typeof x === "string" && x.startsWith("ses_"))
  const portJson = JSON.stringify(port)
  const tabIdsJson = JSON.stringify(tabIds).replace(/</g, "\\u003c")
  const instJson = JSON.stringify(INSTANCES)
  const chInit = port !== null ? `канал 127.0.0.1:${port} · проверяю…` : "канал: нет (T60)"
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="10">
<title>${esc(title)}</title>
<style>
  body { background:#0d1117; color:#c9d1d9; font:14px/1.45 Consolas,"Cascadia Mono",monospace; padding:20px; margin:0; }
  #loc { color:#8b949e; font-size:12px; margin:0 0 10px; }
  #wrap { border:1px solid #30363d; border-radius:10px; background:#161b22; padding:16px 20px; white-space:pre-wrap; }
  #ts { color:#484f58; font-size:11px; margin-top:10px; }
  .hd { color:#d29922; font-weight:bold; }
  .sec { color:#58a6ff; font-weight:bold; }
  .bot { color:#bc8cff; font-weight:bold; }
  .blk { color:#f85149; font-weight:bold; }
  .tab { color:#ffa657; font-weight:bold; }
  .tab.t-wait { color:#8b949e; font-weight:normal; }
  .tab.t-idle { color:#484f58; font-weight:normal; }
  .fin { color:#484f58; font-weight:normal; }
  /* T165: теги задач в хвосте строки инстанса ([T14], [T158 T159]) — зелёным,
     если задача закрыта (есть акт/DONE). */
  .done { color:#3fb950; }
  /* T74(5): бар принудительно тонкий (не наследует bold строки), ЦВЕТ НЕ
     задаётся — глифы наследуют цвет строки (оранжевый/серый/синий/фиолетовый). */
  .bar { font-weight:normal; }
  /* T60: строка инстанса кликабельна (клик = мигание), кнопка ⚡ отдельно =
     пробуждение. Глиф ⚡ даёт ::after, а не текст кнопки: текст строки должен
     кончаться на «· HH:MM», иначе elapsed-часики (initAgo) её не найдут. */
  .tab[data-ses] { cursor:pointer; }
  .tab[data-ses]:hover { text-decoration:underline dotted; }
  button.wake { background:#161b22; border:1px solid #30363d; border-radius:6px; color:#ffa657;
                font:11px/1 Consolas,monospace; padding:1px 6px; margin-left:7px; cursor:pointer; }
  button.wake::after { content:"⚡"; }
  button.wake:hover { background:#ffa657; color:#0d1117; }
  /* T106: видимая реакция кнопки на результат /wake — глиф ✓/✗ вместо ⚡
     (раньше результат жил только в строке статуса «канал: …» и был незаметен). */
  button.wake.ok::after { content:"✓"; }
  button.wake.ok { background:#238636; border-color:#2ea043; color:#fff; }
  button.wake.fail::after { content:"✗"; }
  button.wake.fail { background:#da3633; border-color:#f85149; color:#fff; }
  /* T43: drag-and-drop стили для строк задач */
  .sec[draggable="true"] { cursor:grab; }
  .sec[draggable="true"]:hover { background:rgba(88,166,255,0.1); }
  .sec.dragging { opacity:0.5; cursor:grabbing; background:rgba(88,166,255,0.2); }
  .sec[draggable="true"]::before { content:"⋮⋮ "; color:#484f58; font-weight:bold; margin-right:4px; opacity:0.5; }
  .sec.dragging::before { content:"⋮⋮ "; color:#58a6ff; opacity:1; }
  /* Подсказка когда канал недоступен */
  .no-channel-hint { color:#8b949e; font-size:11px; margin-top:4px; font-style:italic; }
  /* T120: смысловые группы «·» — перенос только между группами.
     Разделитель — ОТДЕЛЬНЫЙ элемент .sep с white-space: pre: между inline-block
     группами браузер схлопывал пробелы разделителя (жалоба 11.11 «пробелы
     поехали»). Висячий отступ continuation — padding-left по отступу строки
     (без text-indent: он сдвигал первую строку влево). */
  .g { display: inline-block; white-space: pre-wrap; }
  .sep { white-space: pre; }
  #wrap > div { max-width: 80%; overflow-wrap: break-word; }
</style>
</head>
<body>
${locLine}
<div id="wrap"></div>
${foreignSectionHtml}
${complaintsSectionHtml}
<div id="ts">авто-обновление 5с · состояние: ${esc(updatedAt)}${Number.isFinite(Date.parse(updatedAt)) ? ` <span class="ago" data-t0="${Date.parse(updatedAt)}">+0s</span>` : ""} · <span id="ch">${chInit}</span></div>
<script>
const lines = ${lines};
const ETA = ${etaJson};
const TIMERS = ${timersJson};
const PLAN = ${planDataJson};
const MARKS = ${marksJson};
// Канал T60: localhost-сервер плагина (порт вшит при рендере; null = канала нет).
const PORT = ${portJson};
const TABIDS = ${tabIdsJson};
const INST_H = ${instJson};
// T83: блок инстанса многоосевой — голова (эмодзи/🤖 на отступе секции) и оси
// под ней чистым отступом, без маркера (заказ Основателя 07.10 12:13: ось с
// 🤖 читалась как отдельный инстанс). Путь logOS.runtime.LUNA из рендера убран
// (метка сессии панели не нужна) — голова и есть маркер на отступе блока.
const CH = PORT === null ? null : "http://127.0.0.1:" + PORT;
const chEl = document.getElementById("ch");
function chSay(txt, ok) {
  if (!chEl) return;
  chEl.textContent = txt;
  // style — только в браузере (стаб для тестов DOM его не рисует)
  if (chEl.style) chEl.style.color = ok === undefined ? "#8b949e" : ok ? "#3fb950" : "#f85149";
}
// Живой проб («fetch из панели дошёл»): страница стучится на /probe каждой
// отрисовкой — сервер пишет это в DEVATA/panel_channel.json, а подвал рисует ✓/✗.
let channelAlive = false;
if (CH && typeof fetch === "function") {
  fetch(CH + "/probe?from=panel")
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function () {
      channelAlive = true;
      try { sessionStorage.setItem("devconsole_ch_reload", "0"); } catch (e) {}
      chSay("канал 127.0.0.1:" + PORT + " ✓", true);
      // T43 FIX: канал подтверждён — включаем drag на строках-кандидатах
      // (сборка строк уже выполнена к этому моменту: синхронный скрипт раньше)
      pendingT43.forEach(function (fn) { fn(); });
    })
    .catch(function () {
      channelAlive = false;
      // T140: канал недоступен — порт устарел (рестарт сервера выдаёт новый
      // эфемерный порт, а он запечён в HTML). Свежий HTML несёт актуальный
      // порт → перезагружаем вкладку ОДИН раз (не чаще 2 за сессию вкладки,
      // иначе при мёртвом плагине получим цикл перезагрузок).
      try {
        var tries = Number(sessionStorage.getItem("devconsole_ch_reload") || "0");
        if (tries < 2) {
          sessionStorage.setItem("devconsole_ch_reload", String(tries + 1));
          setTimeout(function () { location.reload(); }, 1500);
          chSay("канал устарел — обновляю порт…", false);
          return;
        }
      } catch (e) { /* sessionStorage недоступен — просто покажем подсказку */ }
      chSay("канал 127.0.0.1:" + PORT + " ✗ недоступен", false);
      // T43: показать подсказку про недоступность drag-and-drop (только в реальном браузере)
      if (typeof document !== "undefined" && document.getElementById && document.getElementById("ts")?.appendChild) {
        const hint = document.createElement("div");
        hint.className = "no-channel-hint";
        hint.textContent = "Drag-and-drop недоступен: канал записи не работает (проверьте панель-плагин)";
        document.getElementById("ts")?.appendChild(hint);
      }
    });
} else {
  channelAlive = false;
  chSay("канал: нет (T60)", false);
  if (typeof document !== "undefined" && document.getElementById && document.getElementById("ts")?.appendChild) {
    const hint = document.createElement("div");
    hint.className = "no-channel-hint";
    hint.textContent = "Drag-and-drop недоступен: канал записи не настроен";
    document.getElementById("ts")?.appendChild(hint);
  }
}
// T164 (заказ Основателя 15.11): кнопка «⏻ мониторы» → POST /monitors-off —
// гасит ЭКРАНЫ (спящий режим дисплеев). Кнопка многоразовая: после пробуждения
// экраны можно гасить снова (авто-обновление и так вернёт текст).
const moBtn = document.getElementById("moBtn");
if (moBtn && CH && typeof moBtn.addEventListener === "function") {
  moBtn.addEventListener("click", function () {
    const ac2 = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t2 = ac2 ? setTimeout(function () { ac2.abort(); }, 4000) : null;
    moBtn.textContent = "⏻ гашу…";
    fetch(CH + "/monitors-off", { method: "POST", signal: ac2 ? ac2.signal : undefined })
      .then(function (r) { if (t2) clearTimeout(t2); if (!r.ok) throw r.status; return r.json(); })
      .then(function () {
        moBtn.textContent = "⏻ погасились ✓";
        chSay("экраны погашены (CPU-мониторы живут)", true);
        setTimeout(function () { moBtn.textContent = "⏻ мониторы"; }, 3000);
      })
      .catch(function () { if (t2) clearTimeout(t2); moBtn.textContent = "⏻ мониторы"; chSay("экраны: канал недоступен", false); });
  });
}
// T62: foreign sessions collapsible + blink
${foreignSectionJs}
// POST в плагин: клик по строке инстанса = /blink (toggle мигания title в
// сайдбаре OpenCode), кнопка ⚡ = /wake (synthetic со списком её незакрытых задач).
function chan(path, ses, btn) {
  if (!CH) { chSay("канал: нет — кнопка не работает", false); flash(btn, false, "канал не подтверждён"); return; }
  // T106: таймаут 4с — зависший fetch больше не молчит (раньше запрос висел
  // вечно, статус не обновлялся, и кнопка выглядела «не работающей» без слов).
  const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ac ? setTimeout(function () { ac.abort(); }, 4000) : null;
  fetch(CH + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: ses }),
    signal: ac ? ac.signal : undefined,
  })
    .then(function (r) {
      if (timer) clearTimeout(timer);
      if (r.ok) { chSay("канал 127.0.0.1:" + PORT + " ✓ " + path, true); flash(btn, true, "ok"); return null; }
      // T106: текст ошибки сервера — в статус и в тултип кнопки (раньше: «http 500»).
      return r.text().then(function (t) {
        let m = "http " + r.status;
        try { const j = JSON.parse(t); if (j && j.error) m = r.status + " · " + j.error; } catch (e) { /* не JSON */ }
        chSay("канал 127.0.0.1:" + PORT + " ✗ " + path + " " + m, false);
        flash(btn, false, m);
      });
    })
    .catch(function (err) {
      if (timer) clearTimeout(timer);
      const m = err && err.name === "AbortError" ? "таймаут 4с — канал не ответил" : "недоступен";
      chSay("канал 127.0.0.1:" + PORT + " ✗ " + path + " " + m, false);
      flash(btn, false, m);
    });
}
// T106: реакция самой кнопки — глиф ✓/✗ (CSS-класс) на 1.4с + тултип с причиной.
function flash(btn, ok, msg) {
  if (!btn) return;
  btn.classList.toggle("ok", ok);
  btn.classList.toggle("fail", !ok);
  btn.title = ok ? "пробуждение отправлено" : "не сработало: " + msg;
  setTimeout(function () {
    btn.classList.remove("ok", "fail");
    btn.title = "пробудить вкладку: synthetic со списком её незакрытых задач";
  }, 1400);
}
const escText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// T120: расшифровка смысловой группы «·» для тулпита строки панели
function groupTitle(seg) {
  const s = (seg || "").trim()
  if (!s) return ""
  if (/^⏱\\+?\\d/.test(s)) return "переработка свыше плана (T128, ⏱+Nм)"
  if (/^⏱/.test(s)) return "остаток плана текущей задачи (ETA, ⏱Nм)"
  if (/^Δ/.test(s)) return "план/факт (Δ = план ÷ факт, <1 быстрее плана)"
  if (/^⚠$/.test(s)) return "пустой прогон или ранний settle"
  if (/^\\+\\d+$/.test(s)) return "инжекты контекста (+N)"
  if (/^\\[T\\d/.test(s)) return "открытые задачи инстанса ([Txxx])"
  if (/^в задаче /.test(s)) return "текущая задача живого агента"
  if (/^▰/.test(s)) return "готово / всего задач инстанса (▰▰▱ N/M)"
  if (/^(mimo|glm|nemotron|deepseek|gemini|claude)/i.test(s)) return "модель агента вкладки"
  if (/^\\d{2}:\\d{2}$/.test(s)) return "время последнего контакта (HH:MM)"
  // T120(б): расшифровки для секций ЗАДАЧИ/агенты (остаток 11.11)
  if (/^(WAIT|DOING|BLOCKED|GATE|DONE)$/.test(s)) return "статус задачи в леджере (WAIT=в очереди, GATE=ждёт решения Основателя)"
  if (/^⏳/.test(s)) return "дедлайн плана (⏳~время, темп 1)"
  if (/^repo:/.test(s)) return "накопленная работа по repo (numstat: строки diff за жизнь)"
  if (/^A\\d+$/.test(s)) return "запись агента в леджере (A##)"
  return ""
}
const DONE_IDS = new Set(${doneIdsJson})
const colorTaskTags = (seg) => {
  let out = seg
  for (const id of DONE_IDS) {
    const open = "[" + id + "]"
    let idx = out.indexOf(open)
    while (idx >= 0) {
      const end = out.indexOf("]", idx + 1)
      if (end < 0) break
      const inserted = '<span class="done">' + out.slice(idx, end + 1) + "</span>"
      out = out.slice(0, idx) + inserted + out.slice(end + 1)
      idx = out.indexOf(open, idx + inserted.length)
    }
  }
  return out
}
const wrap = document.getElementById("wrap");
// T43 FIX (рецензия оркестратора): усиление строк (data-task-id/draggable)
// стояло СИНХРОННО при сборке, а channelAlive флипается только асинхронно в
// .then проба — гейт был всегда false, drag не включался НИКОГДА. Кандидаты
// копим здесь, включаем после успешного проба канала.
const pendingT43 = [];
let tabRow = 0; // сколько строк инстанса уже отдано из TABIDS (T60)
let inTab = false; // голова блока инстанса пройдена — следующие оси его (T83)
// FIX T43: строки добавляем ЖИВЫМИ узлами (appendChild), не через innerHTML-
// строку: round-trip подменял элементы после построения — все слушатели на d
// (клик /blink, кнопка ⚡ /wake, drag-handlers) висели на отсоединённых копиях
// и до живого DOM не доходили; pendingT43-замыкания держали бы мёртвые узлы.
const rowEls = lines.map((l, i) => {
  let cls = "";
  let ses = null; // session_id строки инстанса — адресат кликов (T60)
  // T89 (цвета + табуляция, заказ Основателя 07.10: «слилось все»): класс
  // вешается по СМЫСЛУ (trimStart), уровень — по ШИРИНЕ отступа. Прежние
  // проверки шли по неотступленному startsWith: после многострочного формата
  // (оси, задачи с отступом) они не ловили ничего — панель становилась
  // одноцветной. Уровни: секция 0 → инстанс 2 → оси блока 4 → демоны 6;
  // задачи секции 2, их ↳-дети 4.
  const raw = l.trimStart();
  const ind = l.length - raw.length; // ширина отступа = уровень иерархии
  const mark = raw.split(" ")[0]; // первый токен = маркер строки (T71)
  const tm = /· (простаивает|ждёт ⏳)(?= ·|$)/.exec(l); // честный статус строки (T73; T156: статус теперь КОНЕЦ оси-1 — хвост без «·»)
  const statusCls = tm ? (tm[1] === "простаивает" ? " t-idle" : " t-wait") : "";
  if (raw.startsWith("━━")) {
    cls = "hd";
    inTab = false;
  } else if (raw.startsWith(INST_H) || raw.startsWith("🔄") || raw.startsWith("⚡") || raw.startsWith("🔔")) {
    cls = "sec"; // T89: ВСЕ шапки секций видны цветом (⚡/🔔 раньше терялись)
    inTab = false;
  } else if (raw.startsWith("⛔")) {
    cls = "blk";
    inTab = false;
  } else if (MARKS.bot.includes(mark)) {
    cls = "bot"; // демоны вложены (T69): свой эмодзи или ▸ (T71)
    inTab = false;
  } else if (mark === "✓") {
    cls = "fin"; // T74(3): недавно завершённый — тусклая строка
    inTab = false;
  } else if (ind === 2 && MARKS.tab.includes(mark)) {
    // Голова блока инстанса (T89: отступ 2). session_id достаётся ТОЛЬКО ей —
    // оси клик не воруют, счётчик tabRow не съезжает (T60 + T83).
    cls = "tab" + statusCls;
    inTab = true;
    ses = TABIDS[tabRow++] || null;
  } else if (inTab && ind === 4) {
    cls = "tab" + statusCls; // ось блока (T83/T89): отступ 4, маркера нет
  } else {
    inTab = false; // строка вне блока (задача/чужая секция) закрывает его
    if (raw.startsWith("●") || raw.startsWith("↳")) cls = "sec"; // задачи: синий
  }
  const d = document.createElement("div");
  d.className = cls;
  // T120: висячий отступ ПРОДОЛЖЕНИЯ — по собственному отступу строки:
  // отступ живёт в CSS (padding-left), в тексте его нет (raw без ведущих
  // пробелов) → первая строка и перенос выровнены по одному краю, колонки не
  // разъезжаются. Стаб-DOM в тестах не умеет style — гард обязателен.
  if (ind > 0 && d.style) {
    d.style.paddingLeft = ind + "ch";
  }
  // T74(5): токен бара оборачивается — глифы не наследуют bold строки, ширина
  // не сливается; ЦВЕТ НЕ задаётся: .bar только снимает жирность и наследует
  // цвет строки (оранжевый/серый у вкладки, синий у задач, фиолетовый у агентов).
  // Текст строки — БЕЗ ведущих пробелов (raw): отступ живёт в CSS (padding-left),
  // иначе он удваивался бы (текстовый + CSS) и колонки разъезжались бы.
  const body = escText(raw).replace(/([▰▱]{5})\\s+\\d+\\/\\d+/, '<span class="bar">$&</span>');
  const t = TIMERS[i];
  const e = ETA[i];
  if (t) {
    // Шапка ИНСТАНСЫ (T69 → T85): ⏳ = дедлайн самого долгого живого агента
    // (темп 1 — планы параллельны, не суммируются), ⏱ = нарастающее время работы
    // (нет data-eta → счётчик вверх); глиф сохраняет свой токен. Обе ветви
    // узнают и прежние «Nм», и новый mm:ss/h:mm:ss (T85: секунда видна).
    d.innerHTML = body
      .replace(
        /⏳\\+?(?:[\\d.]+м|\\d+:\\d\\d(?::\\d\\d)?)/,
        '<span class="eta" data-glyph="⏳" data-dl="' + t.dl + '" data-rate="' + t.rate + '">$&</span>',
      )
      .replace(
        /⏱\\+?[\\d.]+м/,
        '<span class="eta" data-glyph="⏱" data-t0="' + t.run + '">$&</span>',
      );
  } else if (e) {
    d.innerHTML = body.replace(
      /⏱\\+?(?:[\\d.]+м|\\d+:\\d\\d(?::\\d\\d)?)/,
      '<span class="eta" data-glyph="⏱" data-t0="' + e.t0 + '" data-eta="' + e.eta + '">$&</span>',
    );
  } else {
    d.innerHTML = body || " ";
  }
  // T120: смысловые группы «·» как инлайн-блоки — перенос только между группами
  // (>80% ширины консоли), каждая группа с тултипом-расшифровкой; вся строка
  // доступна как title (читаемая копия: [Txxx] + TITLE не отваливаются).
  // Работа СТРОКОВАЯ (без DOM-обхода): стаб-DOM в тестах не умеет childNodes.
  // Разделитель — ОТДЕЛЬНЫЙ span.sep (white-space: pre): между inline-block
  // группами браузер схлопывал пробелы разделителя (11.11 «пробелы поехали»).
  const grouped = body
    .split(" · ")
    .map((seg, i) => {
      const tt = groupTitle(seg)
      const gseg = colorTaskTags(seg)
      const g = '<span class="g"' + (tt ? ' title="' + escText(tt) + '"' : "") + ">" + gseg + "</span>"
      return i === 0 ? g : '<span class="sep"> · </span>' + g
    })
    .join("");
  if (grouped !== body) {
    if (t) {
      d.innerHTML = grouped
        .replace(
          /⏳\\+?(?:[\\d.]+м|\\d+:\\d\\d(?::\\d\\d)?)/,
          '<span class="eta" data-glyph="⏳" data-dl="' + t.dl + '" data-rate="' + t.rate + '">$&</span>',
        )
        .replace(
          /⏱\\+?[\\d.]+м/,
          '<span class="eta" data-glyph="⏱" data-t0="' + t.run + '">$&</span>',
        );
    } else if (e) {
      d.innerHTML = grouped.replace(
        /⏱\\+?(?:[\\d.]+м|\\d+:\\d\\d(?::\\d\\d)?)/,
        '<span class="eta" data-glyph="⏱" data-t0="' + e.t0 + '" data-eta="' + e.eta + '">$&</span>',
      );
    } else {
      d.innerHTML = grouped || " ";
    }
  }
  d.title = raw
  // T120(а) 15.11: буфер копирования. raw строки хранится в data-raw — у строк
  // вкладок title перетирается хинтом клика («клик — мигание…») и [Txxx]+TITLE
  // пропадали из читаемой копии. Двойной клик кладёт raw в буфер целиком
  // (navigator.clipboard, фолбэк execCommand) — копия не зависит от селекции
  // inline-block групп.
  if (d.dataset) d.dataset.raw = raw
  if (typeof d.addEventListener === "function") d.addEventListener("dblclick", function () {
    const txt = d.dataset.raw || d.title || ""
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).catch(function () {
        try {
          const ta = document.createElement("textarea")
          ta.value = txt
          document.body.appendChild(ta)
          ta.select()
          document.execCommand("copy")
          ta.remove()
        } catch (e2) {
          /* буфер недоступен — тултип остаётся читаемой копией */
        }
      })
    }
  })
  // T60: строка вкладки кликабельна (клик → POST /blink, toggle мигания в
  // сайдбаре OpenCode), кнопка ⚡ отдельно (→ POST /wake). Пустая кнопка с
  // глифом из CSS ::after — текст строки остаётся «… · HH:MM», чтобы не
  // сбить elapsed-часики (initAgo) с конца строки.
  if (ses && PORT !== null) {
    d.dataset.ses = ses;
    d.title = "клик — мигание вкладки · ⚡ — пробудить · 2×клик — копировать строку";
    d.addEventListener("click", function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest(".wake")) return;
      chan("/blink", ses);
    });
    const b = document.createElement("button");
    b.className = "wake";
    b.type = "button";
    b.title = "пробудить вкладку: synthetic со списком её незакрытых задач";
    b.setAttribute("aria-label", b.title);
    b.addEventListener("click", function (ev) {
      ev.stopPropagation();
      chan("/wake", ses, b);
    });
    d.appendChild(b);
  }
  // T43: drag-and-drop для строк задач (● и ↳) в секциях ⚡ ЗАДАЧИ и 🔄 В РАБОТЕ
  // Интерактив включается только после подтверждения канала (см. pendingT43).
  // FIX: regex — со ВТОРЫМИ слэшами: одиночные внутри template literal
  // съедаются IdentityEscape (в страницу уходил regex с пропавшими слэшами).
  const taskMatch = raw.match(/^[●↳]\\s+\\[(T\\d+)\\]/);
  if (taskMatch) {
    pendingT43.push(function () {
    d.dataset.taskId = taskMatch[1];
    d.dataset.ind = String(ind); // FIX T43: исходный отступ строки — для обхода блока при drop
    d.draggable = true;
    d.style.cursor = "grab";
    // Находим parent задачи (если есть)
    const parentMatch = raw.match(/parent:\\s*(\\S+)/); // не используется, parent определяется из данных
    // parent будет определен через все задачи с тем же parent при drop
    d.addEventListener("dragstart", function (ev) {
      if (!ev.dataTransfer) return;
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", taskMatch[1]);
      d.classList.add("dragging");
    });
    d.addEventListener("dragend", function () {
      d.classList.remove("dragging");
    });
    d.addEventListener("dragover", function (ev) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      const dragging = document.querySelector(".dragging");
      if (dragging && dragging !== d) {
        const rect = d.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (ev.clientY < midY) {
          d.parentNode.insertBefore(dragging, d);
        } else {
          d.parentNode.insertBefore(dragging, d.nextSibling);
        }
      }
    });
    d.addEventListener("drop", function (ev) {
      ev.preventDefault();
      d.classList.remove("dragging");
      // Собираем новый порядок задач с тем же parent
      // Задачи сгруппированы: корневые (отступ 2) и дети каждого родителя (отступ 4 под своим родителем)
      // Находим все строки задач в этом же "блоке" (до следующей секции или корневой задачи другого уровня)
      // FIX T43 (рецензия оркестратора, два дефекта): (1) NodeList [#wrap > div.sec
      // [data-task-id]] ПРОПУСКАЕТ заголовки секций → обход «по отступу» переходил
      // из ⚡ ЗАДАЧИ в 🔄 В РАБОТЕ (все корни с одинаковым отступом) и collect
      // смешивал WAIT с DOING → сервер 400 «не в очереди»; (2) индент брался из
      // leading-ws outerHTML — у программно собранных строк он 0, первое же
      // сравнение рвало блок → block=[d] → taskIds.length=1 → POST не уходил
      // НИКОГДА (drop был тихим no-op). Теперь: отступ лежит в data-ind (кладётся
      // при рендере), обход — по прямым соседям: строка без data-task-id (заголовок
      // секции) рвёт блок, строка другого отступа (родитель) рвут блок детей.
      // FIX T43 (живой E2E): дети (ind больше) теперь ПРОПУСКАЮТСЯ, а не рвут
      // блок — в списке корни идут вперемешку со своими ↳-детьми, старый обход
      // обрывался на первом ребёнке и POST уходил неполной группой (400 «не
      // перестановка всех задач»): с T33 вниз шли T62 → стоп.
      const kids = Array.prototype.slice.call(d.parentNode.children);
      const isTaskRow = function (el) { return !!(el && el.dataset && el.dataset.taskId); };
      const myIdx = kids.indexOf(d);
      if (myIdx === -1) return;
      const taskIndent = ind;
      const taskIds = [];
      const collect = function (start, dir) {
        for (let i = start; i >= 0 && i < kids.length; i += dir) {
          const el = kids[i];
          if (!isTaskRow(el)) break; // заголовок секции — граница блока
          const elInd = Number(el.dataset.ind);
          if (elInd === taskIndent) {
            if (dir < 0) taskIds.unshift(el.dataset.taskId);
            else taskIds.push(el.dataset.taskId);
          } else if (elInd > taskIndent) continue; // чужой ребёнок — мимо
          else break; // другой уровень (родитель/внук) — граница
        }
      };
      collect(myIdx, -1);
      collect(myIdx + 1, 1);
      if (taskIds.length > 1) {
        fetch(CH + "/order", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: TABIDS[0], task_ids: taskIds }),
        })
          .then(function (r) {
            if (r.ok) chSay("порядок обновлён ✓", true);
            else r.json().then(function (e) { chSay("ошибка порядка: " + (e.error || r.status), false); });
          })
          .catch(function () { chSay("канал недоступен при сохранении порядка", false); });
      }
    });
    });
  }
  return d;
});
rowEls.forEach(function (el) { wrap.appendChild(el); });

// Живой отсчёт: каждую секунду, без записи в леджер; просрочка — красным.
const p2 = (n) => String(n).padStart(2, "0");
function fmtEta(ms) {
  const over = ms < 0;
  const s = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600);
  const body = h
    ? h + ":" + p2(Math.floor((s % 3600) / 60)) + ":" + p2(s % 60)
    : p2(Math.floor(s / 60)) + ":" + p2(s % 60);
  return (over ? "+" : "") + body;
}
function tickEta() {
  if (document.hidden) return; // CPU (10.11): скрытая панель не тикает
  document.querySelectorAll(".eta").forEach((el) => {
    const ds = el.dataset;
    const ms =
      ds.dl !== undefined
        ? Number(ds.dl) - Number(ds.rate) * Date.now() // ⏳ шапки: дедлайн самого долгого, темп 1
        : ds.eta === undefined
          ? Date.now() - Number(ds.t0) // ⏱ шапки: нарастает с самого раннего начала
          : Number(ds.t0) + Number(ds.eta) * 60000 - Date.now(); // план демоны
    el.textContent = (ds.glyph || "⏱") + fmtEta(ms);
    el.style.color = ms < 0 ? "#f85149" : "#3fb950";
    el.style.fontWeight = "bold";
  });
}
tickEta();
setInterval(tickEta, 1000);

// T39: плановый маркер задач — тикает каждую секунду, обновляет позицию ▏ и подписи ⏱
function tickPlan() {
  if (document.hidden) return; // CPU (10.11): скрытая панель не тикает
  const now = Date.now();
  for (const [idx, pd] of Object.entries(PLAN)) {
    if (!pd) continue;
    const d = pd;
    const elapsedMin = Math.floor((now - d.createdAt) / 60000);
    const planPct = Math.max(0, Math.min(100, Math.floor((elapsedMin / d.totalEst) * 100)));
    const markerPos = Math.floor((planPct / 100) * 5);
    const marker = "▏".repeat(Math.min(markerPos, 5));
    const remainingMin = Math.max(0, d.totalEst - elapsedMin);
    // Find the row element and update its plan marker and label
    const row = document.querySelectorAll("#wrap > div")[Number(idx)];
    if (row) {
      // Update the plan marker (last ▏ sequence) and ⏱ label
      let html = row.innerHTML;
      // Update plan marker (▏ sequence)
      html = html.replace(/▏+$/, marker);
      // Update ⏱ label (e.g., "⏱18м" -> "⏱17м")
      html = html.replace(/⏱\\d+м/, "⏱" + remainingMin + "м");
      // CPU (10.11): пересборка innerHTML только при реальном изменении —
      // раньше DOM всех строк пересоздавался КАЖДУЮ секунду (постоянный repaint).
      if (html !== row.innerHTML) row.innerHTML = html;
    }
  }
}
tickPlan();
setInterval(tickPlan, 1000);

// Часики (заказ Основателя 07.10: «+s, +m:s — сколько прошло с того времени
// до сейчас»): у строки инстанса/демона, оканчивающейся на «· HH:MM», рядом с
// временем бежит elapsed — +45s → +4:12 → +1:04:33. Отдельный интервал, не
// смешивается с ETA-тикером; эпоха reconstructed из HH:MM (сегодняшняя дата,
// t0 > now → контакт был вчера). Старше суток покажет «сегодняшнее» время —
// известный предел v1 (строка хранит только HH:MM, без даты).
const fmtAgo = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return "+" + s + "s";
  const h = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  return h ? "+" + h + ":" + p2(mm) + ":" + p2(s % 60) : "+" + mm + ":" + p2(s % 60);
};
function initAgo() {
  document.querySelectorAll(".tab, .bot").forEach((d) => {
    const m = /· (\\d{1,2}:\\d{2})\\s*$/.exec(d.textContent);
    if (!m) return;
    const hm = m[1].split(":").map(Number);
    const now = Date.now();
    const cur = new Date(now);
    let t0 = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate(), hm[0], hm[1], 0, 0).getTime();
    if (t0 > now) t0 -= 86400000;
    d.insertAdjacentHTML(
      "beforeend",
      ' <span class="ago" data-t0="' + t0 + '">' + fmtAgo(now - t0) + "</span>",
    );
  });
}
function tickAgo() {
  if (document.hidden) return; // CPU (10.11): скрытая панель не тикает
  document.querySelectorAll(".ago").forEach((el) => {
    el.textContent = fmtAgo(Date.now() - Number(el.dataset.t0));
    el.style.color = "#3fb950";
    el.style.fontWeight = "bold";
  });
}
initAgo();
tickAgo();
setInterval(tickAgo, 1000);

// CPU (10.11): авто-обновление ТОЛЬКО ВИДИМОЙ панели. Скрытая вкладка (Chrome)
// и панель в десктопе больше не перезагружают тяжёлый DOM каждые 10с — это и
// грело GPU/рендерер. Мета-рефреш в <head> — аварийный предохранитель на час.
(function () {
  if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
  var RELOAD_MS = 10000;
  var last = Date.now();
  document.addEventListener("visibilitychange", function () { if (!document.hidden) last = Date.now(); });
  setInterval(function () {
    if (document.hidden || Date.now() - last < RELOAD_MS) return;
    last = Date.now();
    if (typeof location !== "undefined" && typeof location.reload === "function") location.reload();
  }, 1000);
})();
</script>
</body>
</html>
`
}

// ————— T135 · ДЕЛЬТЫ ДЛЯ get_state (гипотеза Основателя 29.10) ————
// Модель между компактизациями потребляет дельту, а не полный снапшот:
// сигнатуры секций и решение доставки — чистые функции здесь, склейка
// текста — в индексе. Полный снапшот — первый вызов / reset:true / каждый 10-й.

export type StateSigs = { tasks: string; agents: string; chatLines: number }

// Дешёвые сигнатуры трёх секций: задачи (id/state/owner/est), агенты
// (id/state/task/updated/edits) и число строк ленты чата (AGENT_CHAT.md).
export function stateSigs(ledger: Ledger, chatLines: number): StateSigs {
  return {
    tasks: JSON.stringify(ledger.tasks.map((t) => [t.id, t.state, t.owner ?? "", t.est_min ?? 0])),
    agents: JSON.stringify(ledger.agents.map((a) => [a.id, a.state, a.task_id, a.updated_at, a.edit_count ?? 0])),
    chatLines,
  }
}

// Какие секции изменились с прошлого потребления — список имён для дельты.
export function changedSections(prev: StateSigs, next: StateSigs): string[] {
  const out: string[] = []
  if (prev.tasks !== next.tasks) out.push("tasks")
  if (prev.agents !== next.agents) out.push("agents")
  if (prev.chatLines !== next.chatLines) out.push("chat")
  return out
}

// Компактный список агентов для дельты (последние 30):
// id · task · state · model · edits · HH:MM.
export function projectAgentsBrief(ledger: Ledger): string {
  return ledger.agents
    .slice(-30)
    .map((a) => `${a.id} ${a.task_id} ${a.state} ${a.model ?? "-"} ${a.edit_count ?? 0}e ${String(a.updated_at ?? "").slice(11, 19)}`)
    .join("\n")
}

// ------------------------------------------- T94-очередь тест-серверов -----
// Заказ Основателя 11.11 (дословно: «На репо ток 1 тест сервер правило? …
// Автодерг ждущего при отпускании тест сервера»). Правило «≤1 дев-сервер на
// репо» уже живёт в ServerGuard (index.ts, реестр DEVATA/servers.json); здесь —
// ДЕТЕРМИНИРОВАННАЯ очередь ожидающих: без ИИ-логики, чистые функции + TTL.
// release() сервера передаёт бронь голове очереди автоматически (reserved_for),
// бронь умирает по TTL, чтобы «призрак» не держал сервер вечно.
export interface ServerWaiter {
  path: string // канонический путь репо
  owner: string // кто ждёт (вкладка/агент)
  kind: string // test | panel | …
  since: string // ISO
}

export const SERVER_RESERVE_TTL_MS = 30 * 60_000

/** Добавить в очередь идемпотентно (дубль path+owner+kind не плодится). */
export function serverQueueAdd(queue: ServerWaiter[], item: ServerWaiter): ServerWaiter[] {
  if (queue.some((q) => q.path === item.path && q.owner === item.owner && q.kind === item.kind)) return queue
  return [...queue, item]
}

/** Снять голову очереди для репо: FIFO — первым пришёл, первым забрал. */
export function serverQueueTake(queue: ServerWaiter[], path: string): { next: ServerWaiter | null; rest: ServerWaiter[] } {
  const idx = queue.findIndex((q) => q.path === path)
  if (idx < 0) return { next: null, rest: queue }
  return { next: queue[idx], rest: queue.filter((_, i) => i !== idx) }
}

/** Бронь после release активна, пока не истёк TTL (reserved_for + reserved_at). */
export function serverReservationActive(
  entry: { reserved_for?: string; reserved_at?: string } | null | undefined,
  at: number = Date.now(),
  ttlMs: number = SERVER_RESERVE_TTL_MS,
): boolean {
  if (!entry || !entry.reserved_for || !entry.reserved_at) return false
  const ts = Date.parse(entry.reserved_at)
  return Number.isFinite(ts) && at - ts >= 0 && at - ts < ttlMs
}

// ------------------------------------ T94: протокол сервера для задач -------
// Заказ Основателя 11.11: «На репо ток 1 тест сервер правило? Автодерг ждущего
// при отпускании тест сервера» + «реализуй не логикой ИИ, а кодом». Тут — ЧИСТЫЕ
// функции: разбор запроса задачи и решение (reuse / spawn / queue). Без ИИ.
export interface ServerRequest {
  path: string // канонический путь репо, для которого просят сервер
  kind: string // вид: dev | test | panel | …
  owner: string // кто просит (агент/сессия) — он же получит автодерг
  cmd?: string // команда запуска (необязательна: если сервер жив — переиспользуем)
  cwd?: string // рабочий каталог запуска
  port?: number // ожидаемый порт (для пробы «сервер поднялся»)
}

export type ServerDecision =
  | { action: "reuse"; port: number; pid: number }
  | { action: "spawn" }
  | { action: "queue"; position: number }

/** Разбор запроса из DEVATA/server_request.json. Мусор → null (запрос не трогаем). */
export function parseServerRequest(raw: string): ServerRequest | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const r = parsed as Record<string, unknown>
  const path = typeof r.path === "string" ? r.path.trim() : ""
  const kind = typeof r.kind === "string" && r.kind.trim() !== "" ? r.kind.trim() : "dev"
  const owner = typeof r.owner === "string" ? r.owner.trim() : ""
  if (!path || !owner) return null
  const cmd = typeof r.cmd === "string" && r.cmd.trim() !== "" ? r.cmd.trim() : undefined
  const cwd = typeof r.cwd === "string" && r.cwd.trim() !== "" ? r.cwd.trim() : undefined
  const port = typeof r.port === "number" && Number.isFinite(r.port) && r.port > 0 ? Math.floor(r.port) : undefined
  return { path, kind, owner, cmd, cwd, port }
}

/**
 * Решение по запросу сервера — детерминированное:
 * живой сервер → reuse; свободный слот → spawn; занято/бронь другому → queue.
 * queue — текущая очередь ожидающих (для позиции в очереди).
 */
export function decideServerRequest(
  req: ServerRequest,
  live: { pid: number; port: number } | null,
  reservedFor: string | null,
  queue: ServerWaiter[],
): ServerDecision {
  if (live && live.pid > 0) return { action: "reuse", port: live.port, pid: live.pid }
  if (reservedFor && reservedFor !== req.owner) {
    const pos = queue.findIndex((q) => q.path === req.path && q.kind === req.kind && q.owner === req.owner)
    return { action: "queue", position: pos < 0 ? queue.length + 1 : pos + 1 }
  }
  return { action: "spawn" }
}

// ----------------------------------------- T124: канал жалоб на фреймворк -----
// Заказ Основателя 29.10: агенты/вкладки пишут о проблемах фреймворка
// (инициализация, инжект контекста, инструменты/экстеншен, маршрутизация,
// модели, состояние/память, поведение рантайма). Сообщения хранятся в
// DEVATA/complaints.json с привязкой автор/сессия/задача/компонент/время,
// дедупликацией (одинаковая жалоба в окне не дублируется) и UI-проекцией на
// панели. Не смешивается с продуктовыми задачами и agent_error.
export interface Complaint {
  id: string // c_<ts>_<rand>
  author: string // сессия/агент-автор
  session: string | null // сессия (может совпадать с author)
  task: string | null // задача, если есть
  component: string // init | context_inject | tools_extension | routing | models | state_memory | runtime | other
  text: string // суть жалобы
  ts: string // ISO
  ack: boolean // подтверждено основателем/оркестратором
  dedupKey: string // компонент + хэш текста — для дедупа
}

export const COMPLAINTS_FILE = "complaints.json"
const COMPLAINTS_DEDUP_WINDOW_MS = 60 * 60_000 // 60 мин — одна и та же жалоба не дублится

const simpleHash = (s: string): string => {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i)
    h |= 0
  }
  return (h >>> 0).toString(36)
}

export const COMPLAINT_COMPONENTS: readonly string[] = [
  "init",
  "context_inject",
  "tools_extension",
  "routing",
  "models",
  "state_memory",
  "runtime",
  "other",
]

export function makeDedupKey(component: string, text: string): string {
  return `${component}|${simpleHash(text.trim().toLowerCase().slice(0, 80))}`
}

export function makeComplaintId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function loadComplaints(root: string): Complaint[] {
  const path = join(root, "DEVATA", COMPLAINTS_FILE)
  if (!existsSync(path)) return []
  try {
    const raw = readFileSync(path, "utf8").trim()
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || !Array.isArray((parsed as { complaints?: unknown }).complaints)) return []
    return (parsed as { complaints: Complaint[] }).complaints.filter(
      (c): c is Complaint =>
        c && typeof c.id === "string" && typeof c.text === "string" && typeof c.ts === "string",
    )
  } catch {
    return []
  }
}

export function saveComplaints(root: string, complaints: Complaint[]): void {
  try {
    const dir = join(root, "DEVATA")
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, COMPLAINTS_FILE), JSON.stringify({ complaints }, null, 2), "utf8")
  } catch (e) {
    console.error("[dev-console] complaints save:", e)
  }
}

// Добавить жалобу с дедупом: одинаковая (компонент+текст) в окне не дублится,
// а обновляет ts существующей. Возвращает добавленную/обновлённую жалобу или null.
export function addComplaint(
  root: string,
  input: Omit<Complaint, "id" | "ts" | "ack" | "dedupKey">,
): Complaint | null {
  const complaints = loadComplaints(root)
  const dedupKey = makeDedupKey(input.component, input.text)
  const now = new Date().toISOString()
  const existingIdx = complaints.findIndex(
    (c) => c.dedupKey === dedupKey && Date.now() - Date.parse(c.ts) < COMPLAINTS_DEDUP_WINDOW_MS,
  )
  const complaint: Complaint = {
    id: makeComplaintId(),
    author: input.author,
    session: input.session ?? null,
    task: input.task ?? null,
    component: input.component,
    text: input.text,
    ts: now,
    ack: false,
    dedupKey,
  }
  if (existingIdx >= 0) {
    complaints[existingIdx].ts = now // обновить время, не плодить дубль
    saveComplaints(root, complaints)
    return complaints[existingIdx]
  }
  complaints.push(complaint)
  saveComplaints(root, complaints)
  return complaint
}

export function acknowledgeComplaint(root: string, complaintId: string): boolean {
  const complaints = loadComplaints(root)
  const c = complaints.find((x) => x.id === complaintId)
  if (!c) return false
  c.ack = true
  saveComplaints(root, complaints)
  return true
}

export function formatComplaintsSection(complaints: Complaint[]): string {
  if (complaints.length === 0) return ""
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  const rows = complaints
    .slice()
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    .slice(0, 20)
    .map((c) => {
      const ack = c.ack ? " ✓" : ""
      const task = c.task ? ` [${c.task}]` : ""
      const when = new Date(c.ts).toTimeString().slice(0, 5)
      return `<div style="padding:3px 6px; margin:2px 0; background:#161b22; border:1px solid #30363d; border-radius:4px; font-size:12px;">
        <span style="color:#ffa657;">⚠ ${esc(c.component)}</span>
        <span style="color:#8b949e;"> · ${when}</span>
        ${task}
        <div style="margin-top:2px;">${esc(c.text)}</div>
        <div style="margin-top:2px; font-size:11px; color:#8b949e;">автор ${esc(c.author)}${c.session ? ` · сессия ${esc(c.session)}` : ""}${ack}</div>
      </div>`
    })
    .join("")
  return `<div id="complaints" style="margin-top:16px; border-top:1px solid #30363d; padding-top:10px;">
    <div style="color:#f85149; font-weight:bold; margin-bottom:6px;">📢 ЖАЛОБЫ НА ФРЕЙМВОРК (T124)</div>
    ${rows}
    <div style="margin-top:6px; font-size:11px; color:#8b949e;">хранилище: DEVATA/complaints.json · дедуп 60 мин по компоненту+тексту</div>
  </div>`
}
