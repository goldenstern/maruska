# HANDOFF · МАРУСЬКА · LAVK DEV CONSOLE FULL UPDATE

**Дата:** 17.11.2026
**От:** София, независимый аудит и implementation pass
**Кому:** Маруське / команде фреймворка
**Основание:** исходный `SOFIA_BRIEF.md`, репозиторий пользователя и последующие уточнения по observability.

## 0. Решение

Этот архив — единый комплект изменений Phase 1 + Phase 2 + Phase 3. Рассматривай его как source candidate для контролируемого внедрения, а не как разрешение на автоматический деплой.

**Сначала сверка и staged rollout.** Не копируй приватный runtime из тестовой среды, не пересоздавай пользовательский ledger и не рестартуй OpenCode без явного слова «деплой» Основателя.

## 1. Что включено

### Phase 1 — persistence hardening / первый модульный вынос

- усиление атомарного сохранения леджера и сериализации конкурентных saver'ов;
- выделение `ServerGuard` в отдельный модуль;
- базовые исправления очереди серверных слотов и upstream streak;
- тесты и проверка импортов.

### Phase 2 — ledger integrity

- межпроцессное резервирование `T###` и `A###` через отдельный sidecar;
- baseline-aware merge независимых model counters;
- tombstone-поддержка для схлопывания дублей агентов при rekey;
- тесты конкурентного создания и сохранения.

### Phase 3 — Agent Observability

- безопасный `dev_console op=progress`, привязанный к реальному `context.sessionID`;
- отдельный self-reported remaining ETA, не перезаписывающий plan ETA;
- last tool + краткий target из child event stream;
- reconnect/backoff + best-effort resync истории последних сообщений;
- per-agent tokens/cost из `/api/session` и `session.usage.updated`;
- `REQ N` по уникальным завершённым assistant messages;
- sanitation/redaction для telemetry text.

Главная подробная спецификация Phase 3: `docs/SOPHIA_PHASE3_AGENT_OBSERVABILITY_2026-11-17.md`.

Предыдущие аналитические материалы: `docs/SOPHIA_AUDIT_2026-11-17.md` и `docs/SOPHIA_PHASE2_2026-11-17.md`.

## 2. Важные runtime-файлы — НЕ перезаписывать

В существующем проекте сохранить как есть:

- `DEVATA/state.json`;
- `DEVATA/state.json.bak`;
- `DEVATA/state.json.ids.json` — sidecar резервации ID из Phase 2;
- `DEVATA/panel_channel.json`;
- запечённый/живой `CONSOLE_UI.html` и иные файлы runtime channel;
- OpenCode `service.json`, credentials, auth, env secrets;
- персональные runtime/session state, не входящие в исходники.

Не удалять sidecar ID. Его удаление может привести к повторной выдаче уже занятого ID после восстановления старого ledger.

В архив не включать и из него не восстанавливать приватные runtime-данные или ключи.

## 3. Рекомендуемый порядок внедрения

1. Зафиксировать текущий git HEAD и сделать резервную копию исходников и runtime ledger.
2. Сверить список исходных файлов с архивом. Убедиться, что это именно соответствующая ветка и база Phase 2; не накатывать Phase 3 patch на произвольный старый HEAD.
3. Перенести source/docs/scripts из архива, сохранив runtime-файлы из раздела 2.
4. Установить зависимости штатным способом для текущего проекта.
5. Запустить `npm run check`.
6. Запустить syntax check:

   ```bash
   node --experimental-strip-types --check DEV_CONSOLE/index.ts
   node --experimental-strip-types --check DEV_CONSOLE/state.ts
   ```

7. Проверить существующий ledger: `state.json` читается, старые Agent records отображаются, ID sidecar не заменён и не удалён.
8. На отдельном тестовом исполнителе проверить progress:

   ```json
   {
     "op": "progress",
     "step": "проверяю цены .codes у 3 регистраторов",
     "done": "3/10",
     "next": "reg.ru API",
     "eta_remaining_min": 7
   }
   ```

   В панели должны появиться step, checkpoint, self-reported ETA, timestamp/source marker. Исходный `eta_min` должен остаться прежним.
