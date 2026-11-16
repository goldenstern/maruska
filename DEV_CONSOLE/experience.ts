// EXPERIENCE_CORE (T103-дизайн → код T116, Основатель 28.10: «все „Маруськи
// Гольденштерн" учатся на проектах, где есть их инстанс; „Мары" — ТОЛЬКО там,
// где их память; „Гольфия Совершен" — без привязки, сколько угодно; ключ опыта
// = имя инстанса, память пер-инстанс, агрегация межпроектная).
//
// Чистый модуль в стиле state.ts: только node:fs, без OpenCode-импортов.
// Опыта НЕ храним (доктрина «один канон»): канон опыта = DEVATA/state.json
// КАЖДОГО проекта, чужие леджеры только READ. Здесь только: (1) имя как ключ,
// (2) гейт-классы доступа, (3) склейка + кэш, (4) реестр-шарды «я здесь».
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { INSTANCE_EMOJI, INSTANCE_PERSONA, loadLedger, type Agent, type Ledger, type TaskClass } from "./state.ts"
import { resolvePersona } from "./personas.ts"

const escapeRe = (e: string): string => e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const norm = (s: string): string => s.replace(/\s+/g, " ").trim()

// ------------------------------------------------- §3: имя инстанса (ключ) ---

// Ключ опыта = имя инстанса из титула вкладки (канон T86 «<эмодзи> <тема> ·
// <имя>»): 1) снимаем эмодзи-токен; 2) хвост после последнего «·», узнаётся
// каталогом T102 → возвращаем ХВОСТ (usual case); 3) иначе голова до первого
// «·», если узнаётся (до-T86 титул «Имя · Тема»); 4) иначе raw-хвост — ЛОКАЛЬНОЕ
// имя вне каталога «местное и неприкосновенное» (T102), НЕ склеиваем с
// INSTANCE_PERSONA, иначе чужой проект ошибочно откроет presence-гейт Маруське.
// Хвост пуст → INSTANCE_PERSONA. Мусорный хвост даёт мусорный-же изолированный
// бакет (memory-класс) — самонейтрализуется, никому не открывает опыт.
export function instanceNameOf(title: string): string {
  const t = typeof title === "string" ? title.trim() : ""
  if (t === "") return INSTANCE_PERSONA
  let s = t
  const emojiPrefix = new RegExp(`^\\s*(?:${["📂", ...INSTANCE_EMOJI].map(escapeRe).join("|")})\\s+`)
  const m = emojiPrefix.exec(s)
  if (m) s = s.slice(m[0].length).trim()
  if (s === "") return INSTANCE_PERSONA
  const tailRe = /^(.+)\s+·\s+(.+)$/
  const tail = tailRe.exec(s)
  if (tail) {
    const head = norm(tail[1])
    const name = norm(tail[2])
    if (resolvePersona(name)) return name
    if (resolvePersona(head)) return head // старый формат «Имя · Тема»
    return name // локальное имя вне каталога — как есть
  }
  const name = norm(s)
  return name === "" ? INSTANCE_PERSONA : name
}

// Атрибуция записи агента на имя (для класса memory): вкладка агента = home,
// иначе сессия его задачи; нет вкладки/хвоста → INSTANCE_PERSONA. Не бросает.
export function nameOfAgent(a: Agent, ledger: Ledger): string {
  const home = a.home ?? ledger.tasks.find((t) => t.id === a.task_id)?.session_ref ?? null
  const tab = home ? ledger.tabs.find((t) => t.session_id === home) : undefined
  return instanceNameOf(tab?.title ?? "")
}

// ------------------------------------------------------- §4: гейты доступа ---

export type ExperienceScope = "presence" | "memory" | "unbound"

// Класс доступа — по ИПОСТАСИ имени из каталога T102 (варианты names наследуют
// класс: Маруха Чо → maruska). presence = «ей — на всех» (дефолтный первый
// агент нового репо ⇒ фактически все проекты); unbound = спецназ; memory —
// дефолт для всех остальных (в т.ч. masha/curie/magdalene/неизвестные):
// консервативно, неизвестное имя чужой опыт не получает.
export function scopeFor(name: string): ExperienceScope {
  const id = resolvePersona(name)?.id
  if (id === "maruska") return "presence"
  if (id === "golfia") return "unbound"
  return "memory"
}

const settled = (a: Agent): boolean => a.state === "completed" || a.state === "failed"

// Гейт читается по СВЕЖЕМУ чужому леджеру (реестр хранит только пути — правду
// о presence не кэшируем, иначе переименование/новая вкладка в чужом репо
// врала бы нам).
export function gateAllows(scope: ExperienceScope, ledger: Ledger, name: string): boolean {
  if (scope === "unbound") return true
  if (scope === "presence") return ledger.tabs.some((t) => instanceNameOf(t.title) === name)
  return ledger.agents.some((a) => settled(a) && nameOfAgent(a, ledger) === name)
}

// ---------------------------------------------------------- §5: агрегация ---

export interface CrossExperience {
  // completed-агенты (тайминг для learnEta), ≤ETA_HISTORY на проект
  durations: Array<{ kind: string; ms: number; endedAt: number }>
  // per-class статистика моделей (для chooseModelByClass warmup/score)
  modelClass: Array<{
    model: string
    byClass: Partial<Record<TaskClass, { ok: number; fail: number; editsPerSecSum: number; runs: number }>>
  }>
  sources: string[] // какие проекты прошли гейт (диагностика runtime.experience)
  unlimited: boolean // unbound: «сколько угодно» — окно не сжимается до 5
}

const EMPTY_EXPERIENCE: CrossExperience = { durations: [], modelClass: [], sources: [], unlimited: false }

const DURATIONS_PER_PROJECT = 5

