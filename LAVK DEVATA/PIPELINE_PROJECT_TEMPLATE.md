# PIPELINE_PROJECT — <название проекта>

> Шаблон параметров навыка `LAVK DEVATA`. Скопировать в КОРЕНЬ ПРОЕКТА как `PIPELINE_PROJECT.md` и заполнить под проект.
> Хранить здесь только то, что пайплайн не может надёжно получить автоматически (Environment First) — не вторую документацию проекта.
> Оркестратор читает файл при старте задачи и вкладывает содержимое в ТЗ субагентам. Хроника выполнения — в `RECOVERY_STATE.md`, не здесь.

```yaml
qc_model:           # ID модели Exploratory/Acceptance QC, напр. opencode/glm-5.3-flash-free
reasoning_model:    # опц.: сложная логика / reasoning, напр. opencode/glm-5.3-flash-free (пусто → primary)
second_opinion_model: # опц.: второе мнение перед крупным изменением, напр. opencode/glm-5.3-flash-free (пусто → primary)
test_command:       # integration verify: команда и цель, напр. node --test tests/alpha.test.js → N/N
deploy_command:     # сборка → заливка → verify → рестарт; где лежат tools
production_target:  # адрес/пути прода, где живут данные
protected_paths:    # что не трогать (напр. чужие адаптированные шейдеры/загрузку), особые конвенции
source_of_truth:    # первоисточники UX/продукта, по которым сверяется QC
```

_Необязательно — заполнять только если автоматически не выводится: карта файлов (точки входа UI, сервера, тестов, доков), открытые задачи (реестр багов и приёмок)._