9. Проверить agent usage: токены и cost отдельного дочернего session должны попасть в его Agent record, а не только в parent tab aggregate.
10. Проверить REQ: завершённый assistant message увеличивает request count ровно один раз; replay не удваивает его.
11. Проверить last tool: вызвать read/search/shell на тестовом агенте и подтвердить отображение имени + безопасно сокращённой цели.
12. Проверить reconnect: искусственно оборвать event transport в тестовой среде; подтвердить retry/backoff и обновление last-tool из message history после восстановления.
13. Только после независимой проверки и явного разрешения Основателя планировать отдельный deploy/restart.

## 4. Ограничения и точная трактовка метрик

- `12/мин` — активная средняя скорость diff вкладки (`добавления + удаления` / накопленное активное время), а не скорость текущей задачи/агента.
- `Δ0.7×` — plan/fact коэффициент по завершённой работе, не живой ETA.
- `+28` — счётчик контекстных инъекций, не токены.
- `progress.eta_remaining_min` — текущая самооценка исполнителя; это не verified ETA.
- `REQ N` — число уникальных завершённых assistant messages после включения Phase 3. Не трактовать как HTTP-запросы к provider или внутренние retry.
- `TOK` и стоимость — cumulative usage конкретной дочерней сессии, не дельта последнего хода.

## 5. Не объявлять решённым

- Живая совместимость event names и event envelope должна быть подтверждена на реально закреплённой версии OpenCode. В исходнике есть поддержка V1 transcript и legacy tool event shapes; архивная проверка не заменяет smoke test в живом процессе.
- `tsc` не был подтверждён: в bundle отсутствует `@types/node`.
- Windows/PowerShell не проверялись в этом проходе.
- Phase 3 не закрывает T184 автоматически: это наблюдаемость агентов, не доказательство полной инвалидации/реактивности N00sphere panel.
- `state.ts` и `index.ts` остаются большими монолитами. Их структурное расщепление — отдельный следующий этап с сохранением контрактов.
- `DEVATA/agents/A1.progress.json` не добавлен намеренно: не вводим второй source of truth до подтверждения, что session-bound progress tool недоступен как transport.

## 6. Acceptance criteria

- `npm run check` — зелёный.
- `import_gate` — без пропущенных импортов.
- Старый runtime ledger загружается без миграции.
- У исполнителя нет write-доступа к произвольным задачам/агентам; только progress собственной session.
- Плановый ETA не меняется при self-report.
- Показатели `12/мин`, `Δ`, инъекции, tokens/cost и REQ подписаны и не смешиваются.
- Per-agent usage маппится по child session ID.
- Повторы событий не удваивают REQ и last-tool snapshots не откатывают более свежие события.
- Отказ event transport не блокирует основной feed и панель.
- Нет удаления/перезаписи пользовательского runtime state.

## 7. Результаты изолированной проверки сборки Софии

- Node test suite: **340 passed / 340 total**.
- Import-gate: **13 modules, OK**.
- Syntax check `index.ts` и `state.ts`: OK.
- Не запускались: static `tsc`, Windows-specific smoke test, live OpenCode runtime smoke test.
- Не выполнялись: deployment, OpenCode restart, изменения живого ledger.

**Порядок принятия:** сначала прочитать этот handoff и Phase 3 spec, затем независимо проверить diff и compatibility; только после этого брать задачи на live rollout.


## Recovery addendum — V1/V2 transcript compatibility

В окончательном recovery-пакете включены дополнительные совместимые парсеры:
- `/api/session/{id}/message` resync читает V1 `parts[]` и V2 `content[]`;
- tool name/input/call ID принимаются из `tool/callID/state.input` или `name/id/input`;
- время вызова понимает `state.time.start`, `part.time.ran`, `part.time.start`;
- live `message.part.updated` использует тот же набор fallback-полей;
- `session.step.ended.assistantMessageID` резервно фиксирует REQ, с дедупликацией по message ID против `message.updated`.

Проверки повторены после этих изменений: 340/340 тестов, import-gate 13/13, syntax-check `index.ts` и `state.ts`. Живой OpenCode smoke test всё ещё обязателен: архив не доказывает форму событий на установленной версии пользователя. Деплой не выполнялся.