// Склейка: свой проект входит ВСЕГДА (свои записи ⊆ память для memory); для
// каждого чужого — гейт, иначе пропуск. durations — свои первыми, сортировка
// по endedAt desc; byClass — суммирование (как local⊕local, без капа). Пусто →
// ПУСТОЙ aggregate: потребители ведут себя ровно как сегодня (никакой новой
// правды — принцип T84 «нет статистики → дефолт»).
export function aggregateExperience(
  name: string,
  ownRoot: string,
  ledgers: Map<string, Ledger>,
): CrossExperience {
  const scope = scopeFor(name)
  const out: CrossExperience = { durations: [], modelClass: [], sources: [], unlimited: scope === "unbound" }
  const own = ledgers.get(ownRoot)
  if (!own) return EMPTY_EXPERIENCE
  const pushLedger = (path: string, ledger: Ledger): void => {
    if (path !== ownRoot && !gateAllows(scope, ledger, name)) return
    out.sources.push(path)
    const durs: Array<{ kind: string; ms: number; endedAt: number }> = []
    for (const a of ledger.agents) {
      if (a.state !== "completed") continue
      const ms = Date.parse(a.updated_at) - Date.parse(a.began_at)
      if (!Number.isFinite(ms) || ms <= 0) continue
      durs.push({ kind: a.kind ?? "agent", ms, endedAt: Date.parse(a.updated_at) })
    }
    durs.sort((x, y) => y.endedAt - x.endedAt)
    out.durations.push(...durs.slice(0, DURATIONS_PER_PROJECT))
    for (const stat of ledger.models ?? []) {
      if (!stat.byClass) continue
      const byClass: CrossExperience["modelClass"][number]["byClass"] = {}
      for (const [cls, v] of Object.entries(stat.byClass)) {
        byClass[cls as TaskClass] = {
          ok: v.ok,
          fail: v.fail,
          editsPerSecSum: v.editsPerSecSum,
          runs: v.runs,
        }
      }
      out.modelClass.push({ model: stat.model, byClass })
    }
  }
  for (const [path, ledger] of ledgers) pushLedger(path, ledger)
  // свои первыми: пересортировка durations — свои (ownRoot) уже добавлены в
  // порядке обхода Map; гарантия «свои первыми» важна при равных endedAt.
  return out
}

// ------------------------------------------------- реестр проектов (шарды) ---

// Хаб = каталог плагина ../DEVATA (обязателен realpath: подключение через
// джанкен ~/.config/opencode/plugins/dev-console — без разрешения «..» уйдёт
// в ~/.config/opencode/plugins). Шард на проект = один писатель = один проект,
// в нём НЕТ опыта — только адрес и дата (метаданные обнаружения).
export const experienceRegistryDir = (hubDevata: string): string => join(hubDevata, "experience", "projects")

export interface RegistryEntry {
  path: string
  updated_at: string
}

export function loadRegistry(hubDevata: string): Map<string, RegistryEntry> {
  const dir = experienceRegistryDir(hubDevata)
  const out = new Map<string, RegistryEntry>()
  if (!existsSync(dir)) return out
  let names: string[] = []
  try {
    names = readdirSync(dir) as string[]
  } catch {
    return out
  }
  for (const f of names) {
    if (!f.endsWith(".json")) continue
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as RegistryEntry
      if (typeof r.path === "string" && r.path !== "") out.set(r.path, r)
    } catch {
      /* битый шард — пропуск, перечитается на следующей записи */
    }
  }
  return out
}

const touchAt = new Map<string, number>()
const TOUCH_THROTTLE_MS = 60_000

// «Я здесь, вот мой путь» — атомарно (tmp→rename), throttle 60с на проект.
// Повторный вызов раньше throttle — no-op (возвращает false).
export function touchRegistry(hubDevata: string, projectRoot: string, at: number = Date.now()): boolean {
  const last = touchAt.get(projectRoot) ?? 0
  if (at - last < TOUCH_THROTTLE_MS) return false
  touchAt.set(projectRoot, at)
  const dir = experienceRegistryDir(hubDevata)
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const slug = projectRoot.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80) || "project"
    const entry: RegistryEntry = { path: projectRoot, updated_at: new Date(at).toISOString() }
    const file = join(dir, `${slug}.json`)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(entry, null, 2), "utf8")
    renameSync(tmp, file)
    return true
  } catch {
    return false // реестр не критичен: сбой записи = «проект просто не обнаружен»
  }
}

// ---------------------------------------------------- чтение чужих леджеров --

export interface CachedLedger {
  ledger: Ledger
  mtimeMs: number
  readAt: number
}

const cache = new Map<string, CachedLedger>()
const CACHE_TTL_MS = 60_000

// Чужой леджер только READ: битый/отсутствующий → null (причина для
// runtime.experience.skipped). Кэш по mtime+TTL: пересчёт по факту файла,
// не по таймеру веры.
export function readForeignLedger(
  file: string,
  statFn: (path: string) => { mtimeMs: number } | null,
): Ledger | null {
  let st: { mtimeMs: number } | null = null
  try {
    st = statFn(file)
  } catch {
    st = null
  }
  if (!st) return null
  const cached = cache.get(file)
  if (cached && cached.mtimeMs === st.mtimeMs && Date.now() - cached.readAt < CACHE_TTL_MS) return cached.ledger
  try {
    const ledger = loadForeignLedger(file)
    cache.set(file, { ledger, mtimeMs: st.mtimeMs, readAt: Date.now() })
    return ledger
  } catch {
    cache.delete(file)
    return null
  }
}

// (загружаем напрямую: state.ts не импортирует experience.ts — цикла нет)
const loadForeignLedger = (file: string): Ledger => loadLedger(file)
