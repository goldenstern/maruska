# SOPHIA · PHASE 3 — AGENT OBSERVABILITY

**Проект:** LAVK DEV CONSOLE / Марусек
**Дата:** 17.11.2026
**База:** единый Phase 1 + Phase 2
**Назначение:** сделать прогресс, инструментальную активность и расход каждого дочернего агента наблюдаемыми без отдельной «умной» подсистемы.

## 1. Диагноз

До Phase 3 панель видела:

- дочернюю сессию и её заголовок;
- накопленные diff-счётчики вкладки;
- агрегированный usage родительской сессии;
- исходный плановый ETA агента (`eta_min`).

Но у агента не было безопасного канала самоотчёта. Последовательность реальных действий модели нельзя было восстановить из одного счётчика событий. Дочерний feed уже содержал `session_id`, `cost` и `tokens`, но `parseChildFeed()` раньше не переносил usage в запись конкретного Agent. Инструментальные вызовы существовали в событийном потоке, однако панель не сохраняла last-tool проекцию.

## 2. Контракт `dev_console progress`

Исполнитель может вызвать только специальный op `progress`:

```json
{
  "op": "progress",
  "step": "проверяю цены .codes у 3 регистраторов",
  "done": "3/10",
  "next": "reg.ru API",
  "eta_remaining_min": 7
}
```

Поля:

| Поле | Семантика |
|---|---|
| `step` | обязательный короткий текущий этап, 1–180 символов |
| `done` | компактная контрольная точка, например `3/10`; это самоотчёт, если не привязан к реальным дочерним задачам |
| `next` | следующий конкретный шаг |
| `eta_remaining_min` | субъективная оценка остатка, 0–1440 минут |

**ID агента, задачи и сессии не принимает модель.** Runtime получает `context.sessionID`, находит соответствующую живую запись `Agent` и пишет только её. Исполнитель не получает права `get_state`, `create`, `update`, `set_state` или `model_reset`; единственный разрешённый вызов — `progress`.

Самоотчёт очищается от управляющих символов, ограничивается по длине и проходит базовую redaction токенов/паролей в URL и тексте. Прогресс помечается `source: "self-report"`.

### Плановый ETA и самоотчёт — разные поля

- `eta_min` остаётся первоначальным планом, на котором основана plan/fact статистика.
- `progress.eta_remaining_min` — актуальная оценка остатка от самого агента.
- В UI новая оценка подписана как самоотчёт. После пяти минут без обновления она помечается устаревшей.

Самоотчёт не считается объективно проверенным выполнением. `done/total` — заявление агента до тех пор, пока количество не связано с реально закрытыми дочерними задачами.

## 3. События дочерней сессии

### Инструменты

Поддержаны два семейства событий:

1. `message.part.updated`: поддержаны V1-поля `part.tool`, `part.callID`, `part.state.input` и V2-поля `part.name`, `part.id`, `part.input`; время берётся из `state.time.start`, `part.time.ran`, `part.time.start` или timestamp события.
2. Legacy/runtime tool events `session.tool.input.started`, `session.tool.called`, `session.tool.input.ended`: используются как совместимый fallback; завершение может дополнить target, если раннее событие уже создало запись инструмента.

В записи агента хранится только последняя краткая пара `tool name → target`, а не полный payload вызова. Target выбирается из ограниченного списка типичных полей (`path`, `filePath`, `url`, `command`, `query` и т. п.), ограничивается по длине и очищается от очевидных секретов.

### Reconnect и пропущенные события

Подписка работает под supervisor loop. При обрыве/завершении потока выполняется backoff 1 → 2 → 4 → 8 → 15 секунд. Диагностика содержит число ошибок/переподключений и время последнего события.

Дополнительно раз в 30 секунд (не более восьми дочерних сессий за один проход) выполняется best-effort resync последнего инструмента. Парсер истории принимает оба контейнера transcript: V1 `parts[]` и V2 `content[]`; для V2 tool part использует `name`/`id`/`input` и `time.ran`:

`GET /api/session/{sessionID}/message?limit=8&order=desc`

Запрос ограничен таймаутом 3 секунды, не блокирует основной tab/usage feed. Более старый snapshot не перетирает более свежее живое событие. Отсутствие доступа к истории не ломает панель.

## 4. Per-agent usage и requests

### Usage

