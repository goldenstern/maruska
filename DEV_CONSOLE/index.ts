// DEV CONSOLE runtime — OpenCode plugin wrapper.
// Registers the single `dev_console` tool: the authoritative task ledger.
// All state logic lives in ./state.ts (pure, unit-tested).

import { Plugin } from "@opencode/plugin"
import { execFileSync, spawnSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, watch, appendFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { stateSigs, changedSections, projectAgentsBrief, type StateSigs } from "./state.ts"
import { parseTitle, activityTopic } from "./activity.ts" // T117: разбор «тема · персона» + строка-деятельность (канон Основателя 16.11: динамика тем вернулась) // T135: дельты get_state
import {
  aggregateExperience,
  instanceNameOf,
  loadRegistry,
  readForeignLedger,
  scopeFor,
  touchRegistry,
  type CrossExperience,
} from "./experience.ts" // T116: EXPERIENCE_CORE — межрепо-опыт по именам инстансов
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { ServerGuard, SERVER_REGISTRY_FILE, spawnDetached, type ServerRegistry } from "./server_guard.ts"
import { basename, dirname, join } from "node:path"
import {
  applyOp,
  autoBlinkAction,
  beginAgent,
  BLINK_GLYPHS,
  INSTANCE_EMOJI,
  assignEmoji,
  calcInstanceSpeed,
  calcRepoSpeed,
  chooseChildModel,
  chooseModelByClass,
  childModelAllowed,
  COOLDOWN_MS,
  EFF_GAP_MS,
  flushTabEffActivity,
  dropOwnFromForeign,
  errorTextOfPayload,
  formatModelClassToken,
  formatRepoSpeed,
  INSTANCE_MODEL,
  INSTANCE_KEY,
  isExecutorSession,
  isExecutorTab,
  isForeignSession,
  isRateLimited,
  loadLedger,
  liveExecutorConflict,
  modelForKey,
  modelStats,
  openTasksOf,
  parseActiveSessions,
  parseLsFiles,
  parseNumstat,
  parseSessionFeed,
  parseChildFeed,
  attachTabChildren,
  normalizeTitle,
  personaTitle,
  blinkCycle,
  blinkRestore,
  applySelfReport,
  applyTabFeed,
  classifyAgentError,
  markAgentError,
  noSelfReportReason,
  noteInjection,
  noteAgentProgress,
  noteAgentTool,
  noteAgentRequest,
  noteAgentUsage,
  noteTabEffWork, // T118: работа = Δ numstat → durable накопители вкладки
  overrunWakeReason,
  OVERRUN_WAKE_FACTOR,
  noteOrientationCheck,
  NO_SELF_REPORT,
  NO_SELF_REPORT_MIN,
  POLICY_MODELS,
  // T132 (заказ 29.10): полюс free/premium + контроль квот
  FREE_POOL,
  formatQuotaHeader,
  mergeQuota,
  modelUsable,
  parseConsoleQuota,
  quotaFallbackModel,
  quotaGuardUsage,
  rollingUsage,
  type QuotaUsage,
  project,
  projectCounters,
  projectTabs,
  projectWorksheet,
  recordModelResult,
  recordModelResultByClass,
  renderConsoleHtml,
  rekeyAgent,
  resetModelCooldowns,
  saveLedger,
  settleAgent,
  settleOnEvent,
  settleOnTurn,
  bumpUpstreamCooldown,
  loadModelHealth,
  saveModelHealth,
  recordModelHealth,
  applyModelHealth,
  reserveLedgerId,
  setModelCooldown,
  shortModelKey,
  syncTabTitle,
  titleEmojiOf,
  tabStatus,
  taskClass,
  type TaskClass,
  upsertTab,
  wakeMessage,
  zombieSettleReason,
  type Agent,
  type AgentCounters,
  type InstanceSpeed,
  type InstanceDiffSnapshot,
  type InstanceEditEvent,
  type Ledger,
  type OpInput,
  type PaneLocation,
  type PanelChannel,
  type Projection,
  type RepoSpeed,
  type TabSession,
  type Task,
  assignInstancePersona,
  type CrossDurations,
  type CrossModelClass,
} from "./state.ts"
import {
  cpuGate,
  getCpuState,
  killRunawayProcesses,
  probeAndUpdate,
  resetCpuState,
  startCpuBackground,
  stopCpuBackground,
  type CpuGateResult,
  type CpuSample,
} from "./cpu.ts"
// T102 (заказ Основателя 08.10): тексты персонажей живут в отдельном файле
// промптов (personas.ts); вторая точка инъекции — дефолтный агент папки
// ~/.config/opencode/agents/maruska.md. Спавн-инъекция — dispatchPrompt ниже.
import { instancePersona, instancePromptBlock, personaForTaskClass, personaPromptBlock, topLevelPersona, type Persona } from "./personas.ts"
// T94-очередь (заказ 11.11): детерминированная передача тест-сервера ожидающему
// T125 (заказ 11.11): право на эмодзи/мигание — только прямой чат с Основателем
import { isDirectConversation } from "./state.ts"
// T94-серверы-тасков: чистые функции протокола запроса сервера (без ИИ-логики)
import { parseServerRequest, decideServerRequest } from "./state.ts"
// T124: жалобы на фреймворк — их проекция в панель (хранилище complaints.json)
import { loadComplaints } from "./state.ts"
// T119: ритуал «ПАПА, А МЫ…» — модуль написан (ritual.ts), здесь он ВРЕЗАН в рантайм:
// ночной триггер + «волна закрыта», пост в ленту, гард выбора моделей.
import {
  RITUAL_ID,
  nightlyWindow,
  waveWindow,
  collectInstanceReport,
  collectBoard,
  decideModels,
  councilReports,
  renderPapaPost,
  guardModel,
  type CouncilEntry,
  type RitualWindow,
} from "./ritual.ts"

// T165: сериализатор спавнов агентов — аллокация id (max+1) и сейв леджера
// идут единым критическим куском; два параллельных диспатча больше не могут
// взять один и тот же id с разных снимков (A180×2: T161 и T162). Кросс-процесс
// гонка (другой инстанс) не закрывается здесь, но внутри инстанса — закрыта.
const serializeAgentSpawn = (<T>(fn: () => Promise<T>): Promise<T> => {
  let chain: Promise<unknown> = Promise.resolve()
  return (fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)
    chain = run.catch(() => undefined) // очередь живёт даже при падении звена
    return run
  }
})()

// ------------------------------------------------ plugin setup -------------

const INPUT = {
  type: "object",
  properties: {
    op: {
      type: "string",
      enum: ["get_state", "create", "update", "set_state", "model_reset", "progress"],
      description:
        "progress: executor-only self-report (step/done/next/eta_remaining_min); identity is bound by runtime sessionID. " +
        "get_state: read projection (call before any status response). create: Founder-requested task " +
        "(starts WAIT; `parent` = decomposition child). update: change task text / owner (null clears). " +
        "set_state: DOING|WAIT|BLOCKED|GATE|DONE — BLOCKED/GATE need `why`, DONE needs `verification` " +
        "(terminal; rework = new create). DOING + owner (on set_state or update) → the runtime dispatches (`dispatched` in the " +
        "response) — never spawn for it. model_reset: relay of the Founder's «был рейт лимит, " +
        "перезапусти» — clears model cooldowns (T66), next child returns to the default model.",
    },
    id: { type: "string", description: "Task id, e.g. T1" },
    task: { type: "string", description: "Task description (create / update)" },
    owner: {
      type: ["string", "null"],
      description:
        "dev | research | qc — non-null on a DOING task → the runtime dispatches that background agent " +
        "(qc pins qc model). Omit when this thread does the work inline; null clears",
    },
    parent: {
      type: "string",
      description:
        "Decomposition (create): parent task id. Children render ↳, the parent gets a progress bar " +
        "(children DONE/total); no decomposition → no bar",
    },
    state: { type: "string", enum: ["DOING", "WAIT", "BLOCKED", "GATE", "DONE"] },
    why: {
      type: "string",
      description: "BLOCKED: what blocks + what unblocks. GATE: the concrete Founder decision",
    },
    verification: { type: "string", description: "DONE: what was verified and how" },
    // T38: Phase estimation — explicit estimate in minutes (if model provides, it wins over auto)
    est_min: { type: "number", description: "Explicit phase estimate in minutes (model-provided; overrides auto-estimation from history)" },
    // T38: Phase tag for grouping history (e.g., "impl", "review", "test")
    phase: { type: "string", description: "Phase tag for history grouping (e.g., 'impl', 'review', 'test')" },
    step: { type: "string", description: "progress only: current meaningful work step (1–180 chars)" },
    done: { type: ["string", "number", "null"], description: "progress only: concise self-reported checkpoint, e.g. 3/10" },
    next: { type: ["string", "null"], description: "progress only: next concrete action" },
    eta_remaining_min: { type: ["number", "null"], description: "progress only: self-reported remaining minutes, 0–1440; not the original plan ETA" },
  },
  required: ["op"],
  additionalProperties: false,
} as const

const DESCRIPTION =
  "DEV CONSOLE — persistent orchestration runtime: task ledger, state machine, gates. The model never " +
  "keeps this state itself. get_state before any status answer. The Founder reads state from the live " +
  "pane (DEVATA/CONSOLE_UI.html); chat replies are short comments — paste `ui` only if the pane is " +
  "unavailable. Record only real events. DONE is terminal and needs verification; a rejected transition is final — " +
  "fix the record, don't retry. DOING + owner (sent with set_state/update) → the runtime dispatches the background agent " +
  "(`dispatched` in the response), never spawn manually; no owner = this thread works inline. " +
  "Executors may call only progress to report their own step; they cannot create/update tasks or read/change the ledger."

