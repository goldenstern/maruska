# LAVK DEVATA — структура проекта

Оркестратор LAVK: понимает новые задачи, ведёт и докладывает статусы через рантайм `dev_console`, работает с Фаундером по гейтам.

```text
pipeline-setup/                     корень (связан со skills-ссылкой)

LAVK DEVATA/                        скилл (политика и мышление)
    SKILL.md                        правила оркестратора
    PIPELINE_PROJECT_TEMPLATE.md    шаблон контекста проекта
    README.md                       этот файл

DEV_CONSOLE/                        рантайм-плагин (источник правды состояния)
    index.ts                        регистрация инструмента dev_console
    state.ts                        машина состояний + ledger + проекция UI
    state.test.ts                   тесты
    package.json

DEVATA/                             артефакты рантайма
    state.json                      ledger (пишется только через инструмент)
    DEV_CONSOLE_RUNTIME_ARCHITECTURE.md
                                    архитектура, API, статус реализации
```

## Принцип разделения

* **SKILL = как думать и общаться** (классификация задач, гейты, верификация, принципы).
* **RUNTIME = что правда** (состояние, разрешённые переходы, обязательные `why`/`verification`, рендер UI).
* UI статуса — проекция `state.json`: секция существует только если есть данные.
* `DONE` терминален; переделка = новая задача.

## Тесты

```powershell
node --experimental-strip-types --test DEV_CONSOLE/state.test.ts
```

## Распределение

Глобальная junction-связь: `~/.config/opencode/plugins/dev-console` → `DEV_CONSOLE`
(плагин загружается для всех проектов, горячая перезагрузка при правках).