- `/api/session` уже опрашивается существующим tab feed; `parseChildFeed()` теперь извлекает для каждой дочерней сессии её `cost` и `tokens`.
- `attachTabChildren()` переносит cumulative snapshot в конкретную запись `Agent` по `session_id`.
- `session.usage.updated` обновляет usage при наличии события.
- Snapshot **заменяет** прошлый cumulative snapshot; он не суммируется повторно.
- В UI расход и токены обозначаются отдельно от агрегированных показателей вкладки.

Хранимые компоненты: `input_tokens`, `output_tokens`, `reasoning_tokens`, `cache_read_tokens`, `cache_write_tokens`, `total_tokens`, `cost_usd`, `updated_at`, `source`.

### Requests

Счётчик `REQ N` увеличивается по уникальному завершённому assistant message (`message.updated`, `info.role === "assistant"`, есть `time.completed`). Последние 64 message ID хранятся для дедупликации повторной доставки события.

`REQ` означает число завершённых assistant message, наблюдавшихся после включения Phase 3. Это **не** число HTTP-запросов к провайдеру, tool calls или гарантированное число внутренних попыток модели. История до установки не backfill-ится. Помимо `message.updated` (V1), V2 `session.step.ended.assistantMessageID` используется как fallback; общий `noteAgentRequest` дедуплицирует оба сигнала по ID.

## 5. Почему не добавлен `DEVATA/agents/A1.progress.json`

Файловый fallback в этом проходе намеренно не добавлен. Он создал бы второе долговременное хранилище текущего прогресса рядом с основным леджером и потребовал бы определить правила конфликтов, очистки, атомарности и авторизации записи. Сначала используется прямой session-bound `dev_console progress`. Если живой smoke test покажет, что этот канал недоступен для конкретного типа исполнителя, файловый transport можно спроектировать отдельной задачей с тем же контрактом, но не как второй источник истины.

## 6. Совместимость данных

Все новые Agent-поля optional: старый `DEVATA/state.json` должен загружаться без миграции. Сохранённые данные Phase 1/2 и legacy Agent records не требуют массовой перезаписи. Новые telemetry fields заполняются только для активных дочерних сессий после обновления.

## 7. Проверки

После совместимости V1/V2 на дату сборки:

- `npm run test`: **340/340**;
- `npm run gate`: **13 runtime-модулей, import-gate OK**;
- `node --experimental-strip-types --check DEV_CONSOLE/index.ts`: OK;
- `node --experimental-strip-types --check DEV_CONSOLE/state.ts`: OK;
- тест T240 покрывает session-bound progress state, неизменность планового ETA, редактирование секретоподобных значений, cumulative usage snapshots, last-tool ordering/dedup, unique assistant-message requests, отображение и save/load.

Ограничения проверки: static `tsc` не запускался — в комплекте нет `@types/node`; Windows/PowerShell и реальная закреплённая OpenCode runtime version в живом процессе не smoke-tested. Плагин не рестартовали, deployment не выполнялся.

## 8. Recovery update — V1/V2 transcript compatibility

После восстановления контрольной точки добавлена совместимость V2: history resync читает `content[]` наряду с `parts[]`; tool part принимает `name`/`id`/`input` и timestamp `time.ran`; live `message.part.updated` использует те же fallback-поля. `session.step.ended.assistantMessageID` засчитывается как завершённый assistant message и дедуплицируется с `message.updated`. Это закрывает форматный разрыв на уровне парсинга, но не заменяет smoke test против фактически закреплённой версии OpenCode.

## 9. Остаточные задачи

- Smoke test событий на конкретной установленной версии OpenCode (в частности `message.part.updated`, `session.usage.updated`, `session.step.ended.assistantMessageID` и форма `durable.aggregateID`).
- Проверить, что все виды исполнителей реально получают tool `dev_console` и могут вызывать op `progress`.
- Проверить отображение нескольких параллельных child sessions.
- Отдельно продолжить T184: реактивность/инвалидация полной проекции панели. Phase 3 даёт observability, но сама по себе не доказывает закрытие T184.
- Следующая архитектурная фаза — разбиение оставшихся монолитов `state.ts` и `index.ts` на модули без изменения контрактов.

---

**Архитектурный принцип:** MINIMUM MODEL · MAXIMUM FRAMEWORK. Модель сообщает маленький факт о текущем шаге; framework привязывает этот факт к сессии, валидирует, сохраняет, дедуплицирует, сопоставляет usage и строит UI.