export default Plugin.define({
  id: "dev-console",
  async setup(ctx) {
    // Canonical location: the project the plugin instance was loaded for.
    const root = ctx.location.project?.canonical ?? ctx.location.project?.directory ?? ctx.location.directory
    // T135-уточнение (декрет Основателя 29.10, дословно): «МНЕ НУЖНА КОНСОЛЬ
    // ОТКРЫТАЯ В КАЖДОМ РЕПО ТОЛЬКО НА ТОТ РЕПО» — консоль живёт в каждом
    // ГИТ-репозитории (это его UX: панель рядом с чатом внутри репо).
    // Инцидент 29.10 был НЕ в пер-репо-консоли, а в свалке: плагин грузился
    // и в НЕ-репо (home/Temp — probe-дети T132), где усыновлял всё подряд и
    // сыпал портреты на чужие чаты. Scope: только GIT-репозитории (есть .git
    // в корне или родителе); чаты/сессии ЧУЖИХ проектов в леджер не попадают
    // (isLocalSession + фид по своему репо) — консоль репо видит только его.
    if (!existsSync(join(root, ".git")) && !existsSync(join(dirname(root), ".git"))) {
      console.log(`[dev-console] non-git root, inert: ${root}`)
      return
    }
    const stateFile = join(root, "DEVATA", "state.json")
    // T116 (EXPERIENCE_CORE F3): хаб реестра проектов = realpath каталога
    // плагина ../DEVATA — джанкен ~/.config/opencode/plugins/dev-console
    // резолвится в канонический DEV_CONSOLE, поэтому ВСЕ проекты, подключённые
    // к одной копии плагина, пишут шарды «я здесь» в ОДИН реестр. realpathSync
    // обязателен (без него «..» уйдёт в ~/.config/opencode/plugins).
    const pluginHubDevata = (() => {
      try {
        const self = realpathSync(fileURLToPath(import.meta.url))
        return join(dirname(self), "..", "DEVATA")
      } catch {
        return join(root, "DEVATA") // фолбэк: хаб = свой репо (обнаружение сужается, ничего не ломается)
      }
    })()
    touchRegistry(pluginHubDevata, root) // «я здесь» при загрузке (throttle 60с внутри)
    const htmlFile = join(root, "DEVATA", "CONSOLE_UI.html")
    // Service info for the pane (T59, Founder order): the folder name goes into
    // <title> («DEV CONSOLE · <имя>») and the 📁 header carries name · path ·
    // branch · remote — two consoles from different folders must be told apart
    // in browser tabs. All of it is cosmetic: every failure leaves a field null
    // and the pane renders honestly with what is known.
    const loc: PaneLocation = { name: basename(root), path: root, branch: null, remote: null }
    try {
      // ctx.vcs has no remote (only branch/status/diff) — git config has it.
      loc.remote =
        execFileSync("git", ["-C", root, "config", "--get", "remote.origin.url"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        }).trim() || null
    } catch {
      loc.remote = null // не git-репозиторий или git недоступен — не беда
    }

    // ------------------------------------------------ Write Queue (T62: serialization) -----
    // Atomic save queue: single writer to prevent read-modify-write races
    // when multiple parallel writers (context-hook, event-stream, probes) save.
    interface SaveOp {
      ledger: Ledger
      resolve: (v: void) => void
      reject: (e: Error) => void
    }
    let saveQueue: SaveOp[] = []
    let saveBusy = false
    const processSaveQueue = async (): Promise<void> => {
      if (saveBusy || saveQueue.length === 0) return
      saveBusy = true
      while (saveQueue.length > 0) {
        const op = saveQueue.shift()!
        try {
          saveLedger(stateFile, op.ledger)
          op.resolve()
        } catch (e) {
          op.reject(e as Error)
        }
      }
      saveBusy = false
    }
    const saveQueued = (ledger: Ledger): Promise<void> => {
      return new Promise((resolve, reject) => {
        saveQueue.push({ ledger, resolve, reject })
        void processSaveQueue()
      })
    }

    // Initialize ServerGuard with canonical root (T94: ≤1 dev server per repo/folder)
    const serverGuard = new ServerGuard(root)
    let locCheckedAt = 0
    // Ветка живёт в git, а рендер синхронный: обновляем кэш фоном (не чаще раза
    // в 30с), сама запись панели от этого не зависит.
    const refreshBranch = async (): Promise<void> => {
      if (Date.now() - locCheckedAt < 30_000) return
      locCheckedAt = Date.now()
      try {
        const info = await ctx.vcs.get({ location: { directory: root } })
        loc.branch = info?.data?.branch?.current ?? null
      } catch {
        /* косметика: без ветки панель всё равно честна */
      }
    }
    // Stage-2 diagnostics, surfaced in get_state so live verification needs no log access.
    const diag: {
      spawn_tool: string | null
      tool_hooks: boolean
      session_hook: boolean
      event_stream: boolean
      event_reconnects: number
      event_errors: number
      event_last_error: string | null
      event_last_at: string | null
      agent_progress_reports: number
      agent_tool_events: number
      agent_tool_resyncs: number
      agent_usage_events: number
      agent_requests: number
      cpu_monitors: string | null // T138: «погасить мониторы» — off@timestamp кнопкой панели (T164: поле больше не пишется — кнопка гасит ЭКРАНЫ)
      screens_off: string | null // T164: экраны погашены кнопкой (SC_MONITORPOWER=2) — off@timestamp
      injections: number
      injections_full: number // T51: ходов с полным ui
      injections_cheap: number // T51: ходов только со счётчиками
      context_recorded: number
      events_settled: number
      dispatched: number
      eta_fired: number
      overrun_wakes: number // T128: дубль-буждений по порогу переработки (≥2× плана)
      wakes: number // T53: событийные пробуждения (принятых событий, не доставок)
      wakes_deduped: number
      wake_last: string | null
      wake_errors: number // T106: провалов POST /wake (synthetic бросил: NotFound и пр.)
      wake_last_error: string | null // последняя ошибка /wake «session: msg» (иначе null)
      agent_errors: number // T46: смертей исполнителей (failed-settle → пометка agent_error)
      settle_probe: number // T46: строк прожёванных DEVATA/settle_probe.txt
      progress: number
      session_probe: string | null
      session_list: boolean // live probe: does this build expose ctx.session.list?
      title_sync: number // T91: починено записей титулов периодическим рефрешем
      tab_feed: number | null // T33: вкладок ПРОЕКТА в последнем срезе GET /api/session (null = ещё не было)
      tab_feed_err: string | null // последняя ошибка фида (иначе null)
      active_api: boolean | null // T73: отвечает ли GET /api/session/active (probe)
      active_url: string | null // найденный base-URL сервера (env/дискавери-файл)
      active_sessions: number // живых сессий в последнем ответе
      active_error: string | null // последняя ошибка проба (иначе null)
      // T131 (инцидент 29.10, git-шторм сервера): проб живости сервиса перед спавном
      service_alive: boolean | null // результат последнего пробы (null = ещё не было)
      service_probe_at: string | null // когда проб делался (ISO)
      service_probe_ms: number | null // сколько ждали ответ от сервиса (мс)
      service_defers: number // спавнов отложено живостью сервиса (defer вместо смерти ребёнка)
      panel_port: number | null // T60: порт localhost-сервера канала панели
      panel_requests: number // запросов к каналу (включая пробы страницы)
      panel_probes: number // GET /probe — живость страницы/канала
      panel_wake: number // POST /wake → synthetic доставлен
      panel_blink: number // POST /blink обработано (toggle)
      blink_path: string | null // чем переключён title: ctx (session.update) | http (PATCH)
      blink_auto_on: number // T68: авто-включений мигания из цикла скана (вход в «простаивает»)
      blink_auto_off: number // T68: авто-гашений при возврате активности
      scan_calls: number // T90-диаг: заходов в terminal-скан (таймер жив?)
      scan_last: number | null // мс последнего вызова скана
      scan_err: string | null // последняя ошибка/причина пропуска скана (иначе null)
      // T95: CPU monitor diagnostics
      cpu_pct: number | null // последняя измеренная нагрузка %
      cpu_warning: boolean // предупреждение >= 70%
      cpu_hard_stop: boolean // жёсткий стоп >= 90%
      cpu_peak: number // пик нагрузки за сессию
      // T132: контроль квоты + живой каталог моделей + ghost-вкладки (T133)
      quota_guard: number // срабатываний live-guard (квот-ошибка доказана)
      quota_rotations: number // ротаций модели в prompt-catch (квота → следующая free)
      quota_last_at: string | null // когда последний раз квота доказана (ISO)
      quota_source: string | null // guard | console | cost — кто дал цифру в шапку
      quota_rolling: number | null // % rolling в последнем merge (null = источник не дал)
      quota_tokens: number | null // Σтокенов за rolling-окно (последний срез)
      catalog_models: number | null // строк в живом каталоге /api/model
      catalog_at: string | null // когда каталог снимался (ISO)
      catalog_err: string | null // последняя ошибка каталога (иначе null)
      ghost_tabs: { session_id: string; title: string; last_seen: string }[] // T133-кандидаты: записи без живой сессии в фиде
    } = {
      spawn_tool: null,
      tool_hooks: false,
      session_hook: false,
      event_stream: false,
      event_reconnects: 0,
      event_errors: 0,
      event_last_error: null,
      event_last_at: null,
      agent_progress_reports: 0,
      agent_tool_events: 0,
      agent_tool_resyncs: 0,
      agent_usage_events: 0,
      agent_requests: 0,
      injections: 0,
      injections_full: 0,
      injections_cheap: 0,
      context_recorded: 0,
      events_settled: 0,
      dispatched: 0,
      eta_fired: 0,
      overrun_wakes: 0,
      wakes: 0,
      wakes_deduped: 0,
      wake_last: null,
      wake_errors: 0,
      wake_last_error: null,
      agent_errors: 0,
      settle_probe: 0,
      progress: 0,
      session_probe: null,
      session_list: false,
      title_sync: 0,
      tab_feed: null,
      tab_feed_err: null,
      active_api: null,
      active_url: null,
      active_sessions: 0,
      active_error: null,
      service_alive: null,
      service_probe_at: null,
      service_probe_ms: null,
      service_defers: 0,
      panel_port: null,
      panel_requests: 0,
      panel_probes: 0,
      panel_wake: 0,
      panel_blink: 0,
      blink_path: null,
      blink_auto_on: 0,
      blink_auto_off: 0,
      scan_calls: 0,
      scan_last: null,
      scan_err: null,
      // T95
      cpu_pct: null,
      cpu_warning: false,
      cpu_monitors: null, // T138: null = мониторы живут; "off@ts" = погашены кнопкой (T164: больше не пишется)
      screens_off: null, // T164: экраны погашены кнопкой — "off@ts"
      cpu_hard_stop: false,
      cpu_peak: 0,
      // T132
      quota_guard: 0,
      quota_rotations: 0,
      quota_last_at: null,
      quota_source: null,
      quota_rolling: null,
      quota_tokens: null,
      catalog_models: null,
      catalog_at: null,
      catalog_err: null,
      ghost_tabs: [],
    }

    // ------------------------------------------- T132: контроль квоты --------
    // Три источника (приоритет — из state.ts mergeQuota):
    //   guard  — доказанная квот-ошибка (prompt-catch/T66): 100% rolling до сброса;
    //   console — GET /api/usage того же сервера (путь готов, сейчас 404);
    //   cost   — Σcost/Σтокенов сессий /api/session за rolling-окно 93м.
    // Шапка ИНСТАНСЫ несёт «Rolling X%» (+⚠ ≥80%); сброс — model_reset.
    let quotaGuard: QuotaUsage | null = null
    let quotaConsole: QuotaUsage | null = null
    let quotaCost: QuotaUsage | null = null
    let quotaConsoleAt = 0 // троттл пробы /api/usage (пути на будущее)
    const QUOTA_CONSOLE_MS = 5 * 60_000
    const quotaUsage = (): QuotaUsage | null => {
      const merged = mergeQuota(quotaGuard, quotaConsole, quotaCost)
      diag.quota_source = merged?.source ?? null
      diag.quota_rolling = merged?.rollingPct ?? null
      diag.quota_tokens = merged ? (merged.tokens || null) : null
      return merged
    }
    // Квот-ошибка доказана live-guard'ом → шапка честно показывает 100% до
    // сброса; model_reset (кулдауны сняты) снимает и guard.
    const noteQuotaGuard = (resetAt: number | null): void => {
      quotaGuard = quotaGuardUsage(Date.now(), resetAt)
      diag.quota_guard += 1
      diag.quota_last_at = new Date().toISOString()
    }
    const clearQuotaGuard = (): void => {
      quotaGuard = null
    }
    // Проб Console API (готовый путь, троттл 5м): отдаёт проценты — берём,
    // молчит/404 — тихо стоим на cost-срезе. Никогда не бросает наружу.
    const probeConsoleQuota = async (): Promise<void> => {
      if (Date.now() - quotaConsoleAt < QUOTA_CONSOLE_MS) return
      quotaConsoleAt = Date.now()
      try {
        const ep = endpoint()
        if (!ep) return
        const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(2_000) : undefined
        const call = (headers: Record<string, string>): Promise<Response> =>
          fetch(`${ep.url}/api/usage`, { headers, signal })
        let res = await call(ep.auth ? { authorization: ep.auth } : {})
        if (res.status === 401 && ep.auth) res = await call({})
        if (!res.ok) return // 404/мало места — путь просто ждёт своей сборки
        quotaConsole = parseConsoleQuota(await res.json())
      } catch {
        /* косметика: cost-срез и так честен */
      }
    }

    // ------------------------------------- T132: живой каталог моделей -------
    // GET /api/model того же сервера: диспатч не должен целиться в модель,
    // которой нет в каталоге (инцидент A127: мёртвая строка провайдера →
    // старт-смерть ребёнка). Кэш 10м; каталог недоступен → фильтр наличия
    // просто выключен (undefined для chooseModelByClass), полюс решает state.ts.
    const CATALOG_MS = 10 * 60_000
    let catalogModels: string[] | null = null // полные id вида provider/model
    let catalogAt = 0
    let catalogBusy = false
    const refreshCatalog = async (): Promise<void> => {
      if (catalogBusy || Date.now() - catalogAt < CATALOG_MS) return
      catalogBusy = true
      try {
        const ep = endpoint()
        if (!ep) return
        const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(3_000) : undefined
        const call = (headers: Record<string, string>): Promise<Response> =>
          fetch(`${ep.url}/api/model`, { headers, signal })
        let res = await call(ep.auth ? { authorization: ep.auth } : {})
        if (res.status === 401 && ep.auth) res = await call({})
        if (!res.ok) throw new Error(`http ${res.status}`)
        const raw = (await res.json()) as { data?: unknown } | unknown[]
        const list = Array.isArray(raw) ? raw : Array.isArray((raw as { data?: unknown })?.data) ? ((raw as { data: unknown[] }).data) : []
        // Фильтр enabled: выключенная строка каталога для диспатча = мёртвая.
        // Форма ответа: { data: [{ modelID, providerID, enabled, … }] } (живой проб 29.10).
        const enabled = list
          .filter((x) => (x as { enabled?: unknown })?.enabled !== false)
          .map((x) => {
            const o = x as { modelID?: unknown; providerID?: unknown; id?: unknown }
            const id = typeof o.modelID === "string" && o.modelID !== "" ? o.modelID : typeof o.id === "string" ? o.id : null
            const prov = typeof o.providerID === "string" ? o.providerID : null
            return id && prov ? `${prov}/${id}` : null
          })
          .filter((m): m is string => typeof m === "string")
        if (enabled.length === 0) throw new Error("пустой каталог")
        catalogModels = enabled
        catalogAt = Date.now()
        diag.catalog_models = enabled.length
        diag.catalog_at = new Date(catalogAt).toISOString()
        diag.catalog_err = null
      } catch (e) {
        diag.catalog_err = String(e).slice(0, 120)
        catalogModels = null // честнее выключить фильтр, чем верить старому кэшу
        catalogAt = Date.now() // …но не долбить сервер на каждом диспатче
      } finally {
        catalogBusy = false
      }
    }

    // T41/T93: per-session metrics now stored durably on Agent record (edit_count, injection_count).
    // sessionSettleTime kept in-memory only for earlySettle detection (activity after settle).
    const sessionSettleTime = new Map<string, number>() // session_ref → settle timestamp (for earlySettle detection)

    // ---------------------------------------------- active sessions (T73) ---
    // Первичный источник честного статуса вкладки (заказ Основателя 07.10:
    // «кнопка стоп в чате есть только когда чат работает»): GET
    // /api/session/active того же сервера OpenCode — {data:{ses_…:{type:
    // "running"}}}, сессии в ответе нет = не работает. Доступ probe'ом:
    //   base-URL и пароль — env/дискавери-файл сервиса (service.json в
    //   XDG_STATE_HOME(~/.local/state)/opencode: url+password; legacy —
    //   ~/.config/opencode/service.json, там порт сервиса по умолчанию),
    //   авторизация Basic opencode:<password> (проверено живым прогоном);
    //   сам эндпоинт отвечает на localhost и без пароля — 401 повторяем
    //   чистым запросом.
    // Если HTTP не достанется — active остаётся null и статус решает
    // фолбэк-эвристика state.ts (last_seen ≤60с ИЛИ живые агенты). Факт проба
    // (active_api/active_url/active_error) виден в get_state → runtime.diag.
    // Кэш: опрос не чаще ACTIVE_GAP_MS на любой рендер панели, фон — раз в
    // ACTIVE_POLL_MS; таймеры модели ни при чём.
    const ACTIVE_GAP_MS = 1_000 // «не чаще 1 раза/сек»
    const ACTIVE_POLL_MS = 2_000 // ритм фонового опроса = ритм авто-обновления панели
    let activeIds: ReadonlySet<string> | null = null // null = API молчит → эвристика
    let activeAt = 0
    // T158 (жалоба Основателя 14.11: «Горит ждёт, хотя она в работе» — ПРОД ·
    // Мария Кюри): инстанс, работающая ИНЛАЙН (своими ходами, леджер её репо —
    // ноль агентов), между ходами модели мгновенно вылетает из
    // /api/session/active: ход кончился, следующий не начался, а она посреди
    // задачи → active.has(сессия)=false → статус «ждёт ⏳» через секунду после
    // работы. ГРАЦИЯ: сессия, виденная в active ≤ACTIVE_GRACE_MS назад, для
    // СТАТУСА считается работающей (T163: окно 30с — 60с держало «работает»
    // минуту после финиша, что поймал Основатель с другой стороны). Отдельное
    // множество activeGrace — только статус/рендер/мигание; zombie-settle,
    // wake-liveness и conflict-детектор едят СЫРОЙ activeIds (settle не
    // задерживаем).
    const ACTIVE_GRACE_MS = 30_000 // T163: 60с слишком широко — Основатель поймал обратную сторону T158 («не активна, но пишет что работает»: ход кончился, грейс держал «работает» ещё минуту). 30с накрывает междуходовые паузы работающего инлайн (темп ~12 эд/мин) и вдвое честнее после финиша.
    const activeSeen = new Map<string, number>() // сессия → когда последний раз была в active
    let activeGrace: ReadonlySet<string> | null = null // null вместе с activeIds → эвристика
    let activeBusy = false
    let activeLogged = false // первый проб логируется (чтобы видеть источник статуса)
    let activeEndpoint: { url: string; auth: string | null } | null | undefined // undefined = проб ещё не делался

    const discoverActiveEndpoint = (): { url: string; auth: string | null } | null => {
      const home = process.env.USERPROFILE ?? process.env.HOME ?? ""
      const stateHome = process.env.XDG_STATE_HOME ?? (home ? join(home, ".local", "state") : "")
      const files = [
        ...(stateHome ? [join(stateHome, "opencode", "service.json")] : []),
        ...(home ? [join(home, ".config", "opencode", "service.json")] : []),
      ]
      let url: string | null = null
      let password: string | null =
        process.env.OPENCODE_PASSWORD ?? process.env.OPENCODE_SERVER_PASSWORD ?? null
      for (const file of files) {
        try {
          if (!existsSync(file)) continue
          const v = JSON.parse(readFileSync(file, "utf8")) as { url?: unknown; password?: unknown }
          if (!url && typeof v.url === "string" && v.url !== "") url = v.url
          if (!password && typeof v.password === "string" && v.password !== "") password = v.password
        } catch (e) {
          console.error("[dev-console] active probe discover:", e)
        }
      }
      // URL нет (только legacy-пароль) — порт сервиса «latest» по умолчанию.
      const base = (url ?? "http://127.0.0.1:49374").replace(/\/+$/, "")
      return {
        url: base,
        auth: password ? `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}` : null,
      }
    }

    // Ленивый адрес сервера OpenCode: один discovery на инстанс — им пользуются
    // и проб active (T73), и мигание вкладок канала панели (T60, HTTP PATCH).
    const endpoint = (): { url: string; auth: string | null } | null => {
      if (activeEndpoint === undefined) {
        activeEndpoint = discoverActiveEndpoint()
        diag.active_url = activeEndpoint.url
      }
      return activeEndpoint
    }

    const sameActive = (a: ReadonlySet<string> | null, b: ReadonlySet<string> | null): boolean => {
      if (a === null || b === null) return a === b
      if (a.size !== b.size) return false
      for (const id of a) if (!b.has(id)) return false
      return true
    }

    // Один проб: результат в activeIds + diag; без API (или ошибки ответа) —
    // active = null, чтобы эвристика честно сказала «ждёт/простаивает», а не
    // врала «работает». Никогда не бросает исключение наружу.
    const probeActive = async (): Promise<boolean> => {
      const began = Date.now()
      if (activeBusy || began - activeAt < ACTIVE_GAP_MS) return false // кэш: не чаще раза в секунду
      activeBusy = true
      const prev = activeIds
      try {
        const ep = endpoint()
        if (!ep) {
          activeIds = null
          activeGrace = null // T158: грейс живёт только при живом пробе
          diag.active_api = false
          diag.active_error = "service.json/env: no endpoint"
          return false
        }
        const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(2_000) : undefined
        const call = (headers: Record<string, string>): Promise<Response> =>
          fetch(`${ep.url}/api/session/active`, { headers, signal })
        let res = await call(ep.auth ? { authorization: ep.auth } : {})
        if (res.status === 401 && ep.auth) res = await call({}) // локальный сервер и без пароля
        if (!res.ok) throw new Error(`http ${res.status}`)
        const parsed = parseActiveSessions(await res.json())
        if (parsed === null) throw new Error("unexpected /api/session/active shape")
        // T158: грейс для статуса — работавшая ≤60с назад сессия ещё «работает».
        const nowMs = Date.now()
        for (const id of parsed) activeSeen.set(id, nowMs)
        const grace = new Set<string>(parsed)
        for (const [id, seen] of activeSeen) {
          if (nowMs - seen <= ACTIVE_GRACE_MS) grace.add(id)
          else activeSeen.delete(id)
        }
        activeIds = parsed
        activeGrace = grace
        diag.active_api = true
        diag.active_sessions = parsed.size
        diag.active_error = null
        return !sameActive(prev, activeIds)
      } catch (e) {
        activeIds = null // честнее включить эвристику, чем врать «работает»
        activeGrace = null // T158: грейс живёт только при живом пробе
        diag.active_api = false
        diag.active_error = String(e).slice(0, 200)
        return false
      } finally {
        activeBusy = false
        activeAt = Date.now()
        if (!activeLogged) {
          activeLogged = true
          console.log(
            `[dev-console] active probe (T73): ${diag.active_api ? `${diag.active_sessions} running via ${diag.active_url}` : `unavailable (${String(diag.active_error)}) — tab status falls back to heuristics`}`,
          )
        }
      }
    }

    // ---------------------------- service liveness gate (T131) -------------
    // Инцидент 29.10: сервер opencode ушёл в git-шторм (десятки параллельных
    // git-спавнов по ВСЕМ проектам, GET /api/vcs/diff держал 92.9с) → API завис
    // → первый prompt() ребёнка падал «cannot connect to service»/[upstream]
    // ДО первого токена (A120-A124: cost 0) — мёртвый агент + agent_error-петля
    // респавнов сверху. Фикс (заказ T131): перед спавном ребёнка — быстрый проб
    // живости самого сервиса; мёртв/висит → спавн ОТЛАГАЕТСЯ (skipped: defer),
    // а не рождает труп. Любой HTTP-ответ = сервис отвечает (401 без пароля —
    // тоже жив): мертвец это таймаут/отказ соединения. Свежий живой T73-проб
    // переиспользуется — своих пакетов на живой сервер не шлём; свежий отказ
    // кэшируется 3с, чтобы респавн-петля не грузила сервер сама собой.
    const SERVICE_PROBE_TIMEOUT_MS = 1_500 // живой отвечает за десятки мс; виснет — 1.5с достаточно
    const SERVICE_PROBE_FRESH_MS = 3_000 // результат пробы живёт 3с между диспатчами
    let serviceProbeAt = 0
    let serviceProbeAlive = true // до первого пробы не блокируем — прежнее поведение
    const probeServiceAlive = async (): Promise<boolean> => {
      const now = Date.now()
      if (now - serviceProbeAt < SERVICE_PROBE_FRESH_MS) return serviceProbeAlive
      if (diag.active_api === true && now - activeAt < ACTIVE_GAP_MS) {
        // свежий успешный active-проб (T73) = сервер отвечает — новых пакетов не надо
        serviceProbeAlive = true
        serviceProbeAt = now
        diag.service_alive = true
        diag.service_probe_at = new Date().toISOString()
        diag.service_probe_ms = 0
        return true
      }
      const ep = endpoint()
      if (!ep) {
        // адреса сервиса нет — раньше спавн работал вслепую, не блокируем
        serviceProbeAlive = true
        serviceProbeAt = now
        return true
      }
      const began = Date.now()
      try {
        const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(SERVICE_PROBE_TIMEOUT_MS) : undefined
        const call = (headers: Record<string, string>): Promise<Response> =>
          fetch(`${ep.url}/api/session/active`, { headers, signal })
        await call(ep.auth ? { authorization: ep.auth } : {})
        serviceProbeAlive = true // любой HTTP-ответ = сервис отвечает
      } catch (e) {
        serviceProbeAlive = false // таймаут/отказ соединения = висит или мёртв
        diag.active_error = String(e).slice(0, 200) // та же витрина, что у T73-проба
      } finally {
        serviceProbeAt = Date.now()
        diag.service_alive = serviceProbeAlive
        diag.service_probe_at = new Date().toISOString()
        diag.service_probe_ms = Date.now() - began
      }
      return serviceProbeAlive
    }

    // --------------------------------------------- panel channel (T60) -----
    // Статический HTML в плагин писать не умеет → рантайм держит маленький
    // localhost-сервер: 127.0.0.1, свой порт (listen(0) — свободный, свой у
    // каждого инстанса и не путается с портом OpenCode), CORS
    // Access-Control-Allow-Origin:* — Review-панель открывается с file:// и
    // должна доставать до канала. Порт вшивается в HTML при каждом рендере
    // (renderConsoleHtml ниже) вместе с session_id строк инстансов.
    //   GET  /probe?from=panel  живость канала: страница рисует ✓/✗ в подвале,
    //                           сам факт пробы пишется в DEVATA/panel_channel.json
    //   POST /wake   {session_id}  synthetic владельцу: список его незакрытых задач
    //   POST /blink  {session_id}  toggle мигания title вкладки (сайдбар OpenCode)
    // T43 (drag-priority) добавит сюда POST /order — сервер и CORS уже готовы.
    const SESS_ID = /^ses_[A-Za-z0-9_-]{1,64}$/
    let channelPort: number | null = null
    const panelBootedAt = new Date().toISOString()
    const BLINK_MS = 500 // период ~400-600мс (серия глифов — BLINK_GLYPHS из state.ts, T33 фид её же читает)
    const BLINK_MAX_MISSES = 3 // столько PATCH подряд не прошло — мигание гаснет
    const blinkTimers = new Map<string, { timer: ReturnType<typeof setInterval>; original: string }>()

    // Смена title вкладки: сперва ctx API — в SDK есть SessionDomain.update
    // ({sessionID, title}), если сборка его отдаёт, канал идёт внутри плагина;
    // иначе (или при отказе) — прямой HTTP PATCH как в стенде blink_server.js.
    const sessionUpdate = (ctx.session as { update?: (i: { sessionID: string; title?: string }) => Promise<unknown> })
      .update
    const patchTitle = async (sessionID: string, title: string): Promise<"ctx" | "http"> => {
      if (typeof sessionUpdate === "function") {
        try {
          await sessionUpdate.call(ctx.session, { sessionID, title })
          diag.blink_path = "ctx"
          return "ctx"
        } catch (e) {
          console.error(`[dev-console] blink: ctx.session.update отказал (${String(e)}) — пробую HTTP PATCH`)
        }
      }
      const ep = endpoint()
      if (!ep) throw new Error("no endpoint for PATCH /api/session/{id}")
      const call = (headers: Record<string, string>): Promise<Response> =>
        fetch(`${ep.url}/api/session/${sessionID}`, {
          method: "PATCH",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ title }),
          signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(3_000) : undefined,
        })
      let res = await call(ep.auth ? { authorization: ep.auth } : {})
      if (res.status === 401 && ep.auth) res = await call({}) // локальный сервер и без пароля
      if (!res.ok) throw new Error(`PATCH /api/session/{id} → http ${res.status}`)
      diag.blink_path = "http"
      return "http"
    }

    // ORIGINAL для восстановления: живой Session.Info, иначе запись реестра вкладок.
    // T105: возвращаем ТОЛЬКО нормализованную базу — без портрета-префикса и без
    // ✦/◉/⚡-префиксов. Иначе мигалка prepend-ит глиф к уже грязному title и
    // накапливает их; stopBlink восстанавливал бы грязь.
    const originalTitle = async (sessionID: string): Promise<string> => {
      try {
        const info = (await ctx.session.get({ sessionID })) as { title?: unknown }
        if (typeof info?.title === "string" && info.title.trim() !== "") return normalizeTitle(info.title)
      } catch (e) {
        console.error("[dev-console] blink: session.get:", e)
      }
      try {
        const t = loadLedger(stateFile).tabs.find((x) => x.session_id === sessionID)?.title
        if (t) return normalizeTitle(t)
      } catch {
        /* ниже честно ответим ошибкой */
      }
      return ""
    }

    // Стоп = ORIGINAL обратно (хранится с первого PATCH): повторный клик и wake
    // гасят мигание, как и выгрузка инстанса. Заказ 24.10: ORIGINAL = база С
    // эмодзи-портером (blinkRestore) — гашение вторым кликом возвращает портрет.
    const stopBlink = async (sessionID: string): Promise<boolean> => {
      const b = blinkTimers.get(sessionID)
      if (!b) return false
      clearInterval(b.timer)
      blinkTimers.delete(sessionID)
      try {
        await patchTitle(sessionID, b.original)
        console.log(`[dev-console] blink: ${sessionID} OFF — title восстановлен`)
        return true
      } catch (e) {
        console.error("[dev-console] blink restore:", e)
        return false
      }
    }

    const toggleBlinkNow = async (sessionID: string): Promise<"on" | "off"> => {
      if (blinkTimers.has(sessionID)) {
        await stopBlink(sessionID)
        return "off"
      }
      const base = await originalTitle(sessionID)
      if (base === "") {
        throw new Error("исходный title неизвестен — мигание не включаю, восстанавливать нечего")
      }
      // Заказ 24.10 (три шага + портрет): эмодзи инстанса из записи вкладки —
      // и третьим шагом цикла (САМ эмодзи, без титула), и в ORIGINAL для гашения
      // вторым кликом (раньше normalizeTitle резал портрет и он «не возвращался»).
      let emoji: string | null = null
      try {
        emoji = loadLedger(stateFile).tabs.find((x) => x.session_id === sessionID)?.emoji ?? null
      } catch {
        /* без записи вкладки — цикл на глифах, стоп без портрета */
      }
      const cycle = blinkCycle(base, emoji)
      const original = blinkRestore(base, emoji)
      let step = 0
      let misses = 0
      const tick = (): void => {
        const title = cycle[step++ % cycle.length]
        void patchTitle(sessionID, title)
          .then(() => {
            misses = 0
          })
          .catch((e) => {
            misses += 1
            if (misses >= BLINK_MAX_MISSES) {
              console.error(
                `[dev-console] blink: ${sessionID} — ${misses} PATCH подряд не прошли (${String(e)}), гашу мигание`,
              )
              void stopBlink(sessionID)
            }
          })
      }
      blinkTimers.set(sessionID, { timer: setInterval(tick, BLINK_MS), original })
      tick()
      console.log(
        `[dev-console] blink: ${sessionID} ON (${BLINK_MS}мс) ORIGINAL=${JSON.stringify(original.slice(0, 60))} via=${diag.blink_path ?? "?"}`,
      )
      return "on"
    }

    // Один toggle за вкладку (цепочка): два быстрых клика не плодят интервалы.
    const toggleChain = new Map<string, Promise<unknown>>()
    const toggleBlink = (sessionID: string): Promise<"on" | "off"> => {
      const prev = toggleChain.get(sessionID) ?? Promise.resolve()
      const run = prev.then(
        () => toggleBlinkNow(sessionID),
        () => toggleBlinkNow(sessionID), // прошлый toggle упал — следующий всё равно идёт
      )
      toggleChain.set(
        sessionID,
        run.catch(() => undefined), // в цепочке не остаётся непойманного отказа
      )
      return run
    }

    // ------------------------------------------- авто-мигание (T68) ----------
    // Заказ Основателя 08.10: «пусть мигают инстансы Маруськи, которые
    // простаивают» — вкладка сама начинает мигать при переходе строки в
    // «простаивает» и гаснет при пробуждении (возврат активности: active-сессия,
    // свежий ход, живые агенты, открытая нагрузка). Статус берётся из ТОГО ЖЕ
    // tabStatus/state.ts, что рисует панель (T59/T73 не тронуты), решение —
    // autoBlinkAction (чистое, юнит-тесты в state.test.ts).
    // Гейт T62(3) (вариант «а»): чужие вкладки не показываем — мигают только
    // СВОИ инстансы: projectTabs = ledger.tabs (чужие сессии живут в
    // foreign_sessions и в регистр не попадают), исполнители отфильтрованы T89.
    // T60 (ручное мигание по клику) не трогается: клик /blink сбрасывает
    // авто-флаг, поэтому гаснет/моргает только то, что включило авто-правило,
    // и простой после ручного «погасить» скан не включает заново.
    // Счётчики видны в get_state → runtime.diag: blink_auto_on / blink_auto_off.
    const BLINK_SCAN_MS = 5_000 // ритм скана (пороги статуса — минуты, 5с щадит диск)
    const autoBlinkOn = new Set<string>() // мигание, включённое ЭТИМ правилом (не кликом)
    const prevTabStatus = new Map<string, string>() // прошлый статус строки — ловим СМЕНУ
    let blinkScanAt = 0

    const scanAutoBlink = (): void => {
      try {
        const ledger = loadLedger(stateFile)
        const seen = new Set<string>()
        for (const v of projectTabs(ledger)) {
          seen.add(v.session_id)
          const status = tabStatus(v, ledger, activeGrace ?? activeIds) // T158: грейс — работавшая ≤60с назад ещё «работает»
          const prev = prevTabStatus.get(v.session_id) ?? null
          const blinking = blinkTimers.has(v.session_id)
          const action = autoBlinkAction(
            status,
            prev,
            blinking,
            autoBlinkOn.has(v.session_id),
            isDirectConversation(v.session_id, ledger), // T125: фон не мигает
          )
          prevTabStatus.set(v.session_id, status)
          if (action === "start") {
            void toggleBlink(v.session_id)
              .then((s) => {
                if (s === "on") {
                  autoBlinkOn.add(v.session_id)
                  diag.blink_auto_on += 1
                  console.log(`[dev-console] auto-blink (T68): ${v.session_id} ON — строка «${status}»`)
                }
              })
              .catch((e) =>
                console.error(`[dev-console] auto-blink (T68) ${v.session_id}:`, String(e).slice(0, 200)),
              )
          } else if (action === "stop") {
            autoBlinkOn.delete(v.session_id)
            diag.blink_auto_off += 1
            void stopBlink(v.session_id)
            console.log(`[dev-console] auto-blink (T68): ${v.session_id} OFF — активность вернулась («${status}»)`)
          } else if (!blinking) {
            autoBlinkOn.delete(v.session_id) // мигания нет — флаг нечего держать (PATCH упал/клик)
          }
        }
        // вкладка исчезла из регистра — её статус и флаг больше ничем не кормятся
        for (const id of [...prevTabStatus.keys()]) {
          if (seen.has(id)) continue
          prevTabStatus.delete(id)
          if (autoBlinkOn.delete(id)) void stopBlink(id)
        }
      } catch (e) {
        console.error("[dev-console] auto-blink scan (T68):", e)
      }
    }

    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    }
    const reply = (res: ServerResponse, status: number, body: Record<string, unknown>): void => {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...cors,
      })
      res.end(JSON.stringify(body))
    }
    const readBody = (req: IncomingMessage): Promise<string> =>
      new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        let size = 0
        req.on("data", (c: Buffer) => {
          size += c.length
          if (size > 65_536) {
            reject(new Error("request body too large"))
            req.destroy()
            return
          }
          chunks.push(c)
        })
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
        req.on("error", reject)
      })

    // Живой проб «fetch из панели дошёл»: страница шлёт /probe?from=panel на
    // каждой отрисовке — факт (время, origin) пишется на диск, чтобы проверка
    // читалась файлом, а не на глаз. Панель живёт в 2с-релоаде → запись ≤1/10с.
    const channelLog = join(root, "DEVATA", "panel_channel.json")
    let channelLogAt = 0
    const notePanelProbe = (req: IncomingMessage, probes: number): void => {
      const stamp = Date.now()
      if (stamp - channelLogAt < 10_000) return
      channelLogAt = stamp
      try {
        writeFileSync(
          channelLog,
          `${JSON.stringify(
            {
              ok: true,
              port: channelPort,
              probes,
              since: panelBootedAt,
              last_probe: new Date(stamp).toISOString(),
              origin: typeof req.headers.origin === "string" ? req.headers.origin : null,
              from: "panel",
            },
            null,
            2,
          )}\n`,
          "utf8",
        )
      } catch (e) {
        console.error("[dev-console] panel probe log:", e)
      }
    }

    const handlePanel = (req: IncomingMessage, res: ServerResponse): void => {
      diag.panel_requests += 1
      const path = (req.url ?? "/").split("?")[0]
      const fromPanel = /(?:\?|&)from=panel(?:&|$)/.test(req.url ?? "")
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors)
        res.end()
        return
      }
      if (req.method === "GET" && path === "/probe") {
        diag.panel_probes += 1
        if (fromPanel) notePanelProbe(req, diag.panel_probes)
        reply(res, 200, { ok: true, port: channelPort, since: panelBootedAt, blink: [...blinkTimers.keys()] })
        return
      }
      // T138 (заказ Основателя 29.10): кнопка «погасить мониторы» в шапке панели —
      // гасит фоновые CPU-мониторы инстанса; идемпотентно (повтор = no-op).
      if (req.method === "POST" && path === "/monitors-off") {
        // T164 (заказ Основателя 15.11): кнопка гасит ЭКРАНЫ — как спящий режим
        // машины («чтобы можно было свет отключить»): SC_MONITORPOWER=2. T138-семантика
        // («погасить фоновые CPU-мониторы») ОТМЕНЕНА этим заказом: stopCpuBackground
        // НЕ зовём, сэмплинг живёт, diag.cpu_monitors не трогаем.
        // T176 (16.11): broadcast с SendMessageTimeout — проба 18:46 гасила.
        // T192 (17.11): после ночного ребута broadcast ПЕРЕСТАЛ гасить при тех же
        // 4 зависших окнах (CalculatorApp, Media.Player, PaintStudio, SystemSettings) —
        // SendMessageTimeout возвращал 1 ×3, экраны стояли. Причина: рассылка по
        // HWND_BROADCAST зависит от очереди сообщений чужих окон; надёжнее адресная
        // посылка в окно РАБОЧЕГО СТОЛА. Проба 17.11 (Основатель подтвердил «погасли»):
        // FindWindow("Progman") → SendMessageTimeout(WM_SYSCOMMAND, SC_MONITORPOWER=2,
        // SMTO_ABORTIFHUNG, 5с) ×3 с паузой 700мс + дубль в WorkerW. Фикс = v2.
        try {
          const script =
            "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern IntPtr FindWindow(string cls, string title); [DllImport(\"user32.dll\")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);' -Name W2 -Namespace M2; " +
            "$r=[IntPtr]::Zero; $pm=[M2.W2]::FindWindow('Progman',$null); 1..3 | ForEach-Object { [M2.W2]::SendMessageTimeout($pm, 0x0112, [IntPtr]0xf170, [IntPtr]2, 2, 5000, [ref]$r) | Out-Null; Start-Sleep -Milliseconds 700 }; " +
            "$ww=[M2.W2]::FindWindow('WorkerW',$null); if ($ww -ne [IntPtr]::Zero) { [M2.W2]::SendMessageTimeout($ww, 0x0112, [IntPtr]0xf170, [IntPtr]2, 2, 5000, [ref]$r) | Out-Null }"
          const child = spawn("powershell", ["-NoProfile", "-Command", script], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          })
          // T176: spawn-ошибки (ENOENT и пр.) приходят асинхронно — try/catch их
          // НЕ ловит, endpoint раньше отвечал ok:true при мёртвом спавне.
          child.on("error", (err) => {
            console.log("[dev-console] T192: monitors-off powershell spawn error: " + String(err))
          })
          child.unref()
          diag.screens_off = "off@" + new Date().toISOString()
          console.log("[dev-console] T192: экраны погашены кнопкой панели (Progman-targeted SC_MONITORPOWER=2 ×3 + WorkerW)")
          reply(res, 200, { ok: true, screens: diag.screens_off })
        } catch (e) {
          reply(res, 500, { ok: false, error: String(e) })
        }
        return
      }
      if (req.method !== "POST" || (path !== "/wake" && path !== "/blink" && path !== "/order")) {
        reply(res, 404, { ok: false, error: `unknown route: ${req.method} ${path}` })
        return
      }
      void (async () => {
        const raw = await readBody(req)
        let sessionID = ""
        try {
          const body = JSON.parse(raw === "" ? "{}" : raw) as { session_id?: unknown }
          sessionID = typeof body.session_id === "string" ? body.session_id : ""
        } catch {
          /* ниже — честный 400 */
        }
        if (!SESS_ID.test(sessionID)) {
          reply(res, 400, { ok: false, error: "нужен session_id вида ses_…" })
          return
        }
        if (path === "/wake") {
          const ledger = loadLedger(stateFile)
          await stopBlink(sessionID) // повторное действие: мигание гаснет, title восстанавливается
          autoBlinkOn.delete(sessionID) // T68: разбудили — авто-флаг снят (мигания нет)
          const open = openTasksOf(ledger, sessionID)
          // T106: live = активна ли сессия сейчас (null = API молчит). Закрытая
          // сессия раньше получала 200 «в никуда» — панель честно покажет live:false.
          const live = activeIds ? activeIds.has(sessionID) : null
          try {
            await ctx.session.synthetic({ sessionID, text: wakeMessage(ledger, sessionID) })
          } catch (e) {
            const msg = String(e)
            const notFound = msg.includes("NotFound")
            diag.wake_errors += 1
            diag.wake_last_error = `${sessionID}: ${msg.slice(0, 120)}`
            reply(res, notFound ? 404 : 500, {
              ok: false,
              error: notFound ? "вкладка закрыта — сессия не найдена" : msg.slice(0, 300),
            })
            return
          }
          diag.panel_wake += 1
          if (live === false) diag.wake_last = `доставлено в спящую/закрытую сессию ${sessionID}`
          console.log(`[dev-console] panel /wake → ${sessionID} (открытых задач: ${open.length}, live: ${live})`)
          reply(res, 200, { ok: true, wake: sessionID, tasks: open.length, live })
          return
        }
        if (path === "/order") {
          // T43: drag-and-drop priority reorder
          // body: { session_id: string, task_ids: string[] }
          // task_ids = array of task ids in new order (for tasks with same parent)
          // Validation: all task_ids must be known WAIT tasks with same parent (or null)
          // and must be a permutation of the current set.
          // FIX (рецензия оркестратора): body уже прочитан выше (line ~553 raw) —
          // повторный readBody на исчерпанном потоке ждал 'end' вечно → любой
          // валидный POST /order вис мёртво. Парсим raw.
          let task_ids: string[] = []
          try {
            const body = JSON.parse(raw === "" ? "{}" : raw) as { session_id?: unknown; task_ids?: unknown }
            task_ids = Array.isArray(body.task_ids) ? body.task_ids.filter((x): x is string => typeof x === "string") : []
          } catch {
            reply(res, 400, { ok: false, error: "нужен JSON с task_ids: string[]" })
            return
          }
          if (task_ids.length === 0) {
            reply(res, 400, { ok: false, error: "task_ids не может быть пустым" })
            return
          }
          try {
            const ledger = loadLedger(stateFile)
            // Find the parent of the first task (all must share the same parent)
            const firstTask = ledger.tasks.find((t) => t.id === task_ids[0])
            if (!firstTask) {
              reply(res, 400, { ok: false, error: `задача ${task_ids[0]} не найдена` })
              return
            }
            const parent = firstTask.parent
            // FIX T43: группа = тот же parent И то же состояние (а не только WAIT) —
            // блок клиента собирается в рамках одной секции (секция = состояние),
            // поэтому драг в 🔒 В РАБОТЕ должен валидироваться группой DOING,
            // а в ⚡ ЗАДАЧИ — группой WAIT (как раньше).
            const currentSet = new Set(
              ledger.tasks
                .filter((t) => t.state === firstTask.state && t.parent === parent)
                .map((t) => t.id)
            )
            const newSet = new Set(task_ids)
            // Check that all new ids are in current set
            for (const id of task_ids) {
              if (!currentSet.has(id)) {
                reply(res, 400, { ok: false, error: `задача ${id} не в очереди (${firstTask.state}, тот же parent)` })
                return
              }
            }
            // Check that it's a permutation (same elements)
            if (task_ids.length !== currentSet.size) {
              reply(res, 400, { ok: false, error: "task_ids должен быть перестановкой всех задач этого состояния с этим parent" })
              return
            }
            // Assign priorities based on new order (1, 2, 3...)
            let changed = false
            for (let i = 0; i < task_ids.length; i++) {
              const task = ledger.tasks.find((t) => t.id === task_ids[i])
              if (task && task.priority !== i + 1) {
                task.priority = i + 1
                task.updated_at = new Date().toISOString()
                changed = true
              }
            }
            if (changed) {
              save(ledger)
              console.log(`[dev-console] panel /order → parent=${parent ?? "null"} reordered ${task_ids.length} tasks`)
            }
            reply(res, 200, { ok: true, reordered: task_ids.length, parent })
          } catch (e) {
            console.error("[dev-console] panel /order:", e)
            reply(res, 500, { ok: false, error: String(e).slice(0, 300) })
          }
          return
        }
        const state = await toggleBlink(sessionID)
        // T68: клик основателя — право на мигание всегда за ним: «on» = ручное
        // (авто не снимет его при пробуждении), «off» = погашено (авто не
        // включит заново без смены статуса строки).
        autoBlinkOn.delete(sessionID)
        diag.panel_blink += 1
        reply(res, 200, { ok: true, blink: state, session_id: sessionID, via: diag.blink_path })
      })().catch((e) => {
        console.error(`[dev-console] panel ${path}:`, e)
        reply(res, 500, { ok: false, error: String(e).slice(0, 300) })
      })
    }

    // T140 (11.11, жалоба Основателя «канал 127.0.0.1:53207 ✗ недоступен»):
    // порт канала запечён в CONSOLE_UI.html, а listen(0) выдавал НОВЫЙ
    // эфемерный порт на каждом рестарте сервера → открытая вкладка Отца
    // вечно показывала мёртвый порт. Стабильный порт: берём ПРЕЖНИЙ из реестра
    // серверов (тот же репо → тот же порт между рестартами); занят другим
    // процессом → эфемерный (тогда панель сама перезагрузится по неудачной
    // пробе канала — см. T140 в renderConsoleHtml).
    const preferredChannelPort = ((): number | null => {
      try {
        const raw = readFileSync(join(root, "DEVATA", SERVER_REGISTRY_FILE), "utf8")
        const reg = JSON.parse(raw) as ServerRegistry
        const p = reg[root]?.port ?? reg[`${root}::panel-channel`]?.port ?? null
        return typeof p === "number" && p > 0 ? p : null
      } catch {
        return null
      }
    })()
    const panelServer = await serverGuard.spawn(
      root,
      "panel-channel",
      async () => {
        const server = createServer((req, res) => handlePanel(req, res))
        await new Promise<void>((resolve, reject) => {
          const onError = (e: NodeJS.ErrnoException): void => {
            if (preferredChannelPort && e.code === "EADDRINUSE") {
              server.removeListener("error", onError)
              server.listen(0, "127.0.0.1", () => resolve())
              return
            }
            reject(e)
          }
          server.once("error", onError)
          server.listen(preferredChannelPort ?? 0, "127.0.0.1", () => resolve())
        })
        const addr = server.address()
        const port = typeof addr === "object" && addr !== null ? addr.port : null
        if (port === null) throw new Error("failed to get panel server port")
        return { port, pid: process.pid }
      },
    )
    channelPort = panelServer.port
    diag.panel_port = channelPort
    if (channelPort !== null) {
      console.log(`[dev-console] panel channel (T60): http://127.0.0.1:${channelPort} — /probe /wake /blink ${panelServer.reused ? "(REUSED)" : "(SPAWNED)"}`)
    }

    // ---------------------------------------------- CPU monitor (T95) ---------
    // Background sampling starts when first agent spawns, stops when none alive.
    // Probe before every spawn/dispatch via cpuGate().
    const hasLiveAgents = (): boolean => {
      try {
        const l = loadLedger(stateFile)
        return l.agents.some((a) => a.state === "running" || a.state === "waiting")
      } catch {
        return false
      }
    }

    // Start background CPU sampling (adaptive 30-60s interval, only when agents alive)
    startCpuBackground(hasLiveAgents)

    // Live console pane (Founder gate 04.10.2026): written on every ledger save;
    // the Review pane reloads it every 10s (meta refresh, 5→10 на 24.10 по заказу
    // Основателя: вдвое меньше перезагрузок и проб канала, актуальность ≤10с =
    // частота и так перезаписи файла) — a dashboard that needs
    // no tool call to stay current. Pane failures are cosmetic, never fatal.
    // T140: порт канала меняется при рестарте сервера — панель хранит его в HTML.
    // Рендер переписывается при сейве леджера, но если леджер молчит, порт в
    // HTML остаётся мёртвым (вкладка Основателя: «канал ✗ недоступен»).
    // Поэтому помним последний отрендеренный порт и перерендерим при смене.
    let lastRenderedPort: number | null = null
    const renderPane = (l: Ledger): void => {
     try {
      lastRenderedPort = channelPort
      void refreshBranch() // ветка догонит к следующей записи
      void refreshActive() // рендер = повод обновить active-список (с троттлингом ACTIVE_GAP_MS)
      // T95: probe CPU on every render (lightweight - only when agents alive)
      if (hasLiveAgents()) void probeAndUpdate() // T98: async-проба, render не ждёт (не блокирует event loop)
      const cpuState = getCpuState()
      try {
        // Канал T60: порт сервера + session_id строк инстансов в том же порядке,
        // в каком project() выстроит их строки (projectTabs, сортировка по last_seen).
        const channel: PanelChannel = {
          port: channelPort,
          tabIds: projectTabs(l).map((t) => t.session_id),
        }
        writeFileSync(
          htmlFile,
          renderConsoleHtml(
            project(l, activeGrace ?? activeIds, stateFile, repoSpeedCurrent, instanceSpeedCurrent, cpuState.warning, cpuState.hardStop, cpuState.lastSample?.pct ?? null, quotaUsage()).ui,
            l.updated_at,
            l.agents.filter((a) => a.state === "running" || a.state === "waiting"),
            loc,
            channel,
            l.tasks, // T39: pass all tasks for plan markers
            l.foreign_sessions, // T62: foreign sessions for collapsed line
            loadComplaints(root), // T124: канал жалоб на фреймворк
          ),
          "utf8",
        )
      } catch (e) {
        console.error("[dev-console] console pane:", e)
        try {
          writeFileSync(join(root, "DEVATA", "render_error.log"), "render failed: " + String(e && e.stack ? e.stack : e) + "\n", "utf8")
        } catch { /* лог-файл не пишется — не страшно */ }
      }
     } catch (e) {
      // T140: падение рендера не должно быть молчаливым — иначе панель
      // замирает со старым портом, и Основатель видит «канал ✗ недоступен».
      console.error("[dev-console] console pane (outer):", e)
      try {
        writeFileSync(join(root, "DEVATA", "render_error.log"), "renderPane failed: " + String(e && e.stack ? e.stack : e) + "\n", "utf8")
      } catch { /* лог-файл не пишется — не страшно */ }
     }
    }
    // T135: версия состояния для дельт get_state (растёт на каждом сейве) +
    // что каждый вызывающий уже потребил (в памяти — рестарт = снова full).
    let stateVersion = 0
    const stateSeen = new Map<string, { version: number; sigs: StateSigs; calls: number }>()
    const save = async (l: Ledger): Promise<void> => {
      // T62: include foreign sessions in ledger before saving
      const foreignList = Array.from(foreignSessions.entries())
        .filter(([, v]) => Date.now() - v.lastSeen < FOREIGN_TTL_MS)
        .map(([k, v]) => ({ session_id: k, title: v.title, last_seen: v.lastSeen }))
      // T104(1): чужой = доказано — своя вкладка не попадает в 🌍 ЧУЖИЕ,
      // даже если запись уже затесалась в реестр раньше.
      l.foreign_sessions = dropOwnFromForeign(foreignList, l.tabs)
      await saveQueued(l) // T62: serialized atomic save (single writer)
      stateVersion += 1 // T135: снапшот сдвинулся — дельты это увидят
      renderPane(l)
    }
    // Проб + перерисовка, если живой список изменился (смена статуса строки
    // вкладки должна доехать до панели без записи в леджер).
    const refreshActive = async (): Promise<void> => {
      try {
        if (await probeActive()) renderPane(loadLedger(stateFile))
      } catch (e) {
        console.error("[dev-console] active probe:", e)
      }
    }

    // ---------------------------------------------- repo speed (T80) -----
    // Repo-level code velocity metric from git numstat.
    // Measurement triggered on runtime events (step/turn/activity) with
    // ≥60s interval guard (sliding window per §4.3).
    // Only git plumbing — no file content reads.
    const REPO_SPEED_MIN_INTERVAL_MS = 60_000
    let repoSpeedPrev: {
      additions: number
      deletions: number
      files: number
      editEvents: number
      at: number
    } | null = null
    let repoSpeedCurrent: RepoSpeed | null = null
    let repoSpeedLastMeasure = 0
    // T80: счётчик событий пиши-инструмента (session.tool.called с path/file,
    // не read) — Δ/Δt = эдиты/сек по событиям (точнее Δфайлов: множество
    // изменённых файлов в репо почти статично, а события пишут при каждой правке).
    let repoEditEvents = 0
    let languagePctCache: Record<string, number> | null = null
    let languagePctLastUpdate = 0
    const LANGUAGE_PCT_TTL_MS = 5 * 60_000 // 5 min cache for language %

    const measureRepoSpeed = async (): Promise<RepoSpeed | null> => {
      try {
        const now = Date.now()
        // Git numstat
        const numstatOut = execFileSync("git", ["-C", root, "diff", "--numstat", "HEAD"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        }).trim()
        // files (число строк numstat) → editsPerSec в calcRepoSpeed (T80: эдиты/сек)
        const { additions, deletions, files } = parseNumstat(numstatOut)
        // Git ls-files for language % (cached)
        if (!languagePctCache || now - languagePctLastUpdate > LANGUAGE_PCT_TTL_MS) {
          const lsFilesOut = execFileSync("git", ["-C", root, "ls-files"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            windowsHide: true,
          }).trim()
          languagePctCache = parseLsFiles(lsFilesOut)
          languagePctLastUpdate = now
        }
        const curr = { additions, deletions, files, editEvents: repoEditEvents, at: now }
        const speed = calcRepoSpeed(repoSpeedPrev, curr)
        if (languagePctCache) speed.languagePct = languagePctCache
        if (speed.valid) repoSpeedCurrent = speed
        // Baseline slides on EVERY measurement (T80-fix 20:35: раньше стоял
        // только под if(speed.valid) → при prev=null valid=false всегда →
        // база не сохранялась и метрика не появлялась никогда; вызовы и так
        // ограничены ≥60с сверху — maybeMeasureRepoSpeed + guard при загрузке).
        repoSpeedPrev = curr
        repoSpeedLastMeasure = now
        return speed
      } catch (e) {
        console.error("[dev-console] repo speed measure:", e)
        return null
      }
    }

    // Trigger measurement on runtime events (step/turn/activity) with ≥60s guard.
    const maybeMeasureRepoSpeed = async (): Promise<void> => {
      const now = Date.now()
      if (now - repoSpeedLastMeasure >= REPO_SPEED_MIN_INTERVAL_MS) {
        await measureRepoSpeed()
      }
    }

    // ---------------------------------------------- instance speed (T81) -----
    // Per-instance code velocity metrics from session.diff polling and event-stream.
    // Polling: GET /api/session/:id/diff for top-tab sessions (interval 30-60s, window ≥60s).
    // Events: session.tool.called (edit/write with path) and session.step.ended.files.
    // Sliding window ≥60s per §4.3 of RESOURCES_SPEED_CODE.md.
    // T81-фикс (оркестратор 22:00): prev скользит на КАЖДОМ поллинге → окно
    // между замерами = интервалу поллинга; при 45с оно всегда < 60с и valid не
    // собирался НИКОГДА (класс бага T80). Интервал ставим > окна (61с).
    const INSTANCE_SPEED_POLL_MS = 300_000 // T129-вариант1 (29.10): 61с→300с — каждый /diff гоняет VCS-диффы всех тёрнов (CPU); must be > INSTANCE_SPEED_WINDOW_MS
    const INSTANCE_SPEED_WINDOW_MS = 60_000 // minimum window
    let instanceSpeedPrev: Map<string, { additions: number; deletions: number; at: number }> = new Map()
    let instanceSpeedCurrent: Map<string, InstanceSpeed> = new Map()
    let instanceSpeedLastPoll = 0
    let instanceEditEvents: Array<{ sessionId: string; file: string; at: number }> = []
    let instancePollTimer: ReturnType<typeof setInterval> | null = null
    // T118: активное время по событиям (в памяти), сброс в леджер — на поллинге.
    const effActivityAcc = new Map<string, { ms: number; since: number; last: number }>()

    // Fetch session.diff for a given session (per-instance lines added/deleted).
    const fetchSessionDiff = async (sessionId: string): Promise<{ additions: number; deletions: number } | null> => {
      const ep = endpoint()
      if (!ep) return null
      try {
        const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(45_000) : undefined
        const call = (headers: Record<string, string>): Promise<Response> =>
          fetch(`${ep.url}/api/session/${sessionId}/diff?context=0`, { headers, signal })
        let res = await call(ep.auth ? { authorization: ep.auth } : {})
        if (res.status === 401 && ep.auth) res = await call({})
        if (!res.ok) throw new Error(`http ${res.status}`)
        const data = (await res.json()) as { data?: Array<{ additions?: number; deletions?: number }> }
        const files = data?.data ?? []
        let additions = 0, deletions = 0
        for (const f of files) {
          if (typeof f.additions === "number") additions += f.additions
          if (typeof f.deletions === "number") deletions += f.deletions
        }
        return { additions, deletions }
      } catch (e) {
        // Per research A56: if endpoint unavailable, don't fabricate — mark as no source.
        // We just return null and the metric will stay invalid.
        return null
      }
    }

    // Poll instance speed for all top-tab sessions (non-executor tabs).
    const pollInstanceSpeed = async (): Promise<void> => {
      const now = Date.now()
      if (now - instanceSpeedLastPoll < INSTANCE_SPEED_POLL_MS) return
      instanceSpeedLastPoll = now

      const ledger = loadLedger(stateFile)
      let effDirty = false // T118: были ли дельты работы/активности — под них одна запись
      const tabViews = projectTabs(ledger)
      for (const v of tabViews) {
        const diff = await fetchSessionDiff(v.session_id)
        if (!diff) continue // endpoint unavailable — no source, don't fabricate
        const prev = instanceSpeedPrev.get(v.session_id) ?? null
        const curr = { additions: diff.additions, deletions: diff.deletions, at: now }
        instanceSpeedPrev.set(v.session_id, curr)

        // Calculate speed with edit events in window
        const windowStart = now - INSTANCE_SPEED_WINDOW_MS
        // Filter edit events for this session in the current window
        const sessionEditEvents = instanceEditEvents.filter(
          (e) => e.sessionId === v.session_id && e.at >= windowStart && e.at <= now
        )
        const speed = calcInstanceSpeed(prev, curr, sessionEditEvents, windowStart)
        if (speed.valid) instanceSpeedCurrent.set(v.session_id, speed)
        // T118: работа = Δ(+/−) numstat → durable накопители вкладки (база в
        // леджере; первый после рестарта замер только снимает базу — не дублируем).
        if (noteTabEffWork(ledger, v.session_id, { additions: diff.additions, deletions: diff.deletions }, new Date(now).toISOString())) effDirty = true
      }
      // Не даём счётчику событий расти неограниченно: окно метрики 60с,
      // запас на пропущенные циклы — 10 мин; дальше события не нужны.
      instanceEditEvents = instanceEditEvents.filter((e) => e.at >= now - 600_000)
      // T118: сброс активного времени (события → леджер, durable) тем же циклом.
      if (flushTabEffActivity(ledger, effActivityAcc)) effDirty = true
      if (effDirty) save(ledger)
    }

    // T129-вариант1 (декрет Основателя 29.10): поллинг ОСТАВЛЕН ради сумм
    // +N −M в строках инстансов, но интервал 61с→300с — каждый GET
    // /api/session/:id/diff заставляет opencode-VCS диффить ВСЕ тёрны сессии
    // (старые снапшот-коммиты с node_modules ANYAsite ~11к файлов = сотни
    // git-спавнов/мин при 61с). Скорости (строк/сек, эдитов/сек) из шапки и
    // инстансов убраны там же — state.ts T129.
    instancePollTimer = setInterval(pollInstanceSpeed, INSTANCE_SPEED_POLL_MS)
    // Первый замер — сразу, чтобы суммы были на первой отрисовке.
    void pollInstanceSpeed()

    await refreshBranch() // ветка уже известна первой отрисовке
    await refreshActive() // первый проб до первой отрисовки (diag.active_api уже виден)
    // Initial repo speed measurement
    await measureRepoSpeed()
    renderPane(loadLedger(stateFile)) // initial dashboard at plugin load

    // T58: watch AGENT_CHAT.md for changes → re-render panel to show new chat lines
    const chatPath = join(root, "DEVATA", "AGENT_CHAT.md")
    let chatWatchTimer: ReturnType<typeof setTimeout> | null = null
    const maybeWatchChat = (): void => {
      if (!existsSync(chatPath)) return
      try {
        const watcher = watch(chatPath, { persistent: false }, (eventType) => {
          if (eventType === "change") {
            // Debounce rapid writes: re-render once after quiet period
            if (chatWatchTimer) clearTimeout(chatWatchTimer)
            chatWatchTimer = setTimeout(() => {
              renderPane(loadLedger(stateFile))
            }, 100)
          }
        })
        // Watcher cleanup on plugin unload is handled by returning a cleanup fn below
        // Store watcher reference for cleanup
        ;(globalThis as any).__chatWatcher = watcher
      } catch (e) {
        console.error("[dev-console] chat watch:", e)
      }
    }
    maybeWatchChat()

    const read = (): { ledger: Ledger; projection: Projection } => {
      const ledger = loadLedger(stateFile)
      const cpuState = getCpuState()
      return { ledger, projection: project(ledger, activeGrace ?? activeIds, stateFile, repoSpeedCurrent, instanceSpeedCurrent, cpuState.warning, cpuState.hardStop, cpuState.lastSample?.pct ?? null, quotaUsage()) }
    }

    // An agent's truth is its child session: settle by child-session id
    // (called from the event stream below — never from model assertion).
    // T46 (живой образец 07.10 02:47: A23/T53 умер по Rate limit): смерть
    // сессии сильнее раннего settle — запись уходит в failed, задача получает
    // пометку agent_error, ETA-план снимается, вкладка-владелец будится с
    // agent_error (не «успехом»).
    // T52 (живой образец 07.10 01:34: A19 помечен completed, пока агент
    // дорабатывал T34): succeeded-путь сюда больше не идёт — ход ≠ конец,
    // закрытие только по terminal-условию (settleTurn/scanTerminalSettles).
    // Свежесть последнего события сессии — общий словарь для обоих путей.
    const sessionActivity = new Map<string, number>() // session_ref → мс последнего события
    const noteSessionActivity = (ref: string | null | undefined, at: number = Date.now()): void => {
      if (ref?.startsWith("ses_")) sessionActivity.set(ref, at)
    }
    // T97(а): отчёт ребёнка из ЕГО сессии — последний assistant-текст; пусто/
    // ошибка чтения → null (тогда приёмка получит NO_SELF_REPORT).
    const selfReportText = async (sessionID: string): Promise<string | null> => {
      try {
        const messages = (await ctx.session.context({ sessionID })) as unknown
        const arr = Array.isArray(messages) ? (messages as { type?: string; payload?: unknown }[]) : []
        const last = [...arr].reverse().find((m) => m.type === "assistant")
        if (!last) return null
        const payload = last.payload as
          | { parts?: { type?: string; text?: string }[]; content?: { type?: string; text?: string }[] }
          | undefined
        const segs = payload?.parts ?? payload?.content
        const text = segs
          ?.filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text)
          .join("\n")
        return text && text.trim() ? text : null
      } catch {
        return null // сессия недоступна — отчёта нет, ставим пометку
      }
    }
    // T97(а): авто-приёмка — вычитанный отчёт (или no-self-report) уходит в
    // verification задачи, пока она открыта; ручная приёмка не перетирается.
    const settleSelfReport = (taskId: string, ref: string, status: "completed" | "failed"): void => {
      void (async () => {
        const report = ref?.startsWith("ses_") ? await selfReportText(ref) : null
        const l = loadLedger(stateFile)
        const t = applySelfReport(l, taskId, report)
        if (t) {
          save(l)
          console.log(
            `[dev-console] T97: ${taskId} verification ← ${report ? "отчёт из сессии" : `NO_SELF_REPORT (${status})`}`,
          )
        }
      })().catch((e) => console.error("[dev-console] T97 self-report:", e))
    }
    // T97(в): ход ребёнка без единого tool-вызова → счётчик пустых первых
    // сообщений; N подряд → пометка orientation-hell (первый tool-вызов её
    // снимает навсегда). Считаем на границе хода (execution.succeeded).
    const turnHadTool = new Map<string, boolean>() // session_ref → был ли tool-вызов в этом ходу
    const noteOrientation = (ref: string): void => {
      try {
        const l = loadLedger(stateFile)
        const rec = l.agents.find((x) => x.session_ref === ref)
        if (!rec) return
        const before = `${rec.orientation}:${rec.empty_first ?? 0}`
        const a = noteOrientationCheck(l, ref, turnHadTool.get(ref) ?? false)
        turnHadTool.delete(ref)
        if (!a || `${a.orientation}:${a.empty_first ?? 0}` === before) return // ничего не изменилось
        save(l)
        if (a.orientation === "hell") {
          console.warn(
            `[dev-console] T97: ${a.id} (${a.label}) orientation-hell — ` +
              `${a.empty_first} первых сообщений без tool-вызова (нужен был tool-первым действием)`,
          )
        }
      } catch (e) {
        console.error("[dev-console] T97 orientation:", e)
      }
    }
    // Единая обёртка закрытия: запись (внутри — снятие ETA-плана, план снимается
    // только вместе с реально закрытым агентом) + счётчик + будильник владельца.
    // T41/T93: durable counters (edit_count, injection_count) are read from agent record.
    const commitSettle = (ledger: Ledger, agent: Agent, status: "completed" | "failed", ref: string): void => {
      // T41/T93: record settle time for earlySettle detection (activity after settle)
      const settleAt = Date.now()
      sessionSettleTime.set(ref, settleAt)
      // T41/T93: durable counters from agent record (persisted in ledger, survive plugin reloads)
      const editCount = agent.edit_count ?? 0
      // T92: injections считаются дельно (noteInjection: диспатч-промпт/ETA) и
      // читаются из записи при settle самим computeCounters — здесь не нужны.
      
      // T66: итог исполнителя кормит обучаемый выбор модели (таблица в ledger).
      // T150: успех — всегда в статистику модели; ПРОВАЛ засчитывает модель
      // только сама (rate limit / no such model) — и это делает wakeAgentError,
      // где класс ошибки уже известен (здесь его ещё нет).
      if (agent.model && status === "completed") recordModelResult(ledger, agent.model, true)
      // T150 (дефект, найден ритуалом 11.11): кулдаун за failed здесь БЫЛ
      // безусловным — рестарт сервиса/обрыв сети «наказывали» исправную модель
      // (карантин вставал на все модели, обучаемый выбор шёл «по больному»).
      // Теперь кулдаун ставит ТОЛЬКО классифицированный отказ модели — в
      // wakeAgentError (rate limit / no such model), где известен класс смерти.
      // ПРОВАЛ по вине модели пишет туда же (recordModelResult kind="model").
      
      // T84: per-class model stats — compute edits/sec and task class
      if (agent.model && agent.task_id) {
        const task = ledger.tasks.find((t) => t.id === agent.task_id)
        if (task) {
          const cls = taskClass(ledger, task)
          const began = Date.parse(agent.began_at)
          const durationSec = Math.max(1, (settleAt - began) / 1000)
          const editsPerSec = editCount / durationSec
          if (status === "completed") recordModelResultByClass(ledger, agent.model, cls, true, editsPerSec, undefined, false)
        }
      }
      
      save(ledger)
      // T117: демон закрылся — тема вкладки меняется (что делает инстанс).
      void refreshActivityTitles()
      diag.events_settled += 1
      console.log(`[dev-console] stage2: agent ${agent.id} → ${agent.state} (event)`)
      // T97(а) settle-гардия: итог принудительно фиксируется в леджере ДО того,
      // как его кто-то вычитает руками — отчёт ребёнка уходит в verification
      // задачи, отчёта нет → пометка no-self-report (для failed так же: док мог
      // быть сдан до смерти сессии, кейс A88).
      if (agent.task_id) settleSelfReport(agent.task_id, ref, status)
      if (status === "failed") {
        if (agent.task_id) wakeAgentError(agent.task_id, agent.id, `session.execution.${status} — сессия мертва`)
      } else if (agent.task_id && dispatchedSessions.has(ref)) {
        // A dispatched executor finished: wake the orchestrator with the result.
        wakeOrchestrator(agent.task_id, agent.id, ref, status)
      }
    }
    const settleBySession = (childSessionID: string, status: "completed" | "failed"): void => {
      try {
        const ledger = loadLedger(stateFile)
        const agent = settleEvent(ledger, status, childSessionID, `session.execution.${status}`)
        if (agent) commitSettle(ledger, agent, status, childSessionID)
      } catch (e) {
        console.error("[dev-console] stage2 settle:", e)
      }
    }

    // T52: «ход завершился» ≠ «сессия завершилась». Закрытие только по
    // terminal-условию из state.ts: сессии нет в GET /api/session/active
    // (T73-проба) И последнее событие сессии старше SETTLE_IDLE_MS. Сразу после
    // succeeded активность уже отмечена → условие ложно, агент остаётся
    // running: панель показывает живого агента, ETA-план не снят, повторного
    // диспатча на те же файлы нет.
    const settleTurn = (ref: string, reason: string): void => {
      try {
        const ledger = loadLedger(stateFile)
        // T41/T93: durable counters from agent record (persisted in ledger, survive plugin reloads)
        const agentRecord = ledger.agents.find((a) => a.session_ref === ref)
        const editCount = agentRecord?.edit_count ?? 0
        const emptyRun = editCount === 0
        // earlySettle: check if session had activity after the previous settle time
        const settleAt = sessionSettleTime.get(ref)
        const lastActivity = sessionActivity.get(ref)
        const earlySettle = settleAt !== undefined && lastActivity !== undefined && lastActivity > settleAt
        // T92: injections берутся computeCounters из durable injection_count записи
        const agent = settleOnTurn(ledger, ref, activeIds, sessionActivity.get(ref) ?? null, reason, undefined, { emptyRun, earlySettle })
        if (agent) {
          sessionActivity.delete(ref)
          commitSettle(ledger, agent, "completed", ref)
        }
      } catch (e) {
        console.error("[dev-console] turn settle:", e)
      }
    }

    // T52: уход из active событием не приходит (это проба T73), поэтому та же
    // terminal-проверка едет фоном вместе с опросом active. active === null
    // (API молчит) → условие «ушёл» не доказано, скан молчит; чужие и уже
    // закрытые записи не трогаются — settleOnTurn матчит только ses_-реf живых.
    // T90 (ZOMBIE-RECORD 07.10): записи без ses_-рефа никогда не закрывались —
    // ветка для running/waiting с пустым/не-ses_ рефом: если задача в DONE ИЛИ
    // запись старше 2×SETTLE_IDLE_MS от began_at/updated_at → закрыть completed
    // с reason «зомби: реф неизвестен». Задачи WAIT/DOING/BLOCKED/GATE не трогаем.
    const SETTLE_SCAN_MS = 5_000 // ритм скана: порог тишины в минутах, 5с достаточно
    let settleScanAt = 0
    const scanTerminalSettles = (): void => {
      diag.scan_calls += 1
      diag.scan_last = Date.now()
      if (activeIds === null) {
        diag.scan_err = "activeIds=null (API молчит)"
        return
      }
      try {
        diag.scan_err = null
        const ledger = loadLedger(stateFile)
        const live = new Set<string>()
        const now = Date.now()
        for (const a of ledger.agents) {
          if (a.state !== "running" && a.state !== "waiting") continue
          const ref = a.session_ref
          if (!ref?.startsWith("ses_")) {
            // T90: zombie record — no provable session. Решение — чистая
            // функция в state.ts (тестируется): задача DONE ИЛИ возраст
            // записи > 2×SETTLE_IDLE_MS; живые задачи не трогаем.
            const task = a.task_id ? ledger.tasks.find((t) => t.id === a.task_id) : undefined
            const reason = zombieSettleReason(a, task, now)
            if (reason) {
              // T41/T93: durable counters from agent record (persisted in ledger, survive plugin reloads)
              const editCount = a.edit_count ?? 0
              const emptyRun = editCount === 0
              // T92: injections берутся computeCounters из durable injection_count записи
              const settled = settleOnEvent(ledger, "completed", ref, reason, { emptyRun })
              if (settled) {
                unscheduleEta(settled.id)
                commitSettle(ledger, settled, "completed", ref ?? `(unknown)`)
              }
            }
            continue
          }
          live.add(ref)
          // T41/T93: compute metrics for scan settle using durable counters from agent record
          const editCount = a.edit_count ?? 0
          const emptyRun = editCount === 0
          const settleAt = sessionSettleTime.get(ref)
          const lastActivity = sessionActivity.get(ref)
          const earlySettle = settleAt !== undefined && lastActivity !== undefined && lastActivity > settleAt
          // T92: injections берутся computeCounters из durable injection_count записи
          const agent = settleOnTurn(ledger, ref, activeIds, sessionActivity.get(ref) ?? null, undefined, undefined, { emptyRun, earlySettle })
          if (agent) {
            sessionActivity.delete(ref)
            commitSettle(ledger, agent, "completed", ref)
            continue
          }
          // T97(б) скан-подстраховка: settle-событие НЕ доехало (кейсы A63/A88/
          // A91), а сессия доказанно завершена — нет в active И тишина в её
          // событиях дольше порога — задача висит DOING дольше N мин →
          // авто-settle с reason «no-self-report»; отчёт (если он в сессии есть)
          // в verification досыпает гардия в commitSettle.
          const rec = ledger.agents.find((x) => x.session_ref === ref)
          if (rec && (rec.state === "running" || rec.state === "waiting")) {
            const lastAct = sessionActivity.get(ref) ?? Date.parse(rec.updated_at)
            const quiet = !Number.isFinite(lastAct) || now - lastAct > NO_SELF_REPORT_MIN * 60_000
            const sessionAlive = activeIds.has(ref) || !quiet
            const task = rec.task_id ? ledger.tasks.find((t) => t.id === rec.task_id) : undefined
            const reason = noSelfReportReason(rec, task, sessionAlive, now)
            if (reason) {
              // T92: injections берутся computeCounters из durable injection_count записи
              const settled = settleOnEvent(ledger, "completed", ref, reason, { emptyRun })
              if (settled) {
                unscheduleEta(settled.id)
                commitSettle(ledger, settled, "completed", ref)
              }
            }
          }
        }
        for (const ref of [...sessionActivity.keys()]) if (!live.has(ref)) sessionActivity.delete(ref)
      } catch (e) {
        diag.scan_err = String(e).slice(0, 200)
        console.error("[dev-console] terminal scan:", e)
      }
    }

    // -------------------------------------------------- dispatcher (tool) ----
    // `set_state DOING` (or `update` on a DOING task) with an `owner` set — the
    // runtime itself spawns the background executor and owns its whole stream:
    // record from birth (session_ref = child id), settlement from session events,
    // orchestrator woken with the result. Judgment (who executes) stays with the
    // model; mechanics (spawn, track, settle, wake) live here.
    const DISPATCH_AGENT = "general"
    // Owner → pinned model (Founder gate 04.10.2026 → amended 22.10.2026):
    // qc пин Гольфии не касается — glm-free. dev/research пины СНЯТЫ 16.11
    // (вердикт Основателя «снять пин»): пин dev/research→mimo-free жал детей
    // на спавне (A167–A187, upstream-флап), выбор честно делает
    // chooseModelByClass по живому каталогу + model_health (карантины).
    const OWNER_MODEL: Record<string, string> = { qc: "opencode/glm-5.3-flash-free" } // T142 (декрет 29.10 ~10:45): пин субaгента = ТОЛЬКО *-free; премиум Go-тройке детям закрыт гардом childModelAllowed
    let lastTopSession: string | null = null // the orchestrator thread of the current turn
    const dispatchedSessions = new Set<string>()

    // ------------------------------------------------------- attribution -----
    // Атрибуция вкладок (T34): create помечает задачу своей сессией
    // (Task.session_ref) — wake/ETA уходят вкладке-владельцу задачи.
    // lastTopSession остаётся только фолбэком (задача создана до атрибуции
    // либо в неизвестной сессии).
    const ownerTab = (taskId: string | null | undefined): string | null => {
      if (taskId) {
        try {
          const t = loadLedger(stateFile).tasks.find((x) => x.id === taskId)
          if (t?.session_ref) return t.session_ref
        } catch (e) {
          console.error("[dev-console] owner tab:", e)
        }
      }
      return lastTopSession
    }

    // ------------------------------------------------------- wake router ----
    // T53 — событийные пробуждения вместо таймерного опроса:
    //   (1) периодического «бдения» верхнего агента НЕТ: будим только по
    //       событию (settle диспетчерного агента, ETA-план, agent_error из
    //       T46, двойной порог из T48, результат диспатча, общий инцидент);
    //       heartbeat «всё ок» — это шум и токены, он запрещён;
    //   (2) маршрутизация: wake → вкладке-владельцу задачи (атрибуция T34),
    //       общий инцидент (упавший сервер и т.п.) → broadcast всем
    //       top-вкладкам репо — та же механика ctx.session.synthetic,
    //       отдельной системы подписок нет;
    //   (3) дедуп: одно событие = одно пробуждение (ключ события глушится
    //       повторно в окне WAKE_DEDUP_MS; ключи живут в DEVATA/wake_keys.json,
    //       чтобы пережить hot-reload плагина).
    // Все источники зовут ТОЛЬКО wake() — единственный точка отправки.
    const WAKE_DEDUP_MS = 120_000
    const wakeKeysFile = join(root, "DEVATA", "wake_keys.json")
    const loadWakeKeys = (): Record<string, number> => {
      try {
        if (!existsSync(wakeKeysFile)) return {}
        const v = JSON.parse(readFileSync(wakeKeysFile, "utf8")) as unknown
        return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, number>) : {}
      } catch (e) {
        console.error("[dev-console] wake keys read:", e)
        return {}
      }
    }
    const saveWakeKeys = (keys: Record<string, number>): void => {
      try {
        writeFileSync(wakeKeysFile, JSON.stringify(keys), "utf8")
      } catch (e) {
        console.error("[dev-console] wake keys write:", e)
      }
    }
    // Адресаты broadcast: все top-вкладки репо (T34-регистр) без исполнителей.
    const topTabs = (): string[] => {
      try {
        const l = loadLedger(stateFile)
        return l.tabs.filter((t) => !isExecutorSession(l, t.session_id)).map((t) => t.session_id)
      } catch (e) {
        console.error("[dev-console] wake tabs:", e)
        return []
      }
    }
    const wake = (key: string, scope: "tab" | "broadcast", text: string, taskId?: string | null): void => {
      const now = Date.now()
      const keys = loadWakeKeys()
      let pruned = false
      for (const [k, at] of Object.entries(keys)) {
        if (typeof at !== "number" || now - at > WAKE_DEDUP_MS) {
          delete keys[k]
          pruned = true
        }
      }
      if (key in keys) {
        diag.wakes_deduped += 1
        console.log(`[dev-console] wake: dedup '${key}'`)
        if (pruned) saveWakeKeys(keys)
        return
      }
      keys[key] = now
      saveWakeKeys(keys)
      const targets = [
        ...new Set(scope === "broadcast" ? topTabs() : [ownerTab(taskId ?? null)].filter((x): x is string => !!x)),
      ]
      diag.wakes += 1
      diag.wake_last = `${key} → ${targets.length} tab(s)`
      console.log(
        `[dev-console] wake '${key}' → ${targets.length} tab(s)${scope === "broadcast" ? " [broadcast]" : ""}`,
      )
      for (const t of targets) {
        void ctx.session.synthetic({ sessionID: t, text }).catch((e) => console.error(`[dev-console] wake ${t}:`, e))
      }
    }
    // Общий инцидент (не сессия, не задача): сервер/workspace рухнули —
    // вкладки-владельца у такого события нет → broadcast всем top-вкладкам.
    // Только явные сбои: location.shutdown и прочие lifecycle-события — это
    // рутинный шум (наблюдение живьём: событие сыплется при каждой перезагрузке).
    const INCIDENT = /^(server|workspace|worktree)\..*(failed|error|broken|unavailable|crashed)$/

    // Wake the orchestrator when a dispatched executor settles. The result text
    // comes from the child's message history — prompt() resolves at delivery,
    // NOT at completion (verified live), so the wake is timed by session events.
    const wakeOrchestrator = (taskId: string, agentId: string, sessionID: string, status: string): void => {
      // Кому: вкладке-владельцу задачи (create-marked session_ref); фолбэк —
      // вкладка, инжектированная последней. Владелец правит глобальным
      // lastTopSession, который больше не единственный адресат.
      const target = ownerTab(taskId)
      if (!target) return
      void (async () => {
        let result = "(result unavailable)"
        try {
          const messages = (await ctx.session.context({ sessionID })) as unknown
          const arr = Array.isArray(messages) ? (messages as { type?: string; payload?: unknown }[]) : []
          const fromEnd = [...arr].reverse()
          const last = fromEnd.find((m) => m.type === "assistant") ?? fromEnd.find((m) => m.type !== "user")
          const payload = last?.payload as
            | { parts?: { type?: string; text?: string }[]; content?: { type?: string; text?: string }[] }
            | undefined
          const segs = payload?.parts ?? payload?.content
          const text = segs
            ?.filter((p) => p.type === "text" && typeof p.text === "string")
            .map((p) => p.text)
            .join("\n")
          result = (text && text.trim() ? text : JSON.stringify(payload ?? last ?? "")).slice(0, 1200)
        } catch {
          /* keep the placeholder */
        }
        wake(
          `settle:${taskId}:${agentId}:${status}`,
          "tab",
          `DEV CONSOLE dispatch: ${taskId} (${agentId}) ${status}. Result: ${result}\n` +
            "Verify it and record the outcome (DONE needs verification).",
          taskId,
        )
      })().catch((e) => console.error("[dev-console] dispatch notify:", e))
    }

    // ------------------------------------------------ ETA plan (timer) ------
    // Every subagent gets a plan at begin (learned from its kind's history —
    // self-reflection lives in the tool, per Founder order, not in the skill).
    // On expiry: the child is asked for a self-report (the proven prompt
    // channel) and the orchestrator gets a wake. Timers rehydrate on plugin
    // load below — a restart can't lose the plan.
    // T92: «цена контекста задачи» — единственный писатель injection_count.
    // Инжект = контекст, который рантайм ДЕЙСТВИТЕЛЬНО запустил в сессию агента
    // (диспатч-промпт по доставке, ETA-самоотчёт). Проекция топ-вкладок сюда не
    // считается: у вкладки нет записи Agent (дети/исполнители return'ят выше),
    // её счёт — diag.injections, диагностика вкладки, не задачи. Раньше счётчик
    // читал sessionInjections[child-ref] → структурный 0 (defect T41).
    const bumpInjection = (ref: string | null | undefined): void => {
      try {
        const l = loadLedger(stateFile)
        if (noteInjection(l, ref) > 0) save(l)
      } catch (e) {
        console.error("[dev-console] T92 injection bump:", e)
      }
    }
    const etaTimers = new Map<string, ReturnType<typeof setTimeout>>()
    // T128: дубль-буждение по ПОРОГУ переработки — факт ≥ 3× плана (= overrun
    // ≥ 2× плана). Не kill (канон T95): решение за Основателем/диспетчером.
    // Таймер живёт рядом с ETA и снимается вместе с ним (unscheduleEta).
    const overrunTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const fireOverrunWake = (agentId: string): void => {
      try {
        const l = loadLedger(stateFile)
        const a = l.agents.find((x) => x.id === agentId)
        if (!a || (a.state !== "running" && a.state !== "waiting")) return
        const reason = overrunWakeReason(a)
        if (!reason || !a.task_id) return
        // T124: сознательная остановка авто-петли (BLOCKED/GATE) не дубль-будится
        const stopped = l.tasks.find((t) => t.id === a.task_id)
        if (stopped && (stopped.state === "BLOCKED" || stopped.state === "GATE")) return
        diag.overrun_wakes += 1
        wake(
          `overrun:${a.id}`,
          "tab",
          `DEV CONSOLE OVERRUN: ${a.task_id} (${a.id}, ${a.label}) — ${reason}. ` +
            "Это дубль-буждение порога, не kill: реши — продли план (update est_min), перенаправь или закрывай.",
          a.task_id,
        )
      } catch (e) {
        console.error("[dev-console] overrun wake:", e)
      }
    }
    const fireEta = (agentId: string): void => {
      try {
        const l = loadLedger(stateFile)
        const a = l.agents.find((x) => x.id === agentId)
        if (!a || (a.state !== "running" && a.state !== "waiting")) return
        // T124-фрагмент №2 (29.10): notice слушает РЕАЛЬНЫЙ план задачи, не только
        // историю агента.
        // (1) задача сознательно остановлена (BLOCKED/GATE) → не пингуем вовсе;
        // (2) est_min задачи продлён → перевзводим таймер на остаток, а не кричим
        //     «план истёк» по learnEta-истории (продление оркестратора не фиктивно).
        const taskOfAgent = a.task_id ? l.tasks.find((t) => t.id === a.task_id) : undefined
        if (taskOfAgent && (taskOfAgent.state === "BLOCKED" || taskOfAgent.state === "GATE")) {
          console.log(`[dev-console] eta: ${a.id} silenced — ${taskOfAgent.id} ${taskOfAgent.state}`)
          return
        }
        if (taskOfAgent && typeof taskOfAgent.est_min === "number" && taskOfAgent.est_min > 0) {
          const began = Date.parse(a.began_at)
          if (Number.isFinite(began)) {
            const left = began + taskOfAgent.est_min * 60_000 - Date.now()
            const prevTimer = etaTimers.get(a.id)
            if (prevTimer) clearTimeout(prevTimer)
            if (left > 30_000) {
              etaTimers.set(a.id, setTimeout(() => fireEta(a.id), Math.min(left, 480 * 60_000)))
              console.log(`[dev-console] eta: ${a.id} re-armed по est_min задачи ${taskOfAgent.est_min}m (left ${Math.round(left / 1000)}s)`)
              return
            }
            etaTimers.delete(a.id)
          }
        }
        const planMin = taskOfAgent && typeof taskOfAgent.est_min === "number" && taskOfAgent.est_min > 0 ? taskOfAgent.est_min : a.eta_min
        diag.eta_fired += 1
        console.log(`[dev-console] eta: ${a.id} (${a.label}) over ${a.eta_min}m`)
        // T46: у задачи стоит пометка agent_error — план мёртвого исполнителя
        // НЕ считается успехом: без самоотчёта (писать некому — сессия мертва)
        // и с пометкой agent_error в пробуждении.
        const marked = a.task_id ? (l.tasks.find((t) => t.id === a.task_id)?.agent_error ?? null) : null
        if (marked) {
          if (a.task_id) {
            wake(
              `eta:${a.id}:agent_error`,
              "tab",
              `DEV CONSOLE agent_error: ETA ${planMin}м истёк — ${a.task_id} (${a.id}, ${a.label}): ` +
                `задача помечена agent_error (${marked}), это не «ещё работает». Реши: ретрай или закрывание.`,
              a.task_id,
            )
          }
          return
        }

        if (a.session_ref?.startsWith("ses_")) {
          // T92: самоотчёт — внедрённый в сессию агента контекст; +1 по ДОСТАВКЕ
          // (prompt() резолвится на доставке), как и диспатч-промпт. Таб-вуки
          // сюда не считаем — они идут в вкладку, у вкладки записи Agent нет.
          void ctx.session
            .prompt({
              sessionID: a.session_ref,
              text:
                `[ETA] План ${planMin} мин истёк. Пришли самоотчёт сейчас: что сделано, что осталось, ` +
                `блокировки (≤10 строк); затем завершайся или продолжай с отчётом.`,
            })
            .then(() => {
              bumpInjection(a.session_ref)
            })
            .catch((e) => console.error("[dev-console] eta self-report:", e))
        }
        // Пробуждение — вкладке-владельцу задачи (wake сам резолвит атрибуцию
        // T34); без task_id адресата нет — молчим, а не будим «последнюю».
        // T48: раньше будил «без критерия» — теперь wake несёт правило решения:
        // сравни план (eta_min) с фактом из самоотчёта; est_min задачи (если
        // задан) — источник плана, его же можно переписать на новый срок.
        if (a.task_id) {
          const t = l.tasks.find((x) => x.id === a.task_id)
          const planSrc = t && typeof t.est_min === "number" && t.est_min > 0 ? `est_min задачи ${t.est_min}м` : `план по истории (${a.kind})`
          wake(
            `eta:${a.id}`,
            "tab",
            `DEV CONSOLE ETA: план ${planMin}м истёк — ${a.task_id} (${a.id}, ${a.label}) ещё работает (источник плана: ${planSrc}). ` +
              "Критерий решения по самоотчёту: есть сделанный шаг и понятный остаток → продли (update est_min на новый срок); " +
              "самоотчёт пустой/нет движения → re-dispatch или закрывай с agent_error-диагнозом.",
            a.task_id,
          )
        }
      } catch (e) {
        console.error("[dev-console] eta fire:", e)
      }
    }
    const scheduleEta = (agent: { id: string; began_at: string; eta_min: number }): void => {
      const prev = etaTimers.get(agent.id)
      if (prev) clearTimeout(prev)
      const delay = Math.max(0, Date.parse(agent.began_at) + agent.eta_min * 60000 - Date.now())
      etaTimers.set(agent.id, setTimeout(() => fireEta(agent.id), delay))
      console.log(`[dev-console] eta: ${agent.id} plan ${agent.eta_min}m (fires in ${Math.round(delay / 1000)}s)`)
      // T128: порог дубль-буждения — overrun ≥ 2× плана = факт ≥ 3× плана
      const prevOd = overrunTimers.get(agent.id)
      if (prevOd) clearTimeout(prevOd)
      const odelay = Math.max(0, Date.parse(agent.began_at) + agent.eta_min * (1 + OVERRUN_WAKE_FACTOR) * 60000 - Date.now())
      overrunTimers.set(agent.id, setTimeout(() => fireOverrunWake(agent.id), odelay))
    }
    const unscheduleEta = (agentId: string): void => {
      const t = etaTimers.get(agentId)
      if (t) {
        clearTimeout(t)
        etaTimers.delete(agentId)
      }
      const ot = overrunTimers.get(agentId)
      if (ot) {
        clearTimeout(ot)
        overrunTimers.delete(agentId)
      }
    }

    // T46: одна точка завершения для ВСЕХ путей (событие сессии, спавн-хук,
    // диспатч): запись агента + снятие ETA-плана (мёртвому не «успех») + пометка
    // agent_error на задаче при смерти. Возвращает запись, если состояние
    // изменилось; undefined = событие уже отражено в леджере (повтор не спамит).
    // T41/T93: durable counters (edit_count, injection_count) read from agent record.
    const settleEvent = (ledger: Ledger, status: "completed" | "failed", ref?: string | null, reason?: string) => {
      // T41/T93: compute metrics at settle using durable counters from agent record
      const agentRecord = ref ? ledger.agents.find((a) => a.session_ref === ref) : undefined
      const editCount = agentRecord?.edit_count ?? 0
      // T92: injections читает computeCounters из durable injection_count — без opts.
      const emptyRun = status === "completed" && editCount === 0
      const agent = settleOnEvent(ledger, status, ref, reason, { emptyRun })
      if (!agent) return undefined
      unscheduleEta(agent.id) // план закрыт вместе с агентом: таймер не стреляет по мёртвому
      if (status === "failed") diag.agent_errors += 1
      return agent
    }

    // Хвост сессии для пробуждения: у смерти это обычно текст ошибки
    // («Rate limit exceeded»), у успеха — последний ответ.
    const sessionTail = async (sessionID: string, max: number, preferError: boolean): Promise<string> => {
      try {
        const messages = (await ctx.session.context({ sessionID })) as unknown
        const arr = Array.isArray(messages) ? (messages as { type?: string; payload?: unknown }[]) : []
        const fromEnd = [...arr].reverse()
        const textOf = (m: { payload?: unknown } | undefined): string => {
          const payload = m?.payload as
            | { parts?: { type?: string; text?: string }[]; content?: { type?: string; text?: string }[] }
            | undefined
          const segs = payload?.parts ?? payload?.content
          return (
            segs
              ?.filter((p) => p.type === "text" && typeof p.text === "string")
              .map((p) => p.text)
              .join("\n") ?? ""
          )
        }
        // T109: причина смерти — payload.error (квота/429 кейс A100: content у
        // смерти пуст) — ищем и извлекаем; JSON-мусор не выдумываем.
        const bad = preferError
          ? fromEnd.find(
              (m) => m.type === "error" || Boolean(errorTextOfPayload(m.payload)) || /rate limit|429|лимит/i.test(textOf(m)),
            )
          : undefined
        const last = bad ?? fromEnd.find((m) => m.type === "assistant") ?? fromEnd.find((m) => m.type !== "user")
        // T109: сначала текст-части, затем провайдерская ошибка; JSON-fallback
        // только при реально существующем payload: «payload нет» → "" (класс
        // upstream по T97), а не JSON-мусор «""» → unknown (кейс A100).
        const text = textOf(last) || errorTextOfPayload(last?.payload)
        if (text.trim()) return text.slice(0, max)
        return (last?.payload ? JSON.stringify(last.payload) : "").slice(0, max)
      } catch {
        return "" // хвост — косметика: wake уйдёт и без него
      }
    }

    // T46: пробуждение по смерти исполнителя — с пометкой agent_error, а не как
    // результат («успех»). Адресат — вкладка-владелец задачи (атрибуция T34).
    const wakeAgentError = (taskId: string, agentId: string, detail: string): void => {
      void (async () => {
        let tail = ""
        let ref: string | null = null
        try {
          ref = loadLedger(stateFile).agents.find((x) => x.id === agentId)?.session_ref ?? null
          if (ref?.startsWith("ses_")) tail = await sessionTail(ref, 400, true)
        } catch {
          /* хвост не доехал — wake всё равно уходит */
        }
        // T66: rate limit / model drop → кулдаун пострадавшей модели (следующий
        // диспатч уйдёт на резервную) и живой ребёнок переключается на резерв.
        // T67: уведомление Основателя — «режут по IP VPN из-за трафика, смени провайдера/VPN».
        // T97(г): класс смерти (model/upstream/unknown) по хвосту сессии —
        // пустой хвост = upstream (endpoint молчит, диагностики нет), чтобы
        // agent_error/T66 видели причину, а не «сессия мертва».
        const errClass = classifyAgentError(tail)
        const classified = `[${errClass}] ${detail}${tail ? "" : " · пустой хвост — диагностики нет"}`
        try {
          const l = loadLedger(stateFile)
          // T150: отказ модели — в статистику ОДИН РАЗ, здесь, где класс
          // ошибки уже известен: model → fail (карантин/обучаемый выбор),
          // upstream/unknown → upstream_fails (чужая смерть, карантин и
          // fail-rate не отравляются рестартами сервера).
          const agent = l.agents.find((x) => x.id === agentId)
          if (agent?.model) {
            recordModelResult(l, agent.model, false, errClass)
            const task = l.tasks.find((t) => t.id === taskId)
            if (task) {
              const cls = taskClass(l, task)
              const began = Date.parse(agent.began_at)
              const durationSec = Math.max(1, (Date.now() - (Number.isFinite(began) ? began : Date.now())) / 1000)
              const eps = (agent.edit_count ?? 0) / durationSec
              recordModelResultByClass(l, agent.model, cls, false, eps, errClass, false)
            }
          }
          if (markAgentError(l, taskId, classified)) save(l)
        } catch (e) {
          console.error("[dev-console] T97 agent_error class:", e)
        }
        // T153: смерть ENDPOINT (upstream — 5xx/сеть/тихий endpoint) — тоже
        // «модель сейчас недоступна». Без кулдауна выбор каждый раз втыкает
        // в ту же мёртвую точку (инцидент 11.11: A170–A175 — 6/6 смертей на
        // mimo-v2.6-flash, ротации не было, дети умирали мгновенно, 0 токенов).
        // Короткий кулдаун (половина COOLDOWN_MS) → следующий диспатч попробует
        // другую модель фри-пула (T142); если провайдер мёртв целиком — модели
        // уйдут в кулдаун по очереди и конвейер честно остановится (гард
        // «вынужденный выбор»), а не будет молотить по мёртвому endpoint.
        if (errClass === "upstream") {
          try {
            const l2 = loadLedger(stateFile)
            const model2 = l2.agents.find((x) => x.id === agentId)?.model
            const full2 = model2 ? modelForKey(model2) : null
            if (full2) {
              // T166: эскалация — каждый следующий upstream-провал модели
              // удваивает/учетверяет окно (база = половина COOLDOWN_MS, T153).
              const until2 = bumpUpstreamCooldown(l2, full2, COOLDOWN_MS / 2)
              save(l2)
              // T169-гвард: карантин дублируется в durable model_health.json —
              // старые инстансы (без CAS) стирают state.json целиком и вместе
              // с ним кулдауны; диспатч накладывает health поверх снимка.
              if (until2) {
                const healthPath = join(dirname(stateFile), "model_health.json")
                const health = loadModelHealth(healthPath)
                const streakNow = modelStats(l2).find((s) => shortModelKey(s.model) === shortModelKey(full2))?.upstream_streak ?? 1
                saveModelHealth(healthPath, recordModelHealth(health, full2, streakNow, until2))
              }
              console.log(`[dev-console] T153/T166: endpoint down → cooldown ${full2} until ${until2}`)
            }
          } catch (e) {
            console.error("[dev-console] T153: cooldown upstream:", e)
          }
        }
        if (isRateLimited(tail) || isRateLimited(detail)) {
          try {
            const l = loadLedger(stateFile)
            const model = l.agents.find((x) => x.id === agentId)?.model
            const full = model ? modelForKey(model) : null
            if (full) {
              const until = setModelCooldown(l, full)
              save(l)
              console.log(`[dev-console] T66: rate limit → cooldown ${full} until ${until}`)
              // T132: резерв = следующая модель ТОГО ЖЕ полюса (на фри-инстансе
              // строго бесплатная) — квота премиума фри-инстанс не ломает.
              const reserve = quotaFallbackModel(l, full)
              if (ref?.startsWith("ses_")) {
                const [providerID, id] = reserve.split("/")
                void ctx.session
                  .switchModel({ sessionID: ref, model: { providerID, id } })
                  .then(() => console.log(`[dev-console] T66: child ${agentId} → reserve ${reserve}`))
                  .catch((e) => console.error("[dev-console] T66 reserve switch:", e))
              }
            }
            // T67 → T177 (жалоба Основателя 16.11 «активные инстансы волатильно
            // загораются/гаснут»): broadcast synthetic был реальным ходом модели на
            // КАЖДОЙ простаивающей вкладке — инстансы вспыхивали волной инцидентов
            // и гасли по истечении грейса, токены жглись впустую (канон T53 —
            // шум/токены запрещены; T160 ставил этот вопрос волне — жалоба
            // Основателя закрыла его). Решение принял рантайм сам (резерв по T66),
            // маркеры 🔒/⚠ и кулдаун уже видны в В РАБОТЕ — ход модели не нужен.
            console.log(
              `[dev-console] T67 rate_limit: ${taskId} (${agentId}) — ${detail}; ребёнок на резерве (${full ? quotaFallbackModel(l, full) : INSTANCE_MODEL}), кулдаун до ${new Date(Date.now() + 10 * 60_000).toLocaleTimeString()}`,
            )
          } catch (e) {
            console.error("[dev-console] T66 cooldown:", e)
          }
        }
        wake(
          `agent_error:${taskId}:${agentId}`,
          "tab",
          `DEV CONSOLE agent_error: ${taskId} (${agentId}) умер — ${classified}\n` +
            "Задача помечена agent_error, ETA-план снят, запись агента = failed. Это НЕ успех: " +
            "реши ретрай (update с owner на DOING) или закрывание." +
            (tail ? `\nХвост сессии: ${tail}` : ""),
          taskId,
        )
      })().catch((e) => console.error("[dev-console] agent_error wake:", e))
    }

    // Model of an agent = its child's Session.Info (Founder: the pane must say
    // which model runs the task). Attached after spawn/dispatch resolves; the
    // record's own save re-renders the pane.
    const shortModel = (raw: unknown): string | null => {
      let v = raw
      if (typeof v === "string" && v.includes("/")) v = v.split("/").slice(1).join("/")
      else if (v && typeof v === "object") {
        const o = v as { id?: string; model?: string }
        v = o.id ?? o.model
      }
      return typeof v === "string" && v !== "" ? v.replace(/-free$/, "") : null
    }
    const attachModel = (agentId: string, sessionID: string): void => {
      void (async () => {
        try {
          const info = (await ctx.session.get({ sessionID })) as Record<string, unknown>
          const m = shortModel(info.model)
          if (!m) return
          const l = loadLedger(stateFile)
          const a = l.agents.find((x) => x.id === agentId)
          if (a && a.model !== m) {
            a.model = m
            save(l)
          }
        } catch (e) {
          console.error("[dev-console] attach model:", e)
        }
      })()
    }

    // Декрет Основателя 28.10: «ПУСТЬ МАРУСЬКА РАБОТАЕТ НА ТОМ ЧТО ВЫБРАНО,
    // А НЕ СБРАСЫВАЕТСЯ» — прежний T66 ensureInstanceModel принудительно
    // возвращал верхнюю вкладку на INSTANCE_MODEL (mimo), перетирая выбор
    // Основателя (он выбирал модель в OpenCode — консоль сбрасывала её на
    // mimo). Удалено: модель вкладки = что выбрано; консоль только читает
    // и показывает её в фиде/панели. Агентам авто-подбор по классу ОСТАЁТСЯ
    // («а агенты — уже там по подходу»): chooseModelByClass на диспатче.

    // T102 (персонажная система ипостасей, заказ Основателя 08.10): первый
    // промпт ребёнка несёт блок ипостаси. T166 (заказ Основателя 15.11
    // «минимум решений на модели, максимум фреймворка»): ипостась диспатча
    // назначает ФРЕЙМВОРК по классу задачи — без каталога и без модельного
    // выбора; каталог остаётся для ручных спавнов (personaPromptBlock(null)).
    const dispatchPrompt = (task: Task, parent: Persona | null, cls: TaskClass | null): string =>
      `[${task.id}] ${task.task}\n\n` +
      "Dispatched executor. The framework owns orchestration and the ledger. You may call dev_console " +
      "ONLY with op=progress to self-report your own current step (step, done, next, eta_remaining_min); " +
      "the runtime binds your identity from this session, so never supply an agent/task/session id. " +
      "Send a short report after meaningful milestones, when blocked, and before finishing — not after every tiny action. " +
      "All other dev_console operations are forbidden for executors. Read DEVATA/PIPELINE_PROJECT.md if present (models, tests, protected paths). " +
      "Complete the task, verify it, reply with the result (≤10 lines).\n\n" +
      // T97(в) orientation-прелюдия: первое действие ребёнка — tool-вызов.
      "ORIENTATION (T97): your FIRST action MUST be a tool call (`ls` the repo, read the task, read a file). " +
      "Never open with prose — N consecutive opening messages with zero tool calls are flagged " +
      "orientation-hell and the run gets re-dispatched. Tool first, then work. " +
      "Your final message IS the self-report: it is read into the task's verification automatically " +
      "(no report → the task is marked no-self-report).\n\n" +
      personaPromptBlock(parent, personaForTaskClass(cls))

    // Result is explicit (N00sphere report 07.10.2026): the response must say
    // why a spawn did not happen — silently-absent `dispatched` read as a bug.
    type DispatchResult =
      | { status: "spawned"; task_id: string; agent: string; session_id: string; agent_type: string }
      | { status: "skipped"; reason: string }
      | { status: "failed"; error: string }

    const dispatch = async (task: Task): Promise<DispatchResult> => {
      try {
        // T95: CPU guard before spawn — probe + two thresholds
        const cpu = cpuGate()
        diag.cpu_pct = cpu.sample?.pct ?? null
        diag.cpu_warning = cpu.warning
        diag.cpu_hard_stop = cpu.hardStop
        diag.cpu_peak = cpu.peak
        if (!cpu.allow) {
          // HARD STOP: block new heavy operations, kill runaway processes
          const killed = killRunawayProcesses(3)
          // T177: synthetic-broadcast → лог (панель и так несёт CPU-линию
          // предупреждения в шапке; ход модели на всех простаивающих не нужен)
          console.log(
            `[dev-console] T95 CPU HARD STOP: ${cpu.reason}. Килл runaway: ${killed.killed} процессов (PIDs: ${killed.pids.join(", ") || "нет"}). Пик сессии: ${cpu.peak}%. Новые тяжёлые операции заблокированы до спада.`,
          )
          return { status: "skipped", reason: cpu.reason }
        }
        if (cpu.defer) {
          // T95: WARNING ~70% — реально откладываем старт (мой добор 08.10 14:2x:
          // A78 оставил только console.log, он в лог не попадает). Ждём 4с,
          // репробуем; предупреждение держится → skipped: следующий
          // op/dispatch повторит попытку, когда нагрузка спадёт.
          await new Promise((r) => setTimeout(r, 4000))
          const again = cpuGate()
          if (!again.allow || again.defer) {
            // T177: synthetic-broadcast → лог (см. cpu_hard_stop выше)
            console.log(
              `[dev-console] T95 CPU WARNING: откладываю старт ${task.id} (${again.reason}). Пик сессии: ${again.peak}%. Диспатч повторится после спада.`,
            )
            return { status: "skipped", reason: `cpu warning deferred: ${again.reason}` }
          }
        }

        // T47 (write-exclusive): одна живая сессия на задачу. Гейт смотрит не
        // только running-записи леджера, но и живость сессии исполнителя:
        // свежий active-проб (T73) + словарь активности событий. Ранний settle
        // закрыл запись, а сессия жива → дубль-гейт держит, ре-диспатч только
        // после terminal-settle. active молчит (null) — блокирует леджерная запись.
        const pre = loadLedger(stateFile)
        await probeActive() // обновить activeIds (троттл 1с встроен) — честный срез живости
        const conflict = liveExecutorConflict(pre, task.id, activeIds, (ref) => sessionActivity.get(ref) ?? null)
        if (conflict) {
          return { status: "skipped", reason: conflict }
        }

        // T95-БАЛАНС (заказ Основателя 11.11, дословно: «пусть все агенты
        // балансят общий ЦПУ»). Общий бюджет машины, без ИИ-эвристики — чистые
        // пороги: ≥70% → 1 живой ребёнок, ≥40% → 2, иначе 3. Дубли не плодятся,
        // овер не копится, очередь сама ждёт спада (следующий op доберёт).
        const liveNow = pre.agents.filter((a) => a.state === "running" || a.state === "waiting").length
        const cpuPct = cpu.sample?.pct ?? 0
        const maxConc = cpuPct >= 70 ? 1 : cpuPct >= 40 ? 2 : 3
        if (liveNow >= maxConc) {
          return {
            status: "skipped",
            reason: `cpu-budget: ${liveNow} живых детей при ${cpuPct}% CPU (лимит ${maxConc}) — ждём спад`,
          }
        }

        // T132-инцидент (29.10): ретрай-петля между потоками — ребёнок падает
        // (квота/[upstream]) → agent_error wake будит потоки → любой update с
        // owner респавнит → падает снова → «бесконечные probe quota». Retry-cap:
        // ≥3 падений задачи за окно → диспатч СКИП до диагноза; снять cap
        // можно, переставив задачу после разбора ленты (ручная эскалация).
        // T170-инцидент (15.11): ретрай-цепочка игнорировала BLOCKED — гард
        // ДО ретраев: задача в BLOCKED/GATE диспатчиться не может в принципе.
        if (task.state === "BLOCKED" || task.state === "GATE" || task.state === "DONE") {
          return {
            status: "skipped",
            reason: `задача ${task.id} в ${task.state} — диспатч запрещён (ретрай не может перебить блок)`,
          }
        }
        const capCut = Date.now() - 60 * 60_000
        const recentFails = pre.agents.filter(
          (a) => a.task_id === task.id && a.state === "failed" && Date.parse(a.updated_at) >= capCut,
        ).length
        if (recentFails >= 3) {
          return {
            status: "skipped",
            reason: `retry-cap: ${recentFails} падений за час — нужен диагноз, а не респавн (T132-инцидент)`,
          }
        }

        // T131 (инцидент 29.10): проб живости сервиса ПЕРЕД спавном ребёнка.
        // Сервис виснет (git-шторм) → ребёнок родился бы мёртвым: первый
        // prompt() падает «cannot connect to service»/[upstream] ДО первого
        // токена (A120-A124: cost 0). Мёртв → defer: skipped-ответ, спавн
        // повторит следующий op/dispatch, когда сервер ответит.
        if (!(await probeServiceAlive())) {
          diag.service_defers += 1
          console.log(
            `[dev-console] T131: opencode API молчит >${SERVICE_PROBE_TIMEOUT_MS}мс — спавн ${task.id} отложен (defer вместо смерти ребёнка)`,
          )
          return {
            status: "skipped",
            reason:
              `service probe (T131): opencode API не отвечает >${SERVICE_PROBE_TIMEOUT_MS}мс — спавн отложен до живости ` +
              `сервиса (без этого ребёнок падает «cannot connect to service» до первого токена)`,
          }
        }

        // T144 (жалоба Основателя 29.10 «опять спавнятся инстансы»): ребёнок
        // создаётся ДОЧЕРНЕЙ сессией вкладки-владельца (parentID = task.session_ref)
        // — в ЮИ проекта он НЕ горит отдельным окном (как субагенты харнесса).
        const created = (await ctx.session.create({
          title: `${task.id} · ${task.task.slice(0, 48)}`,
          parentID: typeof task.session_ref === "string" && task.session_ref.startsWith("ses_") ? task.session_ref : undefined,
        })) as {
          id?: string
        }
        const sessionID = created?.id
        if (!sessionID) throw new Error("session.create returned no id")
        await ctx.session.switchAgent({ sessionID, agent: DISPATCH_AGENT })

        // Model resolution (T84 + T66): автовыбор модели по классу задачи.
        // Класс = owner (dev/research/qc) + размер декомпозиции.
        // Warmup N прогонов → argmax(эдиты/сек × успех) → ~10% re-examine.
        // Фолбэк на T66 политику при недоступности или нехватке статистики.
        const ledgerForModel = loadLedger(stateFile)
        // T169-гвард: durable-карантин поверх снимка — старые инстансы без CAS
        // стирают кулдауны из state.json, health-файл их переживает.
        applyModelHealth(ledgerForModel, loadModelHealth(join(dirname(stateFile), "model_health.json")))
        const cls = taskClass(ledgerForModel, task)
        const preferredModel = task.owner ? OWNER_MODEL[task.owner] : null
        // T132: наличие моделей = живой каталог /api/model (кэш 10м): полюс
        // решает state.ts, каталог не даёт диспатчу уйти в несуществующую
        // строку (инцидент A127 — старт-смерть ребёнка). Каталог молчит →
        // фильтр выключен (undefined), поведение прежнее.
        await refreshCatalog()
        const inCatalog = catalogModels
          ? [...POLICY_MODELS, ...FREE_POOL].filter((m) => catalogModels!.includes(m))
          : []
        const availableModels = inCatalog.length > 0 ? inCatalog : undefined
        // T116 (EXPERIENCE_CORE F3): межрепо-опыт имени инстанса-владельца
        // задачи. Реестр-шарды ∪ свой проект → чужие леджеры READ-only через
        // кэш (mtime+60с TTL) → гейты (presence/memory/unbound) → агрегат.
        // Кросс идёт в выбор модели (warmup/score докрутка) и ETA-историю
        // ребёнка. Сбой чужого леджера/реестра никогда не роняет диспатч.
        let crossModel: CrossModelClass[] | undefined
        let crossEta: { durations: Array<{ kind: string; ms: number; endedAt: number }>; unlimited: boolean } | undefined
        try {
          touchRegistry(pluginHubDevata, root)
          const reg = loadRegistry(pluginHubDevata)
          const ledgers = new Map<string, Ledger>()
          const skipped: string[] = []
          ledgers.set(root, ledgerForModel)
          for (const foreignRoot of reg.keys()) {
            if (foreignRoot === root) continue
            const l = readForeignLedger(join(foreignRoot, "DEVATA", "state.json"), (p) => {
              try {
                return { mtimeMs: statSync(p).mtimeMs }
              } catch {
                return null
              }
            })
            if (l) ledgers.set(foreignRoot, l)
            else skipped.push(foreignRoot)
          }
          const ownerHome = ownerTab(task.id)
          const ownerName = instanceNameOf(ledgerForModel.tabs.find((t) => t.session_id === ownerHome)?.title ?? "")
          const agg = aggregateExperience(ownerName, root, ledgers)
          if (agg.modelClass.length > 0) crossModel = agg.modelClass
          if (agg.durations.length > 0) crossEta = { durations: agg.durations, unlimited: agg.unlimited }
          diag.experience = JSON.stringify({
            name: ownerName,
            scope: scopeFor(ownerName),
            discovered: reg.size,
            qualified: agg.sources.length,
            sources: agg.sources,
            skipped,
          }).slice(0, 500)
        } catch (e) {
          console.error("[dev-console] T116 experience:", e)
        }
        const modelChoice = chooseModelByClass(ledgerForModel, cls, preferredModel, availableModels, undefined, undefined, crossModel)
        // T119-ГАРД: решение ритуала пост-проверяет выбор — модель в карантине
        // (кулдаун/≥50% отказов при ≥3 прогонах) заменяется здоровой. Гард
        // срабатывает ТОЛЬКО на карантине: обычную статистику он не перебивает.
        const policyModel = ritualGuard(ledgerForModel, cls, modelChoice.model)
        // T132/A127-гард (11.11): каталог провайдера — единственная правда о
        // существовании строки. Модели нет в каталоге (напр. провайдер исчез) →
        // НЕ создаём ребёнка: он умрёт «Model unavailable / пустой хвост».
        if (catalogModels && catalogModels.length > 0 && !catalogModels.includes(policyModel)) {
          return {
            status: "skipped",
            reason: `модель ${policyModel} отсутствует в каталоге провайдера — спавн не создаю (T132/A127)`,
          }
        }
        // T142 страж (декрет 29.10 ~10:45): ни один демон/исполнитель не может
        // получить premium/luna. Этим гардом живут и выборки (childPool/
        // CHILD_KEY_TO_MODEL/modelUsable), и финальная модель перед спавном:
        // чужой или премиум-выбор → skip, спавн не создаётся.
        if (!childModelAllowed(policyModel)) {
          console.error(`[dev-console] T142 guard: ${policyModel} не легальна субагенту (только *-free, luna = Гольфия)`)
          return {
            status: "skipped",
            reason: `T142 guard: модель ${policyModel} запрещена субагенту (детский пул = только *-free, luna зарезервирована за Гольфией)`,
          }
        }
        console.log(`[dev-console] dispatch: model ${policyModel} (class=${cls}, ${modelChoice.reason})`)
        // Вкладка-владелец задачи = home агента (и источник последнего
        // фолбэка, если политика недоступна у этой сборки).
        const source = ownerTab(task.id)
        const inheritOrchestrator = async (): Promise<void> => {
          if (!source) return
          const info = (await ctx.session.get({ sessionID: source })) as Record<string, unknown>
          const raw = info.model as
            | string
            | { providerID?: string; provider?: string; id?: string; model?: string }
            | null
            | undefined
          const providerID = typeof raw === "string" ? raw.split("/")[0] : (raw?.providerID ?? raw?.provider)
          const modelID = typeof raw === "string" ? raw.split("/").slice(1).join("/") : (raw?.id ?? raw?.model)
          if (providerID && modelID) {
            // T142: наследуем ТОЛЬКО пригодную СУБАГЕНТУ модель: премиум-модель
            // вкладки (деньги/ГО) и luna (резерв Гольфии) ребёнку не передаются
            // НИКОГДА (modelUsable гардится childModelAllowed), мёртвая строка
            // каталога/A127 и кулдаун тоже не наследуются — остаюсь на policy-выборе.
            const inherited = `${providerID}/${modelID}`
            if (!modelUsable(loadLedger(stateFile), inherited)) {
              console.log(
                `[dev-console] dispatch: наследование ${inherited} отклонено (T142 гард: premium/luna/кулдаун, T132) — остаюсь на ${policyModel}`,
              )
              return
            }
            await ctx.session.switchModel({ sessionID, model: { providerID, id: modelID } })
            console.log(`[dev-console] dispatch: model inherited ${providerID}/${modelID} from tab ${source}`)
          }
        }
        try {
          const [providerID, id] = policyModel.split("/")
          await ctx.session.switchModel({ sessionID, model: { providerID, id } })
          console.log(`[dev-console] dispatch: policy model ${policyModel} (owner=${task.owner}, T66)`)
          // T149 (инцидент 11.11: дети умирали «Endpoint is unavailable»): сессия
          // ребёнка наследует модель РОДИТЕЛЯ, а switchModel может не примениться
          // (родитель на мёртвом провайдере — opencode-go исчез из каталога).
          // Проверяем фактическую модель СЕССИИ и не спавним ребёнка на заведомо
          // мёртвой/непригодной — задача честно уходит в очередь с причиной.
          const info = (await ctx.session.get({ sessionID })) as Record<string, unknown>
          const raw = info.model as
            | string
            | { providerID?: string; provider?: string; id?: string; model?: string }
            | null
            | undefined
          const appliedProvider =
            typeof raw === "string" ? raw.split("/")[0] : (raw?.providerID ?? raw?.provider)
          const appliedId = typeof raw === "string" ? raw.split("/").slice(1).join("/") : (raw?.id ?? raw?.model)
          const applied = appliedProvider && appliedId ? `${appliedProvider}/${appliedId}` : null
          if (applied && applied !== policyModel && !childModelAllowed(applied)) {
            console.error(
              `[dev-console] T149: модель сессии ${applied} непригодна ребёнку (унаследована от вкладки) — спавн не создаю`,
            )
            return {
              status: "skipped",
              reason: `модель сессии ${applied} непригодна субагенту (унаследована от вкладки) — спавн не создаю (T149)`,
            }
          }
        } catch (e) {
          console.error(`[dev-console] dispatch model ${policyModel} failed:`, e)
          try {
            await inheritOrchestrator() // policy model gone from catalog → fall back to primary
          } catch (e2) {
            console.error("[dev-console] dispatch inherit fallback:", e2)
          }
        }
        // session_probe = the child's Session.Info after resolution → proves the applied model.
        try {
          const child = (await ctx.session.get({ sessionID })) as Record<string, unknown>
          diag.session_probe = JSON.stringify(child).slice(0, 600)
        } catch {
          /* diagnostic only */
        }

        // T165 (коллизия A180×2: два параллельных диспатча взяли max+1 с разных
        // снимков и получили один id — записи слились, agent_error попал в две
        // задачи): аллокация+сейв агента — в КРИТИЧЕСКОЙ СЕКЦИИ (in-process
        // сериализация) со свежим loadLedger внутри; CAS-мерж делает сейв
        // безопасным, окно коллизии id сжимается до микросекунд.
        // T166: ипостась берёт cls ИЗ ЗАМЫКАНИЯ dispatch (const cls выше ~2788) —
        // второй const cls в той же области ронял бандл Бана 12:24–13:02.
        const agent = await serializeAgentSpawn(async () => {
          const l = loadLedger(stateFile)
          const a = beginAgent(l, {
            input: { agent: DISPATCH_AGENT, description: `[${task.id}] ${task.task}` },
            ref: sessionID,
            home: source, // вкладка, распорядившаяся задачей — для данных о вкладках
            model: shortModelKey(policyModel), // T82: model speed coefficient for ETA scaling
            cross: crossEta, // T116: кросс-опыт имени инстанса докручивает ETA-историю
            idFile: stateFile,
          })
          await save(l)
          return a
        })
        diag.dispatched += 1
        dispatchedSessions.add(sessionID)
        scheduleEta(agent) // план финиша — вместе с записью агента
        attachModel(agent.id, sessionID) // панель покажет, какой моделью идёт задача

        // T102: персона инстанса-заказчика по титулу его вкладки (чужое имя
        // не выдумывается → null) — уходит в блок ипостаси первого промпта.
        const parentPersona = instancePersona(
          loadLedger(stateFile).tabs.find((t) => t.session_id === source)?.title ?? null,
        )

        // Background by construction: never await the run. Completion truth =
        // session.execution events (they settle AND wake the orchestrator);
        // this catch only covers a run that never starts.
        // T92: диспатч-промпт = контекст рантайма в сессии задачи; +1 по ДОСТАВКЕ
        // (prompt() резолвится на доставке, не на завершении — проверено живьём),
        // чтобы «цена контекста задачи» была честной: проваленный старт не кормит.
        // T132 (заказ 29.10) LIVE-GUARD квоты: промпт упал на квоте/лимите →
        // кулдаун модели, ротация на следующую БЕСПЛАТНУЮ (quotaFallbackModel,
        // полюс инстанса) и повтор доставки в той же сессии. Ретраи ограничены
        // (2 ротации = 3 попытки): дальше — прежний fail-путь (agent_error),
        // честная смерть, а не петля. DoD: «агент на квоте выживает».
        let promptAttempt = 0
        const failStart = (e: unknown): void => {
          console.error("[dev-console] dispatch run:", e)
          try {
            const l = loadLedger(stateFile)
            if (settleEvent(l, "failed", sessionID, `диспатч не стартовал: ${String(e).slice(0, 160)}`)) save(l)
          } catch {
            /* ledger busy — the event stream will settle it */
          }
          wakeAgentError(task.id, agent.id, `исполнитель не стартовал: ${String(e).slice(0, 200)}`)
        }
        const sendPrompt = (): void => {
          void ctx.session
            .prompt({ sessionID, text: dispatchPrompt(task, parentPersona, cls) })
            .then(() => {
              bumpInjection(sessionID)
              if (promptAttempt > 0) {
                diag.quota_rotations += 1
                console.log(`[dev-console] T132: prompt выжил после ${promptAttempt} ротации(й) квоты`)
              }
            })
            .catch((e) => {
              const text = `${String(e)} ${errorTextOfPayload(e)}`
              // Квота/лимит провайдера — то, что live-guard обязан погасить ротацией
              const quota = isRateLimited(text) || /quota|rate.?limit|usage limit|exceeded|insufficient/i.test(text)
              if (!quota) return failStart(e)
              try {
                const l = loadLedger(stateFile)
                const full = modelForKey(l.agents.find((x) => x.id === agent.id)?.model ?? policyModel) ?? policyModel
                if (promptAttempt >= 2) {
                  noteQuotaGuard(null) // попытки кончились — квота всё равно доказана
                  return failStart(e)
                }
                promptAttempt += 1
                const until = setModelCooldown(l, full)
                save(l)
                noteQuotaGuard(until ? Date.parse(until) : null) // шапка панели честно показывает 100%
                const next = quotaFallbackModel(l, full) // следующая free-модель полюса
                console.log(`[dev-console] T132 quota: ${full} → ${next} (попытка ${promptAttempt + 1}/3)`)
                const [providerID, id] = next.split("/")
                void ctx.session
                  .switchModel({ sessionID, model: { providerID, id } })
                  .then(() => sendPrompt())
                  .catch((e2) => {
                    console.error("[dev-console] T132 quota switch:", e2)
                    failStart(e) // смена модели не удалась — честная смерть, не петля
                  })
              } catch (e2) {
                console.error("[dev-console] T132 quota guard:", e2)
                failStart(e)
              }
            })
        }
        sendPrompt()

        return { status: "spawned", task_id: task.id, agent: agent.id, session_id: sessionID, agent_type: DISPATCH_AGENT }
      } catch (e) {
        console.error("[dev-console] dispatch failed:", e)
        return { status: "failed", error: String(e) }
      }
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "dev_console",
        description: DESCRIPTION,
        input: INPUT as unknown as Record<string, unknown>,
        execute: async (raw, context) => {
          const input = raw as OpInput
          // Compact state line on the tool row in the Founder's UI — visible
          // without opening the collapsed output (same channel class as `question`).
          const progress = (p: Projection): void => {
            diag.progress += 1
            const bits: string[] = []
            if (p.active.length) bits.push(`🔄 ${p.active.map((t) => t.id).join(" ")}`)
            if (p.agents.length) bits.push(`🤖 ${p.agents.length}`)
            if (p.blocked.length) bits.push(`⛔ ${p.blocked.length}`)
            const status = bits.join(" · ") || "💤 нет активных задач"
            void Promise.resolve(
              (context as { progress?: (s: { status: string }) => Promise<void> }).progress?.({ status }),
            ).catch(() => {
              /* the status line is cosmetic — never fail an op over it */
            })
          }
          try {
            // T240: the only executor write path. Identity is the invoking session;
            // never accept an agent/task/session id from model-controlled input.
            const callerSession = typeof context.sessionID === "string" ? context.sessionID : ""
            const callerLedger = loadLedger(stateFile)
            const callerAgent = callerSession ? callerLedger.agents.find((a) => a.session_ref === callerSession) : undefined
            if (callerAgent && input.op !== "progress") {
              return { content: JSON.stringify({ ok: false, error: "executor permission: only op=progress is allowed" }) }
            }
            if (input.op === "progress") {
              if (!callerAgent || (callerAgent.state !== "running" && callerAgent.state !== "waiting")) {
                return { content: JSON.stringify({ ok: false, error: "progress is available only to the live agent owning this session" }) }
              }
              const agent = noteAgentProgress(callerLedger, callerSession, input)
              if (!agent) return { content: JSON.stringify({ ok: false, error: "agent session is not live or is not registered" }) }
              await save(callerLedger)
              diag.agent_progress_reports += 1
              progress(project(loadLedger(stateFile)))
              return { content: JSON.stringify({ ok: true, op: "progress", agent: agent.id, updated_at: agent.progress?.updated_at, source: "self-report" }) }
            }
            if (discoverSpawn) await discoverSpawn() // lazy retry: the spawn tool may register after load
            if (input.op === "get_state") {
              const { ledger, projection } = read()
              progress(projection)
              // T135 (гипотеза Основателя 29.10): между компактизациями модель
              // потребляет ДЕЛЬТУ — полный снапшот только на первом вызове,
              // по reset:true (после компакта) и каждый 10-й вызов (страховка).
              // Футер версии показывает разрыв: увидел нестыковку → reset:true.
              const sid = typeof context.sessionID === "string" ? context.sessionID : ""
              const reset = (input as { reset?: unknown }).reset === true
              const chatText = (() => { try { return readFileSync(chatPath, "utf8") } catch { return "" } })()
              const chatLines = chatText ? chatText.split("\n").length : 0
              const sigs = stateSigs(ledger, chatLines)
              const seen = stateSeen.get(sid)
              const calls = (seen?.calls ?? 0) + 1
              if (!reset && seen && seen.calls % 10 !== 9) {
                const changed = changedSections(seen.sigs, sigs)
                if (!changed.length) {
                  stateSeen.set(sid, { version: stateVersion, sigs, calls })
                  return { content: JSON.stringify({ state: "unchanged", version: stateVersion, footer: `без изменений, снапшот v${stateVersion} (потреблён v${seen.version})` }) }
                }
                const delta: Record<string, unknown> = { state: "delta", version: stateVersion, changed }
                if (changed.includes("tasks")) delta.tasks = projectWorksheet(ledger)
                if (changed.includes("agents")) delta.agents = projectAgentsBrief(ledger)
                if (changed.includes("chat")) delta.chat = chatText.split("\n").slice(Math.max(0, seen.sigs.chatLines)).join("\n").trim()
                delta.footer = `дельта v${seen.version}→v${stateVersion}; полный снапшот: get_state {reset:true}`
                stateSeen.set(sid, { version: stateVersion, sigs, calls })
                return { content: JSON.stringify(delta, null, 2) }
              }
              stateSeen.set(sid, { version: stateVersion, sigs, calls })
              // T50: worksheet = рабочий лист агента (id · state · owner · ↳ дети),
              // tabs = данные о вкладках; ui — полная панель (только full-снапшот).
              return {
                content: JSON.stringify(
                  { state: "full", version: stateVersion, ui: projection.ui, runtime: diag, tabs: projectTabs(ledger), worksheet: projectWorksheet(ledger), agents: projectAgentsBrief(ledger) },
                  null,
                  2,
                ),
              }
            }

            // T95: project() требует CPU-пороги, а в скоупе обработчика cpuState
            // не объявлен → ReferenceError ПОСЛЕ applyOp+save (оп уже в файле,
            // но ответ ok:false без ui — инцидент 08.10 14:10). Одна декларация
            // на весь скоуп: покрывает model_reset (1862) и репроекцию (1888/1901).
            const cpuState = getCpuState()
            if (input.op === "model_reset") {
              // T66: пересылка фразы Основателя «был рейт лимит, перезапусти» —
              // кулдауны сброшены, выбор моделей возвращается к дефолту (демон
              // = nemotron); статистика успех/провал остаётся (обучение).
              const l = read().ledger
              const cleared = resetModelCooldowns(l)
              clearQuotaGuard() // T132: «был рейт лимит, перезапусти» снимает и guard-квоту
              save(l)
              progress(project(l, activeGrace ?? activeIds, stateFile, repoSpeedCurrent, instanceSpeedCurrent, cpuState.warning, cpuState.hardStop, cpuState.lastSample?.pct ?? null, quotaUsage()))
              return {
                content: JSON.stringify(
                  { ok: true, op: "model_reset", cooldowns_cleared: cleared, models: modelStats(l) },
                  null,
                  2,
                ),
              }
            }

            const { ledger, projection } = read()
            // Атрибуция (T34): create помечает задачу сессией вызывающего —
            // она уже зарегистрирована context-hook'ом в этом же ходу; неизвестный
            // вызывающий (ребёнок/исполнитель) → последняя активная вкладка.
            // Поле навязывается рантаймом: модель session_ref передать не может.
            const caller = typeof context.sessionID === "string" ? context.sessionID : ""
            const attributed = caller && ledger.tabs.some((t) => t.session_id === caller) ? caller : lastTopSession
            const outcome = applyOp(ledger, { ...input, session_ref: attributed }, { idFile: stateFile })
            if (!outcome.ok) {
              // Error + current truth (slim), so a failed op still leaves fresh state in context.
              progress(projection)
              return { content: JSON.stringify({ ok: false, error: outcome.error, ui: projection.ui }, null, 2) }
            }
            save(outcome.ledger).catch((e) => {
              console.error("[dev-console] save after op:", e)
            })
            // T117: смена статуса задачи — переименовать вкладки (событийно).
            void refreshActivityTitles()
            let next = project(outcome.ledger, activeGrace ?? activeIds, stateFile, repoSpeedCurrent, instanceSpeedCurrent, cpuState.warning, cpuState.hardStop, cpuState.lastSample?.pct ?? null, quotaUsage())

            // Dispatch trigger: assigned work starts → the runtime owns the stream.
            let dispatched: { task_id: string; agent: string; session_id: string; agent_type: string } | null = null
            let dispatchNote: string | null = null
            if (
              (input.op === "set_state" || input.op === "update") &&
              outcome.task.state === "DOING" &&
              outcome.task.owner
            ) {
              const d = await dispatch(outcome.task)
              if (d.status === "spawned") {
                dispatched = { task_id: d.task_id, agent: d.agent, session_id: d.session_id, agent_type: d.agent_type }
                next = project(loadLedger(stateFile), activeGrace ?? activeIds, stateFile, repoSpeedCurrent, instanceSpeedCurrent, cpuState.warning, cpuState.hardStop, cpuState.lastSample?.pct ?? null, quotaUsage()) // fresh projection with the agent record
              } else {
                dispatchNote = d.status === "skipped" ? d.reason : `failed: ${d.error}`
              }
            }

            progress(next)
            // T38: Include phase estimate info in response for create operations
            const estInfo = (outcome.task as Task & { _estInfo?: string })._estInfo
            return {
              content: JSON.stringify(
                {
                  ok: true,
                  id: outcome.task.id,
                  state: outcome.task.state,
                  ...(dispatched ? { dispatched } : {}),
                  ...(dispatchNote ? { dispatch: dispatchNote } : {}),
                  ...(estInfo ? { phase_est: estInfo } : {}),
                  ui: next.ui,
                },
                null,
                2,
              ),
            }
          } catch (e) {
            return { content: JSON.stringify({ ok: false, error: String(e) }, null, 2) }
          }
        },
      })
    })

    // ---------------------------------------------------- Stage 2: agents ----
    // Agent records exist only because the runtime observed the spawn.
    const hookish = ctx.tool as unknown as
      | { hook?: (name: string, cb: (event: Record<string, unknown>) => void) => Promise<unknown> }
      | undefined
    const hasToolHooks = typeof hookish?.hook === "function"

    // Spawn-tool discovery retries until it lands: a load-time race left an
    // instance with tracking inactive for a whole run (N00sphere, 07.10.2026).
    let discoverSpawn: (() => Promise<Set<string> | null>) | null = null
    if (hasToolHooks) {
      let spawnIds: Set<string> | null = null
      discoverSpawn = async (): Promise<Set<string> | null> => {
        if (spawnIds) return spawnIds
        try {
          const registered = await ctx.tool.list()
          const spawn = registered.find((t) => /spawns? an agent in a child session|child session/i.test(t.description ?? ""))
          if (spawn) {
            spawnIds = new Set([spawn.id, (spawn as { name?: string }).name].filter(Boolean) as string[])
            diag.spawn_tool = spawn.id
            console.log(`[dev-console] stage2: tracking spawn tool '${spawn.id}'`)
          } else {
            console.log("[dev-console] stage2: spawn tool not found yet — tracking pending")
          }
        } catch (e) {
          console.error("[dev-console] stage2 spawn discover:", e)
        }
        return spawnIds
      }
      await discoverSpawn()
      const refOf = (event: Record<string, unknown>): string | null => {
        for (const key of ["callID", "id", "sessionID"]) {
          const v = event[key]
          if (typeof v === "string" && v !== "") return v
        }
        return null
      }

      try {
        await hookish.hook!("execute.before", async (event) => {
          const ids = spawnIds ?? (await discoverSpawn?.())
          if (!ids?.has(String(event.tool))) return
            try {
              // T95: CPU gate before spawn — probe + two thresholds
              const cpu = cpuGate()
              diag.cpu_pct = cpu.sample?.pct ?? null
              diag.cpu_warning = cpu.warning
              diag.cpu_hard_stop = cpu.hardStop
              diag.cpu_peak = cpu.peak
              if (!cpu.allow) {
                // HARD STOP: block spawn, kill runaway processes
                const killed = killRunawayProcesses(3)
                console.log(
                  `[dev-console] CPU HARD STOP (T95) in spawn hook: ${cpu.reason}. Killed: ${killed.killed} (${killed.pids.join(", ") || "none"})`,
                )
                return // abort spawn
              }
              if (cpu.defer) {
                // WARNING: log but allow spawn (could add delay here if needed)
                console.log(`[dev-console] CPU WARNING (T95) in spawn hook: ${cpu.reason} — spawn allowed but deferred`)
              }

              const ledger = loadLedger(stateFile)
              // Вкладка спавна: вызывающая сессия, если это известная вкладка,
              // иначе последняя активная (спавн из ребёнка/исполнителя).
              const called = typeof event.sessionID === "string" ? event.sessionID : ""
              const home = called && ledger.tabs.some((t) => t.session_id === called) ? called : lastTopSession
              const agent = beginAgent(ledger, { input: event.input, ref: refOf(event), home, idFile: stateFile })
              save(ledger)
              scheduleEta(agent)
              console.log(
                `[dev-console] stage2: agent ${agent.id} (${agent.label}) running${agent.task_id ? ` for ${agent.task_id}` : ""}`,
              )
            } catch (e) {
              console.error("[dev-console] stage2 begin:", e)
            }
          })

          await hookish.hook!("execute.after", async (event) => {
            const ids = spawnIds ?? (await discoverSpawn?.())
            if (!ids?.has(String(event.tool))) return
            try {
              const callRef = refOf(event)
              const resultText = JSON.stringify(event.result ?? event.content ?? "")
              const child = /ses_[A-Za-z0-9]+/.exec(resultText)?.[0] ?? null
              const ledger = loadLedger(stateFile)
              let touched = false
              let pendingTurn: string | null = null // T52: completed спавна — terminal-проверкой, ПОСЛЕ save

              if (event.status !== "completed") {
                // The spawn call itself failed — settle by call id (T46: смерть
                // исполнителя = пометка agent_error на задаче + будим владельца).
                const dead = settleEvent(ledger, "failed", callRef, "спавн-вызов не удался")
                touched = !!dead
                if (dead?.task_id) wakeAgentError(dead.task_id, dead.id, "спавн-вызов не удался")
              } else if (child) {
                // Rebind call id → child session id; the child's lifecycle is the truth.
                const rk = rekeyAgent(ledger, callRef, child)
                if (rk) {
                  touched = true
                  attachModel(rk.id, child) // модель ребёнка — в панель
                }
                // Foreground children finish before the call returns and carry a
                // terminal `state="…"` in the result; background children don't —
                // those stay running and settle on session.execution events.
                const terminal = /state="(completed|failed|aborted)"/.exec(resultText)
                if (terminal && terminal[1] === "completed") {
                  // T52: `completed` результата спавна — не terminal сам по себе
                  // (тот же класс «ход ≠ конец»): активность сессии зафиксирована,
                  // закрытие уходит terminal-проверке (нет в active + тишина).
                  noteSessionActivity(child)
                  pendingTurn = child
                } else if (terminal) {
                  const settled = settleEvent(ledger, "failed", child, `спавн-результат state="${terminal[1]}"`)
                  if (settled) touched = true
                  if (settled && settled.task_id) {
                    wakeAgentError(settled.task_id, settled.id, `исполнитель завершился state="${terminal[1]}"`)
                  }
                }
              } else {
                // No child visible in the result: the call itself is the lifecycle —
                // сессии нет, terminal-проверить нечего (T52: проверяем только
                // наблюдаемые ses_-сессии), поэтому закрываем сразу, как раньше.
                const done = settleEvent(ledger, "completed", callRef)
                touched = !!done
                if (done?.model) recordModelResult(ledger, done.model, true) // T66
              }

              if (touched) {
                save(ledger)
                console.log(`[dev-console] stage2: after-hook settled (child=${child ?? "none"})`)
              }
              // T52: после сохранения перебинденной записи (иначе гонка двух
              // save перетирает закрытие — или закрытие не находит ребёнка).
              if (pendingTurn) settleTurn(pendingTurn, `спавн-результат state="completed" — ход, не конец (T52)`)
            } catch (e) {
              console.error("[dev-console] stage2 settle:", e)
            }
          })
          diag.tool_hooks = true
        } catch (e) {
          console.error("[dev-console] stage2 hook registration failed:", e)
        }
    }

    // ------------------------------------- context injection of live state ----
    // Fresh `ui` pushed into the top-level session's system before every model call.
    const sessionHooks = ctx.session as unknown as {
      hook?: (name: string, cb: (event: Record<string, unknown>) => Promise<void> | void) => Promise<unknown>
      get?: (input: { sessionID: string }) => Promise<{
        parentID?: string | null
        title?: string
        model?: unknown
      }>
    }

    // ------------------------------------------ T62: foreign sessions tracking ----
    // Foreign sessions (from other projects) are tracked but NOT shown as tabs.
    // They appear as a single collapsed line at the bottom of the panel.
    const foreignSessions = new Map<string, { title: string; lastSeen: number }>()
    const FOREIGN_TTL_MS = 5 * 60_000 // 5 min TTL for foreign session tracking

    // Helper: check if a session belongs to this project.
    // T104(1): правило «чужой = доказано» живёт в state.ts (isForeignSession,
    // юнит-тесты): реестр вкладок главнее путей, неизвестный directory — не
    // доказательство чужого, подпапка проекта — своя; прежнее сравнение
    // «строгое равенство строк» клало свои вкладки в 🌍 ЧУЖИЕ.
    const isLocalSession = (
      sessionID: string,
      info: { directory?: unknown } | null | undefined,
      tabs: TabSession[],
    ): boolean => !isForeignSession(sessionID, info?.directory, root, tabs)

    // ------------------------------------------ instance renaming (T64/T87) ----
    // Заказ Основателя 07.10: инстанс верхнего уровня = Маруська Гольденштерн
    // (Андроид-дочь МаЯтрицы, Звезда Иронии и Контроля, люцифероватая девчушка-
    // гений Luna). Наблюдение вкладки → титул её сессии в сайдбаре OpenCode:
    // уникальная тема (T33/T59) впереди, персона — хвостом (порядок T86: иначе
    // шапки всех вкладок одинаковые), прежний титул Маруськи распознаётся и
    // переставляется (personaTitle — чистая функция, юнит-тесты).
    // T87: эмодзи инстанса — ПЕРВЫМ токеном титула («<эмодзи> <тема> · <персона>»),
    // чтобы во вкладке OpenCode он «горел» впереди. Берём эмодзи из записи вкладки.
    // Авто-титул OpenCode может перетереть — тогда вернём персону при следующем
    // наблюдении; троттлинг RENAME_GAP_MS не даёт PATCH-шторма и не спамит лог
    // при отказе. Мигающая вкладка (T60) не трогается: цикл держит свой ORIGINAL.
    const RENAME_GAP_MS = 60_000
    const renamedAt = new Map<string, number>() // sessionID → когда последний раз пробовали
    // T117: какую тему поставили мы сами (по событию). Если текущая тема вкладки
    // не равна нашей последней авто-теме — её поставил человек → не трогаем.
    const autoTopicBySession = new Map<string, string>()
    // T117: темы вкладок в файле DEVATA/tab_topics.json — переживают рестарт
    // плагина и НЕ трогают чужой регион state.ts.
    const tabTopicsPath = (): string => join(root, "DEVATA", "tab_topics.json")
    interface TabTopicRecord {
      auto: string // тема, которую поставили мы
      backup: string | null // ручная тема Основателя до первой подмены
    }
    const readTabTopics = (): Map<string, TabTopicRecord> => {
      const out = new Map<string, TabTopicRecord>()
      try {
        const raw = readFileSync(tabTopicsPath(), "utf8").trim()
        if (raw) {
          const parsed = JSON.parse(raw) as Record<string, TabTopicRecord>
          for (const [k, v] of Object.entries(parsed)) if (v && typeof v.auto === "string") out.set(k, v)
        }
      } catch { /* файла нет/битый — начинаем с чистого листа */ }
      return out
    }
    const writeTabTopics = (m: Map<string, TabTopicRecord>): void => {
      try {
        const dir = join(root, "DEVATA")
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(tabTopicsPath(), JSON.stringify(Object.fromEntries(m), null, 2), "utf8")
      } catch (e) {
        console.error("[dev-console] T117: запись тем не удалась:", e)
      }
    }
    const tabTopics = readTabTopics()
    // T117: страховка тика: как часто обновляем темы вкладок без события.
    const ACTIVITY_TITLES_MS = 5 * 60_000
    let activityTitlesAt = 0
    // T117: переименовать вкладки по ЖИВОЙ деятельности. Вызывается СОБЫТИЙНО
    // (смена статуса задачи, settle демона) — не по таймеру: инстанс персистентен,
    // строка «что делает» должна меняться, когда инстанс взял/закрыл задачу.
    // Титул берём у самой сессии (sessionHooks/HTTP), тему считаем по леджеру.
    // T117-динамика: тема из титула канона T166 «[Эмодзи] Персона · Тема» —
    // то, что ПОСЛЕ персоны (и после эмодзи). Хвостовой вид «Тема · Персона»
    // (старый канон) тоже понимаем.
    const personaTopicOf = (title: string, persona: string | null): string => {
      let t = title.trim()
      const em = /^(\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F)?\s+(.*)$/u.exec(t)
      if (em) t = (em[2] ?? "").trim()
      if (persona) {
        if (t === persona) return ""
        for (;;) {
          if (!t.startsWith(persona + " · ")) break
          t = t.slice(persona.length + 3).trim()
        }
        const idx = t.lastIndexOf(" · ")
        if (idx > 0 && t.slice(idx + 3).trim() === persona) return t.slice(0, idx).trim()
      }
      return t
    }
    const refreshActivityTitles = async (): Promise<void> => {
      // КРАН СНЯТ (Основатель 16.11, дословно «Хочу»): динамика тем верхних
      // вкладок вернулась. Старые причины крана (append-петля вместо replace,
      // мохибейк в state.json) вылечены и прикрыты тестами; канон T166
      // «Персона · Тема» держит имя инстанса первым — вкладки узнаваемы.
      const l = loadLedger(stateFile)
      for (const tab of l.tabs) {
        try {
          let raw: string | null = null
          try {
            const info = await sessionHooks.get?.({ sessionID: tab.session_id })
            if (typeof info?.title === "string" && info.title.trim() !== "") raw = info.title
          } catch {
            /* источник недоступен — пропускаем вкладку */
          }
          if (raw === null) {
            const http = await titleViaHttp(tab.session_id)
            if (http) raw = http.title
          }
          if (raw === null) continue
          // 1) персона/эмодзи в каноне (T64/T87/T91) — идемпотентно, без PATCH при каноне
          await ensurePersonaTitle(tab.session_id, raw)
          // 2) T117: тема деятельности — «Мара · T14 · РОЖДАЮ ФИКС». Работы нет —
          // возвращаем ручную тему (простой не должен врать «РОЖДАЮ ФИКС»).
          const rec = tabTopics.get(tab.session_id)
          const topic = activityTopic(l, tab.session_id)
          const revert = topic === "" && !!rec?.backup
          const desired =
            topic !== ""
              ? personaTitle(topic, tab.emoji, tab.persona)
              : revert
                ? personaTitle(rec!.backup!, tab.emoji, tab.persona)
                : null
          if (desired === null || desired === raw.trim()) continue
          if (blinkTimers.has(tab.session_id)) continue // мигает: ORIGINAL цикла не трогаем (T60)
          const last = renamedAt.get(tab.session_id) ?? 0
          if (Date.now() - last < RENAME_GAP_MS) continue // тот же темп не долбим
          renamedAt.set(tab.session_id, Date.now())
          // книга тем ПЕРЕД патчем: событие после PATCH не примет нашу тему за ручную
          tabTopics.set(tab.session_id, { auto: topic, backup: rec?.backup ?? null })
          writeTabTopics(tabTopics)
          try {
            await patchTitle(tab.session_id, desired)
            const l2 = loadLedger(stateFile)
            const t2 = l2.tabs.find((x) => x.session_id === tab.session_id)
            if (t2 && t2.title !== desired) {
              t2.title = desired // реестр сразу показывает новое имя; last_seen не двигаем
              save(l2)
            }
            console.log(`[dev-console] activity rename (T117): ${tab.session_id} → ${desired}`)
          } catch (e) {
            console.error(`[dev-console] activity rename (T117) ${tab.session_id}:`, e)
          }
        } catch (e) {
          console.error("[dev-console] T117 activity titles:", e)
        }
      }
    }
    const ensurePersonaTitle = async (sessionID: string, raw: unknown): Promise<boolean> => {
      const title = typeof raw === "string" ? raw.trim() : ""
      if (title === "") return false
      // T87: эмодзи из записи вкладки (уже назначенный при первой регистрации T71).
      const ledger = loadLedger(stateFile)
      const tab = ledger.tabs.find((t) => t.session_id === sessionID)
      // T136 (декрет Основателя 29.10 дословно): «ПОРТРЕТ, ЕСЛИ окно в консоли
      // СРЕДИ ИНСТАНСОВ и я с ним РУКАМИ переписывался» — title-перезапись и
      // эмодзи-префикс ТОЛЬКО для табов с manual===true (ручной чат).
      // Системные дети/будилки/разовые сессии — титул их сюда не тащим.
      // T117: строку-деятельности («что делает») обновляем у ВСЕХ верхних вкладок
      // репо — канон 29.10: она нужна каждому персистентному инстансу. ПОРТРЕТ
      // (эмодзи) — только у прямых чатов (T136): служебным вкладкам не навязываем.
      if (!tab) return false
      // Портрет: у прямых чатов — из записи вкладки (T136), у остальных —
      // сохраняем тот, что УЖЕ стоит в титуле (иначе перезапись темы срезала
      // бы 👩 у вкладок Основателя).
      const parsed = parseTitle(title)
      // T152-инцидент 12.11: эмодзи-поле, переживший пересборку реестра,
      // собирал таргет PATCH-а с ЧУЖИМ портретом (🧚 vs 🧝) и перетирал канон.
      // Канон = титул сессии (session_rename Основателя): первый токен из
      // палитры инстансов правит поле ДО сборки таргета. Глифы мигалки
      // (⚡◉✦) в палитру не входят — усыновляются только истинные портреты.
      const titleEmoji = titleEmojiOf(title)
      if (titleEmoji && tab.emoji !== titleEmoji) {
        tab.emoji = titleEmoji
        void save(ledger)
      }
      // Портрет берём из записи вкладки: его уже назначает консоль по
      // правилам T125/T136 (прямые чаты — свой портрет, служебные — ▸).
      // Если эмодзи нет в записи — сохраняем тот, что стоит в титуле.
      const emoji = tab.emoji ?? parsed.emoji
      // Канон 06:00 действовал до 16.11: динамика тем для top-вкладок была
      // ЗАПРЕЩЕНА (инцидент «неузнаваемые имена»). Основатель 16.11 заказал
      // динамику обратно — канон T166 «Персона · Тема» держит имя первым,
      // поэтому composeActivityTitle снова легален (см. refreshActivityTitles).
      const topic = parsed.topic
      // T152 (канон Основателя 11.11): у вкладки СВОЁ имя из каталога (Маруська
      // = базовая старейшего таба, остальные — Мария Кюри/Магдалена/Мара/Маша,
      // ВМ и Гольфия только по вызову). Не назначено — назначаем сейчас и
      // сохраняем; титул собирается с назначенным именем (канон T86).
      if (!tab.persona) {
        assignInstancePersona(ledger, sessionID)
        if (tab.persona) void save(ledger)
      }
      const target = personaTitle(title, emoji, tab.persona)
      // T117-динамика (заказ Основателя 16.11 «Хочу»): ручная тема Основателя
      // — бэкап, к которому возвращаемся при простое. Ручной считается тема,
      // не равная нашей последней авто-теме (книга тем tab_topics.json).
      // В реестре только верхние вкладки — бэкап ведём для всех.
      {
        const curTopic = personaTopicOf(title, tab.persona)
        const recT = tabTopics.get(sessionID)
        if (curTopic !== "" && curTopic !== (recT?.auto ?? "")) {
          tabTopics.set(sessionID, { auto: recT?.auto ?? "", backup: curTopic })
          writeTabTopics(tabTopics)
        }
      }
      if (target === title) {
        // T91: сессия уже канонична, но ЗАПИСЬ реестра могла отстать — раньше
        // здесь был пустой выход и stale-вкладка врела в state.json, пока не
        // пробудится (панель стригла хвост только на рендере describeTab).
        // Синхронизируем запись из титула сессии; мигающую вкладку не трогаем —
        // там title = глиф цикла, а не титул (ORIGINAL восстановит stopBlink).
        if (tab && !blinkTimers.has(sessionID) && syncTabTitle(tab, title)) {
          void save(ledger) // last_seen не двигаем: титул — не активность
          return true
        }
        return false // уже с персоной и эмодзи — менять нечего
      }
      const last = renamedAt.get(sessionID) ?? 0
      if (Date.now() - last < RENAME_GAP_MS) return false // тот же title повторяется — не долбим
      if (blinkTimers.has(sessionID)) return false // мигает: ORIGINAL цикла не трогаем
      renamedAt.set(sessionID, Date.now())
      try {
        await patchTitle(sessionID, target)
        const l = loadLedger(stateFile)
        const t = l.tabs.find((x) => x.session_id === sessionID)
        if (t && t.title !== target) {
          t.title = target // реестр сразу показывает новое имя; last_seen не двигаем
          save(l)
        }
        console.log(`[dev-console] instance rename (T64/T87): ${sessionID} → ${target}`)
        // T116: переименование = смена имени инстанса → реестр «я здесь»
        // обновляется (presence-гейты чужих проектов должны видеть свежее имя;
        // throttle 60с внутри touchRegistry).
        touchRegistry(pluginHubDevata, root)
        return true
      } catch (e) {
        console.error(`[dev-console] instance rename (T64/T87) ${sessionID}:`, e)
        return false
      }
    }

    // ------------------------------------------ T91: периодический рефреш титулов ----
    // Пункт (в) заказа: титул записи обновляется только на инжекте АКТИВНОЙ
    // сессии (upsertTab в контекст-хуке), сида из ctx.session.list нет (этой
    // сборке list не отдан — diag.session_list=false), а ensurePersonaTitle при
    // target===title раньше выходил, не трогая запись. Итог: stale-вкладка лежала
    // в реестре с двойным хвостом «· Маруська…», и лгал он до пробуждения.
    // Решение: раз в TAB_TITLE_SYNC_MS сверяем записи ИЗВЕСТНЫХ session_id с
    // доступным источником —
    //   1) ctx.session.get — тот же канал плагина, что у контекст-хука;
    //   2) HTTP GET /api/session/{id} — тот же сервер, что active-проб (T73)
    //      и HTTP-PATCH мигания (T60), ответ {data:{title}} (живой прогон T91).
    // Источник молчит/отказывает — запись не трогаем (титул не выдумываем).
    // Мигающие вкладки и исполнители (T89: не вкладки) не участвуют.
    const TAB_TITLE_SYNC_MS = 5 * 60_000
    const titleViaHttp = async (sessionID: string): Promise<{ title: string; parentID: string | null } | null> => {
      const ep = endpoint()
      if (!ep) return null
      try {
        const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(3_000) : undefined
        const call = (headers: Record<string, string>): Promise<Response> =>
          fetch(`${ep.url}/api/session/${sessionID}`, { headers, signal })
        let res = await call(ep.auth ? { authorization: ep.auth } : {})
        if (res.status === 401 && ep.auth) res = await call({})
        if (!res.ok) return null
        const body = (await res.json()) as { data?: { title?: unknown; parentID?: unknown } }
        const title = body?.data?.title
        const parentID = typeof body?.data?.parentID === "string" && body.data.parentID !== "" ? body.data.parentID : null
        return typeof title === "string" && title.trim() !== "" ? { title, parentID } : null
      } catch {
        return null // сеть/таймаут молчит — цикл попробует в следующий заход
      }
    }
    // T136 (декрет Основателя 29.10 дословно): «ПОРТРЕТ, ЕСЛИ окно в консоли
    // среди инстансов и я с ним РУКАМИ переписывался» — пробник ищет хотя бы
    // одно РУЧНОЕ user-сообщение: не наше synthetic («DEV CONSOLE wake:») и
    // не спавн-диспатча («[T##] …»). Сомнение/ошибка → три-состояльный null
    // (повтор в следующий заход; по сомнению портрет не выдаём и не снимаем).
    const EMOJI_PREFIX_RE = /^(\p{Extended_Pictographic}|[\u25C9\u26A1\u25CF\u2022])+\uFE0F?\s*/u
    const manualChat = async (sessionID: string): Promise<boolean | null> => {
      try {
        const messages = (await ctx.session.context({ sessionID })) as unknown
        if (!Array.isArray(messages)) return null // форма изменилась — не гадаем
        let sawUser = false
        for (const m of messages as { type?: string; payload?: unknown }[]) {
          if (m.type !== "user") continue
          sawUser = true
          const payload = m.payload as
            | { parts?: { type?: string; text?: string }[]; content?: { type?: string; text?: string }[] }
            | undefined
          const segs = payload?.parts ?? payload?.content
          const text = segs
            ?.filter((p) => p.type === "text" && typeof p.text === "string")
            .map((p) => p.text)
            .join("\n")
          const t = (text ?? "").trim()
          if (t === "") continue
          if (t.startsWith("DEV CONSOLE")) continue // wakeMessage
          if (/^\[T\d+\]/.test(t)) continue // dispatch-промпт [T##]
          return true // ручное сообщение Основателя найдено
        }
        return sawUser ? false : null // user-частей нет вовсе — форма/пусто, не утверждаем
      } catch (e) {
        console.error(`[dev-console] T136 manual probe ${sessionID}:`, e)
        return null
      }
    }
    const syncTabTitles = async (): Promise<void> => {
      try {
        const l = loadLedger(stateFile)
        let changed = 0
        for (const tab of [...l.tabs]) {
          if (blinkTimers.has(tab.session_id)) continue // мигает: ORIGINAL цикла не трогаем
          if (isExecutorTab(l, tab)) continue // исполнитель — не вкладка (T89), его не перекрашиваем
          let title: string | null = null
          let parentID: string | null = null
          try {
            const info = await sessionHooks.get?.({ sessionID: tab.session_id })
            if (typeof info?.title === "string" && info.title.trim() !== "") title = info.title
            const p = (info as { parentID?: unknown } | undefined)?.parentID
            if (typeof p === "string" && p !== "") parentID = p
          } catch (e) {
            console.error(`[dev-console] T91 title sync: session.get ${tab.session_id}:`, e)
          }
          if (title === null) {
            const http = await titleViaHttp(tab.session_id)
            if (http) {
              title = http.title
              if (parentID === null) parentID = http.parentID
            }
          }
          if (title === null) continue // источника нет — запись остаётся как есть
          // T136: три-состояльный пробник ручного чата (кэш в tab.manual).
          // Дети (parentID задан = субагент/дочерняя сессия) НИКОГДА не ручной
          // чат — без пробы; остальные — context-проба (не wake, не [T##]).
          // manual=true → портрет: выдаём emoji из палитры, если вкладка без
          // него; manual=false → портрет снимаем один раз (PATCH без эмодзи).
          if (tab.manual == null) {
            const isManual = parentID !== null ? false : await manualChat(tab.session_id)
            if (isManual !== null) {
              tab.manual = isManual
              if (isManual && !tab.emoji) {
                tab.emoji = assignEmoji(INSTANCE_EMOJI, l.tabs.map((t) => t.emoji))
                console.log(`[dev-console] T136: ручной чат → портрет ${tab.emoji} ${tab.session_id}`)
              }
              if (!isManual && tab.emoji && EMOJI_PREFIX_RE.test(title)) {
                const stripped = title.replace(EMOJI_PREFIX_RE, "")
                try {
                  await patchTitle(tab.session_id, stripped)
                  title = stripped
                  console.log(`[dev-console] T136: портрет снят (не ручной чат): ${tab.session_id}`)
                } catch (e) {
                  console.error(`[dev-console] T136 strip ${tab.session_id}:`, e)
                  tab.manual = null // не сняли — вернёмся в следующий заход
                }
              }
              void save(l)
            }
          }
          // Каноничен → запись = ему (пункт (б)); нет → PATCH сессии + запись =
          // target, троттлинг RENAME_GAP_MS держит от PATCH-шторма.
          if (await ensurePersonaTitle(tab.session_id, title)) changed += 1
        }
        if (changed > 0) {
          diag.title_sync += changed
          console.log(`[dev-console] T91: title sync починил записей: ${changed}`)
        }
      } catch (e) {
        console.error("[dev-console] T91 title sync:", e)
      }
    }
    const titleSyncTimer = setInterval(() => void syncTabTitles(), TAB_TITLE_SYNC_MS)
    void syncTabTitles() // сразу на загрузке: уже лежащие stale-записи чиним, не дожидаясь ритма

    // ------------------------------------------ T33: динамический список вкладок --
    // Заказ Основателя (T33): «несколько агентов (вкладок) в одном репо: панель
    // должна показывать динамический список вкладок проекта — строка начинается
    // с имени вкладки». Источник — GET /api/session того же сервера (endpoint()
    // = active-проб T73; ctx.session.list из T34 эта сборка не отдаёт): ответ содержит все сессии всех проектов с живыми
    // именами и временем обновления; фильтр проекта/имени/top-сессии — чистая
    // parseSessionFeed (state.ts), слияние — applyTabFeed: имя обновляется
    // живьём, last_seen срез не двигает (T91), исполнители не регистрируются
    // (T89). Ритм 15с — имена вкладок в панели свежее пятиминутного T91-цикла,
    // а новая вкладка репо видна до первого вызова модели. Мигающие вкладки
    // (T60) из среза уходят: их живой титул = глиф цикла, а не имя.
    // Изменения → save (перерисовка панели); без изменений диск не трогаем.
    const TAB_FEED_MS = 15_000
    // Last-tool snapshots are reconstructed from the last few projected messages
    // after reconnects/event gaps. Throttled per child; usage comes from /api/session.
    const toolSyncAt = new Map<string, number>()
    let toolSyncBusy = false
    const syncChildToolSnapshots = (ep: { url: string; auth?: string }, children: ReturnType<typeof parseChildFeed>): void => {
      if (toolSyncBusy || children.length === 0) return
      void (async () => {
        toolSyncBusy = true
        try {
          let latestLedger = loadLedger(stateFile)
          const pending = children.filter((child) => {
            const agent = latestLedger.agents.find((a) => a.session_ref === child.session_id && (a.state === "running" || a.state === "waiting"))
            return !!agent && Date.now() - (toolSyncAt.get(child.session_id) ?? 0) >= 30_000
          }).slice(0, 8)
          for (const child of pending) toolSyncAt.set(child.session_id, Date.now())
          let changed = false
          for (const child of pending) {
            try {
              const url = `${ep.url}/api/session/${encodeURIComponent(child.session_id)}/message?limit=8&order=desc`
              const options = (auth?: string): RequestInit => ({
                headers: auth ? { authorization: auth } : {},
                signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(3_000) : undefined,
              })
              let response = await fetch(url, options(ep.auth))
              if (response.status === 401 && ep.auth) response = await fetch(url, options())
              if (!response.ok) continue
              const payload = await response.json() as unknown
              const messages = Array.isArray(payload) ? payload : ((payload as { data?: unknown })?.data ?? [])
              if (!Array.isArray(messages)) continue
              let latest: { name: string; target: string | null; callId: string | null; at: string; ms: number } | null = null
              for (const rawMessage of messages) {
                if (!rawMessage || typeof rawMessage !== "object") continue
                const message = rawMessage as Record<string, unknown>
                const info = message.info && typeof message.info === "object" ? message.info as Record<string, unknown> : {}
                const messageTime = info.time && typeof info.time === "object" ? info.time as Record<string, unknown> : {}
                const parts = Array.isArray(message.parts) ? message.parts : Array.isArray(message.content) ? message.content : []
                for (const rawPart of parts) {
                  if (!rawPart || typeof rawPart !== "object") continue
                  const part = rawPart as Record<string, unknown>
                  const toolName = typeof part.tool === "string" ? part.tool : typeof part.name === "string" ? part.name : null
                  if (part.type !== "tool" || !toolName) continue
                  const state = part.state && typeof part.state === "object" ? part.state as Record<string, unknown> : {}
                  const inputValue = state.input ?? part.input
                  const input = inputValue && typeof inputValue === "object" ? inputValue : null
                  const stateTime = state.time && typeof state.time === "object" ? state.time as Record<string, unknown> : {}
                  const partTime = part.time && typeof part.time === "object" ? part.time as Record<string, unknown> : {}
                  const ms = typeof stateTime.start === "number" ? stateTime.start : typeof partTime.ran === "number" ? partTime.ran : typeof partTime.start === "number" ? partTime.start : typeof messageTime.created === "number" ? messageTime.created : 0
                  if (latest && ms <= latest.ms) continue
                  let target: string | null = null
                  if (input && typeof input === "object") {
                    const values = input as Record<string, unknown>
                    for (const key of ["filePath", "path", "file", "url", "uri", "resource", "command", "cmd", "description", "prompt", "search", "query", "pattern", "glob", "directory", "target"]) {
                      const value = values[key]
                      if (typeof value === "string" && value.trim() !== "") { target = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").slice(0, 80); break }
                    }
                  }
                  if (!target && typeof state.title === "string") target = state.title.slice(0, 80)
                  latest = { name: toolName, target, callId: typeof part.callID === "string" ? part.callID : typeof part.id === "string" ? part.id : null, at: new Date(ms || Date.now()).toISOString(), ms }
                }
              }
              if (latest) {
                const current = loadLedger(stateFile)
                if (noteAgentTool(current, child.session_id, latest.name, latest.target, latest.at, latest.callId)) {
                  latestLedger = current
                  changed = true
                }
              }
              diag.agent_tool_resyncs += 1
            } catch {
              // Tool history is best-effort; never stall the main tab/usage feed.
            }
          }
          if (changed) await save(latestLedger)
        } finally {
          toolSyncBusy = false
        }
      })()
    }
    let feedBusy = false
    const pollTabFeed = async (): Promise<void> => {
      if (feedBusy) return // один срез за раз (таймер ≠ десять параллельных)
      feedBusy = true
      try {
        const ep = endpoint()
        if (!ep) {
          diag.tab_feed_err = "service.json/env: no endpoint"
          return
        }
        const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(3_000) : undefined
        const call = (headers: Record<string, string>): Promise<Response> =>
          fetch(`${ep.url}/api/session`, { headers, signal })
        let res = await call(ep.auth ? { authorization: ep.auth } : {})
        if (res.status === 401 && ep.auth) res = await call({}) // локальный сервер и без пароля
        if (!res.ok) throw new Error(`http ${res.status}`)
        const raw = await res.json()
        const rawItems = Array.isArray(raw)
          ? raw
          : Array.isArray((raw as { data?: unknown })?.data)
            ? ((raw as { data: unknown[] }).data)
            : []
        // T132: квота = Σcost/Σтокенов сессий за rolling-окно 93м — та же
        // лента, что дёргается каждые 15с (форма {cost, tokens, time.updated}
        // подтверждена живым пробом 29.10). Проценты Console API 404 → cost
        // честно показывает расход; когда сессий в окне нет — цифры не рисуем.
        const prevHeader = formatQuotaHeader(quotaUsage())
        await probeConsoleQuota() // проб Console API (троттл 5м, путь готов)
        const samples = rawItems.filter((s) => s && typeof s === "object") as Parameters<typeof rollingUsage>[0]
        const costQ = rollingUsage(samples, Date.now())
        quotaCost = costQ.sessions > 0 ? costQ : null
        // T133-кандидаты: ghost-вкладки — запись леджера, которой больше НЕТ в
        // живом фиде (сессия удалена/переименована), но last_seen ещё свежий:
        // до удаления реестра — только кандидаты, не авто-чистка.
        const seenAll = new Set(
          rawItems
            .map((s) => {
              const o = s as { id?: unknown; sessionID?: unknown }
              return typeof o?.id === "string" ? o.id : typeof o?.sessionID === "string" ? o.sessionID : null
            })
            .filter((v): v is string => v !== null),
        )
        const nowMs = Date.now()
        const ghosts = loadLedger(stateFile)
          .tabs.filter(
            (t) => !seenAll.has(t.session_id) && nowMs - Date.parse(t.last_seen) < 6 * 3_600_000,
          )
          .map((t) => ({ session_id: t.session_id, title: t.title, last_seen: t.last_seen }))
        diag.ghost_tabs = ghosts
        const childItems = parseChildFeed(raw, root)
        syncChildToolSnapshots(ep, childItems)
        const items = parseSessionFeed(raw, root).filter((i) => !blinkTimers.has(i.session_id))
        diag.tab_feed = items.length
        diag.tab_feed_err = null
        const headerChanged = formatQuotaHeader(quotaUsage()) !== prevHeader
        if (items.length === 0) {
          if (headerChanged) renderPane(loadLedger(stateFile)) // квота обновилась — шапка должна догнать
          return
        }
        const l = loadLedger(stateFile)
        const changed = applyTabFeed(l, items)
        // T170: субагенты-дети (parentID) из того же фида — строки-боты под вкладкой
        const kidCount = attachTabChildren(l, childItems)
        if (changed > 0 || kidCount > 0 || headerChanged) {
          if (changed > 0 || kidCount > 0) await save(l)
          else renderPane(l) // только квота изменилась — диск не трогаем, рендерим
          console.log(`[dev-console] T33 tab feed: вкладок проекта ${items.length}, обновлено ${changed}, субагентов ${kidCount}${headerChanged ? `, квота → ${formatQuotaHeader(quotaUsage())}` : ""}`)
        }
      } catch (e) {
        diag.tab_feed_err = String(e).slice(0, 200) // фид молчит — панель живёт на инжекте
      } finally {
        feedBusy = false
      }
    }
    const feedTimer = setInterval(() => void pollTabFeed(), TAB_FEED_MS)
    void pollTabFeed() // первый срез сразу: список вкладок живёт с загрузки

    // ------------------------------------------------- top sessions (tabs) --
    // T34: собираем данные о вкладках проекта. Сначала проверяем живой API:
    // отдаёт ли эта сборка `ctx.session.list`. (В этой сборке адаптер плагина
    // проводит create/get/switchAgent/…/context — list среди них нет, ожидаем
    // false; ответ виден в get_state → runtime.session_list.) Если list есть —
    // им засеваем регистр; фактическая работа всегда идёт через context-hook
    // инжект ниже: он видит каждую top-сессию (info.title/parentID) и
    // обновляет last_seen на каждом вызове модели.
    const sessionList = (ctx.session as { list?: (input?: unknown) => Promise<unknown> }).list
    diag.session_list = typeof sessionList === "function"
    if (typeof sessionList === "function") {
      void (async () => {
        try {
          const raw = await sessionList.call(ctx.session)
          const items = (Array.isArray(raw) ? raw : ((raw as { items?: unknown[] })?.items ?? [])) as Record<
            string,
            unknown
          >[]
          const l = loadLedger(stateFile)
          let seeded = 0
          let foreignCount = 0
          for (const s of items) {
            const id =
              typeof s.sessionID === "string" && s.sessionID !== ""
                ? s.sessionID
                : typeof s.id === "string"
                  ? s.id
                  : ""
            if (!id || s.parentID) continue // только top-сессии
            if (isExecutorSession(l, id) || dispatchedSessions.has(id)) continue // исполнитель — не вкладка
            // T62: filter foreign sessions - check directory from session info
            const info = await sessionHooks.get?.({ sessionID: id })
            if (!isLocalSession(id, info, l.tabs)) {
              // Track foreign session but don't upsert as tab
              const title = typeof s.title === "string" ? s.title : `ses_${id.slice(4, 12)}`
              foreignSessions.set(id, { title, lastSeen: Date.now() })
              foreignCount++
              continue
            }
            const stamp = (s.time as { updated?: number } | undefined)?.updated
            // Доверяем отметке только в правдоподобном диапазоне (ms-эпоха).
            const fresh = typeof stamp === "number" && stamp > Date.parse("2020-01-01")
            upsertTab(l, {
              session_id: id,
              title: typeof s.title === "string" ? s.title : null,
              model: shortModel(s.model),
              last_seen: fresh ? new Date(stamp).toISOString() : new Date().toISOString(),
            })
            seeded += 1
            // T64: инстанс верхнего уровня носит имя персоны (session_rename)
            void ensurePersonaTitle(id, s.title)
          }
          if (seeded > 0 || foreignCount > 0) {
            save(l)
            console.log(`[dev-console] tabs: session.list seeded ${seeded} local, ${foreignCount} foreign (tracked)`)
          }
        } catch (e) {
          console.error("[dev-console] session.list seed:", e)
        }
      })()
    } else {
      console.log("[dev-console] tabs: no ctx.session.list — seeding from the context-hook injection")
    }
    const seenInjected = new Set<string>()
    // T51: ритм полного ui на вкладку — первый ход сессии всегда полный,
    // дальше освежение раз в 10 минут; промежуточные ходы = счётчики.
    const FULL_UI_GAP_MS = 10 * 60_000
    const lastFullUi = new Map<string, number>() // sessionID → мс последнего полного ui
    if (typeof sessionHooks.hook === "function") {
      try {
        await sessionHooks.hook("context", async (event) => {
          try {
            const sessionID = String(event.sessionID ?? "")
            if (!sessionID) return
            const info = await sessionHooks.get?.({ sessionID })
            if (info?.parentID) {
              // T52: вызов контекста ребёнка = ход его сессии — активность
              // зафиксирована (тишина terminal-условия отсюда, а не «от succeeded»).
              noteSessionActivity(sessionID)
              // Bypass belt: ANY child session is an agent, even when its spawn
              // never crossed the tool hooks (nested code-mode spawn, hook miss).
              // One session = one record — rekey dedup covers double-keying.
              try {
                const l = loadLedger(stateFile)
                if (!isExecutorSession(l, sessionID)) {
                  const agent = beginAgent(l, {
                    input: { agent: "general", description: info.title ?? "child session" },
                    ref: sessionID,
                    home: lastTopSession, // вкладка, запустившая ребёнка (best effort)
                    idFile: stateFile,
                  })
                  save(l)
                  diag.context_recorded += 1
                  scheduleEta(agent)
                  attachModel(agent.id, sessionID)
                  console.log(`[dev-console] context recorder: agent ${agent.id} for child ${sessionID}`)
                }
              } catch (e) {
                console.error("[dev-console] context recorder:", e)
              }
              return // подагентам консоль не нужна
            }
            const { ledger, projection } = read()
            // Диспетчерный исполнитель — top-level, но не вкладка: ни баннера,
            // ни записи в регистре, ни пробуждений.
            if (isExecutorSession(ledger, sessionID)) return

            // T62: Filter foreign sessions - check if session belongs to this project
            if (!isLocalSession(sessionID, info, ledger.tabs)) {
              // Track foreign session but don't upsert as tab
              const title = typeof info?.title === "string" ? info.title : `ses_${sessionID.slice(4, 12)}`
              foreignSessions.set(sessionID, { title, lastSeen: Date.now() })
              return // foreign sessions don't get state injection either
            }

            lastTopSession = sessionID
            // T51 (экономия токенов): раньше каждый ход модели нес полную панель
            // (ui) целиком — сотни токенов на пересчёт одних и тех же секций.
            // Теперь: ПЕРВЫЙ ход сессии и освежение раз в FULL_UI_GAP_MS = полный
            // ui; все остальные ходы = дешёвый ряд счётчиков (projectCounters,
            // ~100–200 символов). Полная правда всё равно в get_state (worksheet)
            // и в живой панели; промежуточный ход несёт только счётчики.
            const now = Date.now()
            const lastFull = lastFullUi.get(sessionID) ?? 0
            const fullUi = now - lastFull >= FULL_UI_GAP_MS
            if (fullUi) lastFullUi.set(sessionID, now)
            const system = (event.system ??= []) as { type: string; text: string }[]
            // T6: the console banner is not persona initialization. Bind the
            // top-level identity to OpenCode's selected agent, with the local
            // persona suffix as fallback; unknown agents stay unbranded.
            const selectedAgent = typeof event.agent === "string" ? event.agent : null
            const topPersona = topLevelPersona(selectedAgent, info?.title)
            const identity = instancePromptBlock(topPersona)
            system.push({
              type: "text",
              text:
                "DEV CONSOLE live projection (dev_console = truth; record real events there).\n" +
                "The Founder reads state from the live pane (CONSOLE_UI.html) — replies are short comments.\n" +
                (identity ? identity + "\n" : "") +
                (fullUi
                  ? "Batches fan out to subagents; this thread orchestrates.\n" + projection.ui
                  : "Counters only this turn (full pane = CONSOLE_UI.html; get_state = full worksheet).\n" +
                    projectCounters(ledger)),
            })
            diag.injections += 1
            if (fullUi) diag.injections_full += 1
            else diag.injections_cheap += 1
            // T92: проекция уходит ТОЛЬКО топ-вкладкам — у вкладки нет записи
            // Agent (дети return'ят выше по parentID, исполнители — по
            // isExecutorSession), инкремент «по session_ref вкладки» был мёртвым
            // кодом и структурно всегда 0 (defect T41). Инжекты вкладки =
            // диагностика вкладки (diag.injections); «цена контекста задачи»
            // считается отдельно — noteInjection в точках диспатча/ETA (T92).
            if (!seenInjected.has(sessionID)) {
              seenInjected.add(sessionID)
              console.log(`[dev-console] stage2: state injected into session ${sessionID}`)
            }
            // Вкладка видна: зафиксировать наблюдение (title/model/last_seen).
            // После баннера — упавшая запись не должна отменить инжект.
            try {
              upsertTab(ledger, {
                session_id: sessionID,
                title: info?.title ?? null,
                model: shortModel(info?.model),
                last_seen: new Date().toISOString(),
              })
              save(ledger)
            } catch (e) {
              console.error("[dev-console] tab record:", e)
            }
            // T64: титул инстанса = персона + сюжет (наблюдение = повод вернуть
            // имя, если авто-титул OpenCode перетёр «Маруську Гольденштерн»)
            void ensurePersonaTitle(sessionID, info?.title)
          } catch (e) {
            console.error("[dev-console] inject:", e)
          }
        })
        diag.session_hook = true
      } catch (e) {
        console.error("[dev-console] stage2 context hook registration failed:", e)
      }
    }
    // ------------------------------------------- Stage 2: event lifecycle ----
    // The child session's events are the only truthful source for background
    // agents (session.wait resolves immediately even for a queued session).
    const eventApi = (ctx as unknown as {
      event?: { subscribe?: (o: { signal: AbortSignal }) => AsyncIterable<unknown> }
    }).event
    const stopEvents = new AbortController()
    if (typeof eventApi?.subscribe === "function") {
      try {
        void (async () => {
          type ServerEvent = {
            type?: string
            created?: number
            time?: number
            durable?: { aggregateID?: string }
            data?: {
              sessionID?: string
              name?: unknown
              id?: unknown
              text?: unknown
              input?: unknown
              part?: unknown
              cost?: unknown
              tokens?: unknown
              item?: { payload?: { text?: string; metadata?: { childID?: string } } }
              [key: string]: unknown
            }
          }
          const toolTarget = (value: unknown): string | null => {
            if (!value || typeof value !== "object") return null
            const record = value as Record<string, unknown>
            for (const key of ["filePath", "path", "file", "url", "uri", "resource", "command", "cmd", "description", "prompt", "search", "query", "pattern", "glob", "directory", "target"]) {
              const candidate = record[key]
              if (typeof candidate === "string" && candidate.trim() !== "") return candidate.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").slice(0, 80)
            }
            return null
          }
          const observeTool = (subject: string, name: unknown, input: unknown, callId: unknown, at: string): void => {
            if (typeof name !== "string" || name.trim() === "") return
            const ledger = loadLedger(stateFile)
            if (noteAgentTool(ledger, subject, name, toolTarget(input), at, typeof callId === "string" ? callId : null)) {
              diag.agent_tool_events += 1
              void save(ledger)
            }
          }
          let retryMs = 1_000
          while (!stopEvents.signal.aborted) {
            try {
              diag.event_stream = true
              for await (const raw of eventApi.subscribe!({ signal: stopEvents.signal })) {
                const e = raw as ServerEvent
                const type = e.type ?? ""
                const subject = e.durable?.aggregateID ?? e.data?.sessionID ?? null
                diag.event_stream = true
                diag.event_last_at = new Date().toISOString()
                diag.event_last_error = null
                retryMs = 1_000
            // T52: свежесть последнего события сессии (ЛЮБОГО, не только succeeded)
            // — именно она делает «тишину» terminal-признаком; ход её обновляет.
            if (subject) noteSessionActivity(subject)
            // T118: активное время вкладок копится в памяти (по событию — дёшево,
            // не режем: любой ход/tool-вызов = работа инстанса), сбрасывается в
            // леджер на поллинге /diff (durable). Пауза >EFF_GAP_MS делит
            // интервалы; записи не-вкладок (исполнители) выбрасываются при сбросе.
            if (subject) {
              const at = Date.now()
              const acc = effActivityAcc.get(subject) ?? { ms: 0, since: at, last: at }
              if (at - acc.last <= EFF_GAP_MS) acc.ms += at - acc.last
              acc.last = at
              effActivityAcc.set(subject, acc)
            }
            // T240: live per-agent telemetry. OpenCode emits input.started(name),
            // input.ended(text), tool.called(input), and absolute usage.updated(cost,tokens).
            // /api/session polling is the reconnect/catch-up snapshot; usage snapshots replace, never sum.
            if (subject && type === "message.part.updated") {
              // OpenCode V1 projected transcript event: tool part carries tool/callID/state.input.
              const d = (e.data ?? {}) as Record<string, unknown>
              const part = d.part && typeof d.part === "object" ? d.part as Record<string, unknown> : {}
              const state = part.state && typeof part.state === "object" ? part.state as Record<string, unknown> : {}
              const input = state.input && typeof state.input === "object" ? state.input : null
              const stateTime = state.time && typeof state.time === "object" ? state.time as Record<string, unknown> : {}
              const partTime = part.time && typeof part.time === "object" ? part.time as Record<string, unknown> : {}
              const stamp = typeof stateTime.start === "number" ? stateTime.start : typeof partTime.ran === "number" ? partTime.ran : typeof partTime.start === "number" ? partTime.start : typeof e.time === "number" ? e.time : typeof e.created === "number" ? e.created : Date.now()
              const toolName = typeof part.tool === "string" ? part.tool : part.name
              const toolInput = input ?? (part.input && typeof part.input === "object" ? part.input : null)
              const callId = typeof part.callID === "string" ? part.callID : part.id
              if (part.type === "tool") observeTool(subject, toolName, toolInput, callId, new Date(stamp).toISOString())
            } else if (subject && (type === "session.tool.input.started" || type === "session.tool.called")) {
              const d = (e.data ?? {}) as Record<string, unknown>
              const input = d.input && typeof d.input === "object" ? d.input as Record<string, unknown> : {}
              const name = typeof d.name === "string" ? d.name : typeof input.tool === "string" ? input.tool : null
              observeTool(subject, name, input, d.id, typeof e.created === "number" ? new Date(e.created).toISOString() : new Date().toISOString())
            } else if (subject && type === "session.tool.input.ended") {
              const d = (e.data ?? {}) as Record<string, unknown>
              const rawInput = typeof d.text === "string" ? d.text : ""
              let parsed: Record<string, unknown> = {}
              try { const value = JSON.parse(rawInput); if (value && typeof value === "object") parsed = value as Record<string, unknown> } catch { /* malformed tool input is not fatal */ }
              const target = toolTarget(parsed)
              const ledger = loadLedger(stateFile)
              const agent = ledger.agents.find((a) => a.session_ref === subject && (a.state === "running" || a.state === "waiting"))
              const callId = typeof d.id === "string" ? d.id : null
              if (agent?.last_tool && (!callId || !agent.last_tool.call_id || agent.last_tool.call_id === callId)) {
                agent.last_tool.target = target ? target.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").slice(0, 80) : agent.last_tool.target
                agent.last_tool.updated_at = typeof e.created === "number" ? new Date(e.created).toISOString() : new Date().toISOString()
                void save(ledger)
              }
            } else if (subject && type === "message.updated") {
              // Count unique completed assistant messages as model turns, not tool calls or provider retries.
              const d = (e.data ?? {}) as Record<string, unknown>
              const info = d.info && typeof d.info === "object" ? d.info as Record<string, unknown> : {}
              const time = info.time && typeof info.time === "object" ? info.time as Record<string, unknown> : {}
              if (info.role === "assistant" && typeof info.id === "string" && typeof time.completed === "number") {
                const ledger = loadLedger(stateFile)
                if (noteAgentRequest(ledger, subject, info.id)) {
                  diag.agent_requests += 1
                  void save(ledger)
                }
              }
            } else if (subject && type === "session.step.ended") {
              // V2 step boundary carries assistantMessageID. Deduped with message.updated.
              const d = (e.data ?? {}) as Record<string, unknown>
              const messageId = typeof d.assistantMessageID === "string" ? d.assistantMessageID : typeof d.assistantMessageId === "string" ? d.assistantMessageId : null
              if (messageId) {
                const ledger = loadLedger(stateFile)
                if (noteAgentRequest(ledger, subject, messageId)) {
                  diag.agent_requests += 1
                  void save(ledger)
                }
              }
            } else if (subject && type === "session.usage.updated") {
              const ledger = loadLedger(stateFile)
              const usageAt = typeof e.time === "number" ? e.time : typeof e.created === "number" ? e.created : Date.now()
              if (noteAgentUsage(ledger, subject, e.data, new Date(usageAt).toISOString(), "usage-event")) {
                diag.agent_usage_events += 1
                void save(ledger)
              }
            }
            // T97(в): tool-вызов в этом ходу — ход считается не-пустым.
            if (type === "session.tool.called" && subject) turnHadTool.set(subject, true)
            // T80: trigger repo speed measurement on relevant events
            // (step ended with files, tool called with edit/write, etc.)
            if (
              type === "session.step.ended" ||
              (type === "session.tool.called" &&
                e.data?.input &&
                typeof e.data.input === "object" &&
                ("path" in e.data.input || "file" in e.data.input) &&
                (e.data.input as Record<string, unknown>).tool !== "read")
            ) {
              // T80: этот же фильтр = событие пиши-инструмента → счётчик эдитов
              // (ветка tool.called; step.ended не считается).
              if (type === "session.tool.called") repoEditEvents += 1
              void maybeMeasureRepoSpeed()
            }
            // T81: collect per-instance edit events for instance speed calculation.
            // Sources per §4.1: session.tool.called (edit/write with path/file) and
            // session.step.ended.files[] (unique sessionID|file per step).
            // T41/T93: durable counters incremented directly on Agent record (persisted in ledger).
            if (type === "session.tool.called" &&
                e.data?.input &&
                typeof e.data.input === "object" &&
                ("path" in e.data.input || "file" in e.data.input) &&
                (e.data.input as Record<string, unknown>).tool !== "read" &&
                subject) {
              const file = (e.data.input as Record<string, unknown>).path ??
                           (e.data.input as Record<string, unknown>).file
              if (typeof file === "string") {
                instanceEditEvents.push({ sessionId: subject, file, at: Date.now() })
                // T41/T93: increment durable edit_count on agent record
                const ledger = loadLedger(stateFile)
                const agent = ledger.agents.find((a) => a.session_ref === subject)
                if (agent) {
                  agent.edit_count = (agent.edit_count ?? 0) + 1
                  save(ledger)
                }
              }
            } else if (type === "session.step.ended" &&
                       e.data?.files &&
                       Array.isArray(e.data.files) &&
                       subject) {
              for (const file of e.data.files) {
                if (typeof file === "string") {
                  instanceEditEvents.push({ sessionId: subject, file, at: Date.now() })
                  // T41/T93: increment durable edit_count on agent record
                  const ledger = loadLedger(stateFile)
                  const agent = ledger.agents.find((a) => a.session_ref === subject)
                  if (agent) {
                    agent.edit_count = (agent.edit_count ?? 0) + 1
                    save(ledger)
                  }
                }
              }
            }
            if (type === "session.execution.succeeded") {
              // T52: succeeded шины = конец хода модели, а не сессии (живой
              // образец: после каждого хода). Закрытие — только terminal-проверкой.
              // T97(в): граница хода = счётчик пустых первых сообщений.
              if (subject) noteOrientation(subject)
              if (subject) settleTurn(subject, `session.execution.succeeded — ход, не конец (T52)`)
            } else if (/^session\.execution\..*(failed|errored|aborted|cancelled|canceled)$/.test(type)) {
              if (subject) settleBySession(subject, "failed")
            } else if (type === "session.inbox.enqueued") {
              // Failure belt: the parent's subagent notification carries childID + state.
              const payload = e.data?.item?.payload
              const child = payload?.metadata?.childID
              const state = payload?.text ? /state="(completed|failed|aborted)"/.exec(payload.text)?.[1] : undefined
              if (child && state) {
                noteSessionActivity(child)
                if (state === "completed") {
                  noteOrientation(child) // T97(в): граница хода и здесь
                  settleTurn(child, `inbox state="completed" — ход, не конец (T52)`)
                } else settleBySession(child, "failed")
              }
            } else if (INCIDENT.test(type)) {
              // Общий инцидент (упавший сервер/workspace и т.п.): сессии-владельца
              // нет. T177: broadcast synthetic (реальный ход модели на всех
              // простаивающих) → лог; событие видно в маркерах панели и get_state.
              console.log(
                `[dev-console] incident: ${type} — общий сбой рантайма/репо (не привязан к вкладке).`,
              )
            }
              }
              if (!stopEvents.signal.aborted) throw new Error("event stream ended")
            } catch (e) {
              if (stopEvents.signal.aborted) break
              diag.event_stream = false
              diag.event_errors += 1
              diag.event_last_error = String(e).slice(0, 240)
              console.error("[dev-console] event stream disconnected; retrying:", e)
              await new Promise((resolve) => setTimeout(resolve, retryMs))
              if (stopEvents.signal.aborted) break
              diag.event_reconnects += 1
              retryMs = Math.min(retryMs * 2, 15_000)
            }
          }
        })().catch((e) => console.error("[dev-console] stage2 event supervisor:", e))
        diag.event_stream = true
      } catch (e) {
        console.error("[dev-console] stage2 event subscribe failed:", e)
      }
    }

    // Stale running agents (a previous load died mid-run): the stream above
    // settles them if their session is still alive; probe the newest shape.
    try {
      const stale = loadLedger(stateFile).agents.filter(
        (a) => a.state === "running" && a.session_ref?.startsWith("ses_"),
      )
      const newest = stale[stale.length - 1]
      if (newest && typeof sessionHooks.get === "function") {
        void sessionHooks
          .get!({ sessionID: newest.session_ref! })
          .then((info) => {
            diag.session_probe = JSON.stringify(info).slice(0, 600)
          })
          .catch((e) => {
            diag.session_probe = `error: ${String(e)}`
          })
      }
    } catch (e) {
      console.error("[dev-console] stage2 stale probe:", e)
    }

    // ETA survives restarts: re-arm the plan for everything still running —
    // an already-overdue agent fires immediately (self-report right on boot).
    try {
      const running = loadLedger(stateFile).agents.filter((a) => a.state === "running" || a.state === "waiting")
      running.forEach(scheduleEta)
      if (running.length > 0) console.log(`[dev-console] eta: re-armed ${running.length} running`)
    } catch (e) {
      console.error("[dev-console] eta re-arm:", e)
    }

    // Live probe (T53): DEVATA/wake_probe.txt → broadcast через штатный wake()
    // ВСЕМ top-вкладкам репо; файл потребляется при чтении и не стреляет повторно.
    // Каждая непустая строка = одно событие: две одинаковые строки в маркере дают
    // два wake() с одним ключом, и вторая глушится дедупом — живое доказательство
    // «одно событие = одно пробуждение» (результат: ровно одна копия на вкладку).
    try {
      const probeFile = join(root, "DEVATA", "wake_probe.txt")
      if (existsSync(probeFile)) {
        const raw = readFileSync(probeFile, "utf8")
        rmSync(probeFile, { force: true }) // потреблён сразу: событие один раз, ошибки — в лог
        for (const line of raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
          wake(`probe:${line}`, "broadcast", `DEV CONSOLE wake probe (T53): ${line}`)
        }
      }
    } catch (e) {
      console.error("[dev-console] wake probe:", e)
    }

    // Живой probe (T46): DEVATA/settle_probe.txt → симуляция события завершения
    // сессии без доступа к шине событий. Строка = "<session_ref> [completed|failed]"
    // (статус по умолчанию failed); файл потребляется при чтении, как wake_probe.
    // Только точный матч по session_ref: проба не имеет права закрыть чужого агента.
    const settleProbeFile = join(root, "DEVATA", "settle_probe.txt")
    const consumeSettleProbe = (): void => {
      try {
        if (!existsSync(settleProbeFile)) return
        const raw = readFileSync(settleProbeFile, "utf8")
        rmSync(settleProbeFile, { force: true }) // потреблён сразу: событие один раз
        for (const line of raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
          const [ref, rawStatus] = line.split(/\s+/)
          const status: "completed" | "failed" = rawStatus === "completed" ? "completed" : "failed"
          if (!ref) continue
          const ledger = loadLedger(stateFile)
          if (!ledger.agents.some((a) => a.session_ref === ref)) {
            console.log(`[dev-console] settle probe: no agent on ${ref} — skipped`)
            continue
          }
          const agent = settleEvent(ledger, status, ref, `probe (симуляция T46): session.execution.${status}`)
          if (!agent) continue
          save(ledger)
          diag.settle_probe += 1
          console.log(`[dev-console] settle probe: ${agent.id} → ${agent.state} (probe)`)
          if (status === "failed") {
            if (agent.task_id) wakeAgentError(agent.task_id, agent.id, `СИМУЛЯЦИЯ probe T46: session.execution.${status}`)
          } else if (agent.task_id && dispatchedSessions.has(ref)) {
            wakeOrchestrator(agent.task_id, agent.id, ref, status)
          }
        }
      } catch (e) {
        console.error("[dev-console] settle probe:", e)
      }
    }
    consumeSettleProbe() // и сразу на загрузке: файл мог ждать перезапуска рантайма

    // T136-АВТО-ПОДХВАТ (заказ Основателя 11.11, дословно: «Должны агенты
    // работать постоянно»). Почему 13 дней тишины: диспатч запускался ТОЛЬКО
    // человеком через DOING+owner — очередь стояла, пока оркестратор молчал.
    // Теперь: очередь пуста (нет running/waiting) → берём СТАРЕЙШУЮ WAIT-задачу
    // и отдаём диспатчу. Гарантии: по одной за тик (90с), все гейты dispatch
    // живут (CPU T95, write-exclusive T47, retry-cap T132); не вышло (skipped/
    // failed) → задача ЧЕСТНО возвращается в WAIT. Конфликтные кандидаты (в
    // тексте упомянут dev-код/регион) авто-подхватом НЕ трогаются — их отдаёт
    // оркестратор вручную, когда регион свободен.
    // T150-хвост (11.11, дефект фильтра): голые слова «index»/«state» отсекали
    // ВСЮ очередь (даже «state.json» = файл леджера, не код). Сужаем: защита
    // срабатывает только на реальные ссылки на dev-файлы/каталог.
    const AUTO_PULL_MS = 90_000
    const AUTO_PULL_PROTECTED = /(?:[\w./\\-]*\.ts\b|DEV_CONSOLE|регион)/i
    let autoPullAt = 0
    const autoPullOnce = async (): Promise<void> => {
      try {
        const l = loadLedger(stateFile)
        if (l.agents.some((a) => a.state === "running" || a.state === "waiting")) return
        // ПРЕДОХРАНИТЕЛЬ (11.11): эндпоинт/квота лежат → каждый подхват = мёртвый
        // ребёнок (A160-A165: «session.execution.failed · пустой хвост»). Чистый
        // детерминизм: ≥3 падения за 15 минут → автоподхват молчит, пока окно не
        // очистится. Ручной dispatch не блокируется — это воля оркестратора.
        const stormCut = Date.now() - 15 * 60_000
        const recentFails = l.agents.filter(
          (a) => a.state === "failed" && Date.parse(a.updated_at) >= stormCut,
        ).length
        if (recentFails >= 3) {
          console.log(`[dev-console] auto-pull: пауза — ${recentFails} падений за 15м (эндпоинт/квота), не плодим мёртвых детей`)
          return
        }
        const g = cpuGate()
        if (!g.allow || g.defer) return
        // ГВАРД ДВОЙНОЙ РАБОТЫ (инцидент 16.11 «субагенты, о которых голова не
        // знает»): владелец-вкладка задачи активна (last_seen < 10м) — она УЖЕ
        // работает над задачей инлайном (Мара закоммитила T162 в 21:48, а
        // призрак-ребёнок A100 автоподхвата ещё полчаса «работал» на то же).
        // Не спавним: работа принадлежит живой голове; если вкладка остынет —
        // очередь подхватит на следующем тике. Механика, не договорённость.
        const OWNER_ACTIVE_MS = 10 * 60_000
        const nowMs = Date.now()
        const candidate = [...l.tasks]
          .filter((t) => t.state === "WAIT")
          .filter((t) => !t.agent_error)
          .filter((t) => !AUTO_PULL_PROTECTED.test(t.task ?? ""))
          .filter((t) => {
            if (!t.session_ref) return true
            const tab = l.tabs.find((x) => x.session_id === t.session_ref)
            if (!tab?.last_seen) return true
            const fresh = nowMs - Date.parse(tab.last_seen)
            if (fresh < OWNER_ACTIVE_MS) {
              console.log(
                `[dev-console] auto-pull: ${t.id} — владелец активен (${Math.max(0, Math.round(fresh / 60_000))} мин назад), не спавню ребёнка (гвард двойной работы)`,
              )
              return false
            }
            return true
          })
          .sort((a, b) => (Date.parse(a.updated_at) || 0) - (Date.parse(b.updated_at) || 0))[0]
        if (!candidate) return
        const owner = candidate.owner === "research" || candidate.owner === "qc" ? candidate.owner : "dev"
        const res = applyOp(loadLedger(stateFile), { op: "set_state", id: candidate.id, state: "DOING", owner })
        if (!res.ok) {
          console.log(`[dev-console] auto-pull: ${candidate.id} не взят — ${res.error}`)
          return
        }
        await save(res.ledger)
        const d = await dispatch(res.task)
        if (d.status !== "spawned") {
          const back = loadLedger(stateFile)
          const undo = applyOp(back, { op: "set_state", id: candidate.id, state: "WAIT" })
          if (undo.ok) await save(undo.ledger)
          console.log(`[dev-console] auto-pull: ${candidate.id} → WAIT обратно (${d.status === "skipped" ? d.reason : d.error})`)
          return
        }
        console.log(`[dev-console] auto-pull: ${candidate.id} → ${d.agent} (${d.session_id})`)
        // T160 (15.11): wake здесь УБРАН. Было: broadcast «очередь не стоит» всем
        // top-вкладкам — synthetic-промпт = реальный ход модели на КАЖДОЙ
        // простаивающей инстансе (токены) → блинк в active → грейс T158 показывала
        // «работает» на спящих → через 60с «потухли» (жалоба Основателя). Ребёнок
        // и так виден в панели, о результате скажет settle-буждение. Канон T53:
        // шумовые буждения запрещены.
      } catch (e) {
        console.error("[dev-console] auto-pull:", e)
      }
    }

    // T94-СЕРВЕРЫ-ТАСКОВ (заказ 11.11: «У нас не работают сервера тасков»).
    // ПРОТОКОЛ ЧЕРЕЗ ФАЙЛ — как wake_probe/settle_probe: задача пишет
    // DEVATA/server_request.json {path, kind, owner, cmd?, cwd?, port?}, консоль
    // на тике решает ДЕТЕРМИНИРОВАННО (reuse / spawn / queue) и пишет ответ в
    // DEVATA/server_response.json. Никакой ИИ-логики: чистые функции
    // parseServerRequest + decideServerRequest (state.ts) + ServerGuard.
    const SERVER_REQUEST_FILE = "server_request.json"
    const SERVER_RESPONSE_FILE = "server_response.json"
    let serverReqAt = 0
    const SERVER_REQ_POLL_MS = 2_000
    const handleServerRequest = (): void => {
      try {
        const reqFile = join(root, "DEVATA", SERVER_REQUEST_FILE)
        if (!existsSync(reqFile)) return
        const raw = readFileSync(reqFile, "utf8")
        const req = parseServerRequest(raw)
        rmSync(reqFile, { force: true }) // запрос одноразовый — читаем и сразу убираем
        if (!req) {
          console.log("[dev-console] server-request: мусор в запросе — проигнорирован")
          return
        }
        const live = serverGuard.liveIn(req.path, req.kind)
        const reserved = serverGuard.reservedIn(req.path, req.kind)
        const waiters = serverGuard.waitersFor(req.path, req.kind)
        const decision = decideServerRequest(req, live, reserved, waiters)
        const respond = (payload: Record<string, unknown>): void => {
          try {
            writeFileSync(
              join(root, "DEVATA", SERVER_RESPONSE_FILE),
              JSON.stringify({ ...payload, path: req.path, kind: req.kind, owner: req.owner }, null, 2),
              "utf8",
            )
          } catch (e) {
            console.error("[dev-console] server-response write:", e)
          }
        }
        if (decision.action === "reuse") {
          console.log(`[dev-console] server-request: REUSE ${req.kind} ${req.path} → port=${decision.port}`)
          respond({ ok: true, action: "reuse", port: decision.port, pid: decision.pid })
          return
        }
        if (decision.action === "queue") {
          const pos = serverGuard.enqueue(req.path, req.kind, req.owner)
          console.log(`[dev-console] server-request: QUEUE ${req.kind} ${req.path} — ${req.owner} #${pos}`)
          respond({ ok: true, action: "queued", position: pos })
          return
        }
        // spawn: сервера ещё нет — поднимаем команду задачи (детерминированно).
        const cmd = req.cmd
        if (!cmd) {
          console.log(`[dev-console] server-request: нет cmd для ${req.kind} ${req.path} — отказ`)
          respond({ ok: false, action: "refused", error: "нет команды запуска (cmd)" })
          return
        }
        const child = spawnDetached(cmd, req.cwd ?? req.path)
        if (!child) {
          respond({ ok: false, action: "failed", error: "не удалось запустить процесс" })
          return
        }
        console.log(`[dev-console] server-request: SPAWN ${req.kind} ${req.path} pid=${child.pid} cmd=${cmd}`)
        serverGuard.register(req.path, req.kind, child.pid, req.port ?? 0, req.owner)
        respond({ ok: true, action: "spawned", pid: child.pid, port: req.port ?? null })
      } catch (e) {
        console.error("[dev-console] server-request:", e)
      }
    }

    // T136: авто-разблокировка — BLOCKED с истёкшим retry_at → WAIT, будим владельца.
    // Ритм = тот же 90с, что и авто-подхват; парный гейт: авто-подхват не потянет
    // задачу, пока таймер не истек (фильтр retry_at в кандидате не нужен — разблок
    // уже вернула в WAIT, а повторный вход в БЛОК Möglich только рукой orchestrators).
    const UNBLOCK_MS = 90_000
    let unblockAt = 0
    const unblockDueOnce = async (): Promise<void> => {
      try {
        const l = loadLedger(stateFile)
        const now = Date.now()
        let touched = 0
        for (const t of l.tasks) {
          if (t.state !== "BLOCKED" || !t.retry_at) continue
          if (Date.parse(t.retry_at) > now) continue
          const res = applyOp(l, { op: "set_state", id: t.id, state: "WAIT" })
          if (!res.ok) continue
          touched += 1
        }
        if (!touched) return
        await save(l)
        for (const t of l.tasks) {
          if (t.state === "WAIT" && t.owner && (t.retry_attempts ?? 0) > 0 && !t.retry_at) {
            // T136 + T177: будим ТОЛЬКО владельца задачи (tab), не всех —
            // действие нужно одному, broadcast гасил/зажигал весь ряд.
            void wake(
              `unblock:${t.id}`,
              "tab",
              `DEV CONSOLE T136: блокировка снята — ${t.id} снова WAIT (таймер истёк). Владельцу: бери, если регион свободен.`,
              t.id,
            )
          }
        }
      } catch (e) {
        console.error("[dev-console] unblock-due:", e)
      }
    }

    // T119 · РИТУАЛ «ПАПА, А МЫ…» — ВРЕЗКА В РАНТАЙМ (11.11).
    // Модуль ritual.ts был написан и покрыт тестами, но НИ РАЗУ не вызывался:
    // (1) ТРИГГЕР — ночное окно + «волна закрыта»; (2) ПОСТ в ленту
    // (DEVATA/AGENT_CHAT.md) — renderPapaPost; (3) ГАРД выбора моделей —
    // decideModels решает, какие модели здоровы, и по��-проверяет выбор диспатча.
    // Всё детерминированно: окна по времени, «волна закрыта» = все живые агенты
    // завершились и с прошлого раза был хотя бы один завершённый.
    const RITUAL_STATE_FILE = "ritual_state.json"
    const RITUAL_TICK_MS = 5 * 60_000
    interface RitualState {
      lastNightly: number // когда последний ночной пост
      lastWavePost: number // когда последний пост «после волны»
      waveStart: number // начало текущей волны (первый агент после прошлого поста)
      seenCompleted: number // завершённых агентов, учтённых в последнем посте
    }
    const ritualStatePath = (): string => join(root, "DEVATA", RITUAL_STATE_FILE)
    const loadRitualState = (): RitualState => {
      const def: RitualState = { lastNightly: 0, lastWavePost: 0, waveStart: 0, seenCompleted: 0 }
      try {
        const p = ritualStatePath()
        if (!existsSync(p)) return def
        const raw = readFileSync(p, "utf8").trim()
        if (!raw) return def
        return { ...def, ...(JSON.parse(raw) as Partial<RitualState>) }
      } catch {
        return def
      }
    }
    const saveRitualState = (st: RitualState): void => {
      try {
        writeFileSync(ritualStatePath(), JSON.stringify(st, null, 2), "utf8")
      } catch (e) {
        console.error("[dev-console] ritual state save:", e)
      }
    }
    // МЕЖПРОЕКТНЫЙ СОВЕТ (T116/T119): леджеры соседних репо — читаем ТОЛЬКО.
    const councilNeighbours = (): CouncilEntry[] => {
      const out: CouncilEntry[] = []
      const candidates = ["J:\\KABALOT\\ARTHUR", "J:\\KABALOT\\N00sphere", "J:\\KABALOT\\N00sphere-build"]
      for (const dir of candidates) {
        const file = join(dir, "DEVATA", "state.json")
        try {
          if (!existsSync(file)) continue
          out.push({ project: basename(dir), ledger: loadLedger(file) })
        } catch (e) {
          console.error("[dev-console] ritual council read:", dir, String(e).slice(0, 120))
        }
      }
      return out
    }
    const postPapa = (w: RitualWindow): void => {
      const ledger = loadLedger(stateFile)
      const report = collectInstanceReport(ledger, w)
      const council = councilReports([{ project: basename(root), ledger }, ...councilNeighbours()], w)
      const healthy = POLICY_MODELS
      const board = collectBoard(ledger, w.to, healthy)
      const decision = decideModels(ledger, w.to, healthy)
      const post = renderPapaPost({ window: w, report, council, board, decision, project: basename(root) })
      try {
        appendFileSync(join(root, "DEVATA", "AGENT_CHAT.md"), `\n${post}\n`, "utf8")
        console.log(`[dev-console] T119 ritual (${w.kind}): пост в ленту, ${post.split("\n").length} строк`)
        // T177: synthetic-broadcast → лог. Пост уже в ленте (DEVATA/AGENT_CHAT.md),
        // T52-inbox донесёт его на естественных ходах — ход модели на всех
        // простаивающих вкладках не нужен (канон T53).
        console.log(`[dev-console] T119 ритуал «папа, а мы…» (${w.kind === "nightly" ? "ночной фикс" : "после волны"}): отчёт в ленте.`)
      } catch (e) {
        console.error("[dev-console] ritual post:", e)
      }
    }
    let ritualAt = 0
    // T119: файловый триггер ритуала (по требованию Основателя 29.10: слово
    // «спринт»/«дэйли» → ритуал САМ; плюс ручная проба без ИИ). Файл:
    // DEVATA/ritual_request.json { window?: "nightly"|"wave", project?: string }.
    const RITUAL_REQUEST_FILE = "ritual_request.json"
    const handleRitualRequest = (): void => {
      const f = join(root, "DEVATA", RITUAL_REQUEST_FILE)
      if (!existsSync(f)) return
      try {
        const raw = readFileSync(f, "utf8")
        rmSync(f, { force: true })
        let kind: "nightly" | "post-wave" = "nightly"
        try {
          const parsed = JSON.parse(raw) as { window?: string }
          if (parsed.window === "wave" || parsed.window === "post-wave") kind = "post-wave"
        } catch {
          /* пустой/мусорный запрос → ночное окно по умолчанию */
        }
        const now = Date.now()
        const st = loadRitualState()
        const w: RitualWindow =
          kind === "post-wave"
            ? waveWindow(now, st.waveStart > 0 ? st.waveStart : now - 3600_000)
            : nightlyWindow(now)
        postPapa(w)
        st.lastNightly = now
        st.lastWavePost = now
        st.waveStart = 0
        saveRitualState(st)
        console.log(`[dev-console] T119 ritual: файловый запрос отработал (${kind})`)
      } catch (e) {
        console.error("[dev-console] ritual request:", e)
      }
    }
    const ritualTick = (): void => {
      try {
        const now = Date.now()
        const st = loadRitualState()
        const ledger = loadLedger(stateFile)
        const live = ledger.agents.filter((a) => a.state === "running" || a.state === "waiting").length
        const completed = ledger.agents.filter(
          (a) => (a.state === "completed" || a.state === "failed") && Date.parse(a.updated_at || "") > st.lastWavePost,
        ).length
        // «волна закрыта»: живых нет, а с прошлого поста что-то завершилось
        const waveClosed = live === 0 && completed > 0 && st.waveStart > 0
        // ночное окно: сутки с прошлого ночного поста
        const nightlyDue = now - st.lastNightly >= NIGHTLY_MS
        if (waveClosed) {
          const w = waveWindow(now, st.waveStart)
          postPapa(w)
          st.lastWavePost = now
          st.waveStart = 0
          st.seenCompleted = completed
          if (nightlyDue) st.lastNightly = now
          saveRitualState(st)
          return
        }
        if (live > 0 && st.waveStart === 0) {
          st.waveStart = now
          saveRitualState(st)
        }
        if (nightlyDue) {
          postPapa(nightlyWindow(now))
          st.lastNightly = now
          st.lastWavePost = now
          st.waveStart = 0
          st.seenCompleted = completed
          saveRitualState(st)
        }
      } catch (e) {
        console.error("[dev-console] ritual tick:", e)
      }
    }
    // T119-ГАРД ВЫБОРА МОДЕЛЕЙ: решение ритуала (decideModels) ПОСТ-ПРОВЕРЯЕТ
    // выбор диспатча — карантинная модель заменяется здоровой. Логика — чистая
    // функция guardModel (ritual.ts, покрыта тестами); здесь только кэш решения.
    let ritualDecisionCache: { at: number; decision: ReturnType<typeof decideModels> } | null = null
    const ritualGuard = (
      ledger: ReturnType<typeof loadLedger>,
      cls: "dev" | "research" | "qc",
      picked: string,
    ): string => {
      const now = Date.now()
      if (!ritualDecisionCache || now - ritualDecisionCache.at > RITUAL_TICK_MS) {
        ritualDecisionCache = { at: now, decision: decideModels(ledger, now, POLICY_MODELS) }
      }
      const outcome = guardModel(ritualDecisionCache.decision, cls, picked)
      if (outcome.applied) {
        console.log(
          `[dev-console] T119 ritual-guard (${RITUAL_ID}): ${outcome.why} (класс ${cls})`,
        )
      }
      return outcome.model
    }

    // Фоновый опрос active-списка (T73): строки вкладок на панели живут и без
    // записей в леджер (сама панель перечитывается каждые 2с), поэтому свежий
    // /api/session/active нужен и в паузах между событиями. Ритм = ACTIVE_POLL_MS,
    // каждый проб держит ACTIVE_GAP_MS (не чаще 1 раза/сек), перерисовка — только
    // при смене списка. Таймеры модели ни при чём: это фон опроса рантайма.
    const activeTimer = setInterval(() => {
      if (Date.now() - activeAt >= ACTIVE_POLL_MS) void refreshActive()
      consumeSettleProbe()
      // T94-серверы-тасков: файловый запрос сервера (reuse/spawn/queue).
      if (Date.now() - serverReqAt >= SERVER_REQ_POLL_MS) {
        serverReqAt = Date.now()
        handleServerRequest()
      }
      // T52: terminal-скан живёт рядом с пробой active — уход из active виден
      // только здесь (событийной дороги нет). Ритм спокойный: 5с достаточно,
      // порог тишины измеряется минутами.
      if (Date.now() - settleScanAt >= SETTLE_SCAN_MS) {
        settleScanAt = Date.now()
        scanTerminalSettles()
      }
      // T68: авто-мигание простаивающих — свой ритм, рядом с terminal-сканом.
      // Ждём только первого пробы active (activeAt): пока проба не отработала,
      // статус решался бы эвристикой на тёплом старте и мигание могло бы
      // включиться/погаснуть вхолостую. activeIds === null после неё — это уже
      // честный ответ «API молчит», его же видит панель.
      if (activeAt > 0 && Date.now() - blinkScanAt >= BLINK_SCAN_MS) {
        blinkScanAt = Date.now()
        scanAutoBlink()
      }
      // T136: авто-подхват бэклога — очередь не должна стоять в тишине
      // («агенты должны работать постоянно», заказ 11.11). Сам себя гейтит.
      if (Date.now() - autoPullAt >= AUTO_PULL_MS) {
        autoPullAt = Date.now()
        // T140: порт канала сменился (рестарт сервера) → панель обязана получить
        // новый порт, иначе вкладка Основателя вечно видит «канал ✗ недоступен».
        if (channelPort !== lastRenderedPort) {
          console.log(`[dev-console] T140: порт канала ${lastRenderedPort} → ${channelPort}, панель перерендеривается`)
          lastRenderedPort = channelPort
          renderPane(loadLedger(stateFile))
        }
        void autoPullOnce()
        // T117: страховка — тема вкладки обновляется и без смены статуса
        // (агент взял задачу вне консоли, рестарт и т.п.).
        if (Date.now() - activityTitlesAt >= ACTIVITY_TITLES_MS) {
          activityTitlesAt = Date.now()
          void refreshActivityTitles()
        }
      }
      // T119: ритуал «папа, а мы…» — ночное окно + «волна закрыта» (5 мин ритм)
      // + файловый запрос (спринт/дэйли/ручная проба).
      if (Date.now() - ritualAt >= RITUAL_TICK_MS) {
        ritualAt = Date.now()
        ritualTick()
      }
      handleRitualRequest()
      // T136: авто-разблокировка BLOCKED по истечении retry_at
      if (Date.now() - unblockAt >= UNBLOCK_MS) {
        unblockAt = Date.now()
        void unblockDueOnce()
      }
    }, ACTIVE_POLL_MS)

    return () => {
      stopEvents.abort()
      clearInterval(activeTimer) // инстанс выгружен — фоновый опрос active тоже встаёт
      clearInterval(titleSyncTimer) // T91: и периодический рефреш титулов тоже
      clearInterval(feedTimer) // T33: и срез динамического списка вкладок тоже
      // Канал панели (T60): сервер встаёт, мигание гаснет — title вкладок
      // возвращается к ORIGINAL, пока инстанс ещё жив.
      for (const id of [...blinkTimers.keys()]) void stopBlink(id)
      // ServerGuard manages the panel server lifecycle (T94)
      serverGuard.release(root)
      // Инстанс выгружен: его ETA-таймеры не должны будить вкладки —
      // иначе каждая перезагрузка плагина шлёт копию пробуждения.
      etaTimers.forEach((t) => clearTimeout(t))
      etaTimers.clear()
      overrunTimers.forEach((t) => clearTimeout(t))
      overrunTimers.clear()
      // T58: cleanup chat file watcher
      if (chatWatchTimer) clearTimeout(chatWatchTimer)
      const watcher = (globalThis as any).__chatWatcher
      if (watcher) watcher.close()
    }
  },
})
