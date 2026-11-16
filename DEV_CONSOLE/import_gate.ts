// T130 · ГЕЙТ ИДЕНТИФИКАТОРОВ (урок P0-инцидента 29.10).
//
// PARSE --check (node --experimental-strip-types --check) ловит ТОЛЬКО синтаксис.
// Потерянный экспорт (instancePersona в index.ts после волны T6/T47) прошёл PARSE,
// а в рантайме ESM-линковка дала ReferenceError → ВСЕ диспатчи умерли (A120/A121)
// при живом "PARSE OK".
//
// Гейт без зависимостей: статически сверяет каждый именованный импорт из
// локальных модулей DEV_CONSOLE с фактическими экспортами целевого файла.
// Упал гейт → потерянный экспорт найден ДО рестарта сервиса.
//
// Запуск руками:  node --experimental-strip-types DEV_CONSOLE/import_gate.ts
// В приёмке:      те же проверки в state.test.ts (T130-тесты).

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** Все экспортируемые имена: export const/let/var/function/class/type/interface/enum + export { … }. */
export function exportsOf(src: string): Set<string> {
  const out = new Set<string>()
  const direct =
    /export\s+(?:declare\s+)?(?:(?:async|abstract)\s+)*(?:const|let|var|function|class|type|interface|enum)\s+([A-Za-z0-9_$]+)/g
  let m: RegExpExecArray | null
  while ((m = direct.exec(src)) !== null) out.add(m[1])
  const block = /export\s*\{([^}]*)\}/g
  while ((m = block.exec(src)) !== null) {
    for (const part of m[1].split(",")) {
      const t = part.trim()
      if (t === "") continue
      const as = /\s+as\s+([A-Za-z0-9_$]+)\s*$/.exec(t)
      out.add(as ? as[1] : t.replace(/^type\s+/, "").trim())
    }
  }
  return out
}

/** Маска кода: 1 = символ в коде (не в строке/комментарии). */
function codeMask(src: string): Uint8Array {
  const mask = new Uint8Array(src.length)
  let i = 0
  let state: "code" | "sq" | "dq" | "tpl" | "line" | "block" = "code"
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (state === "code") {
      if (c === "/" && n === "/") { state = "line"; i += 2; continue }
      if (c === "/" && n === "*") { state = "block"; i += 2; continue }
      if (c === '"') { state = "dq"; i++; continue }
      if (c === "'") { state = "sq"; i++; continue }
      if (c === "`") { state = "tpl"; i++; continue }
      mask[i] = 1
      i++
      continue
    }
    if (state === "line") { if (c === "\n") { state = "code"; mask[i] = 1 } i++; continue }
    if (state === "block") { if (c === "*" && n === "/") { state = "code"; i += 2 } else i++; continue }
    if (c === "\\") { i += 2; continue }
    const closes = (state === "dq" && c === '"') || (state === "sq" && c === "'") || (state === "tpl" && c === "`")
    if (closes) { state = "code"; mask[i] = 1; i++; continue }
    i++
  }
  return mask
}

/** Именованные импорты файла: [{ from, names }] — только из КОДА (не из строк/комментариев). */
export function importsOf(src: string): { from: string; names: string[] }[] {
  const res: { from: string; names: string[] }[] = []
  const mask = codeMask(src)
  const re = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    if (mask[m.index] !== 1) continue // «импорт» внутри строкового литерала — пропуск
    const clean = m[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
    const names = clean
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "")
      .map((s) => s.replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim())
      .filter((s) => s !== "")
    res.push({ from: m[2], names })
  }
  return res
}

export interface ImportGap {
  file: string
  from: string
  names: string[]
}

/** Имена, ВЫЗВАННЫЕ в коде файла: `name(`. Только код (строки/комментарии вырезаны). */
export function calledNames(src: string): Set<string> {
  const out = new Set<string>()
  const mask = codeMask(src)
  const re = /([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    if (mask[m.index] !== 1) continue
    out.add(m[1])
  }
  return out
}

/** Имена, ОБЪЯВЛЕННЫЕ в самом файле (const/let/var/function/class/param-подобные). */
export function declaredNames(src: string): Set<string> {
  const out = new Set<string>()
  const mask = codeMask(src)
  const re = /\b(?:const|let|var|function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    if (mask[m.index] !== 1) continue
    out.add(m[1])
  }
  return out
}

/**
 * T146 (инцидент 11.11: `loadComplaints is not defined`): гейт проверял только
 * «импорт есть, экспорта нет». Вторая половина P0-класса — «функция ВЫЗВАНА, но
 * НЕ импортирована» — проходила молча: ReferenceError только в рантайме, и
 * весь рендер панели падал («канал: нет»). Теперь: имя из экспортов локального
 * модуля, которое вызывается в коде файла, но не импортировано и не объявлено
 * локально → это дыра.
 */
export function undefinedUsesIn(file: string): ImportGap[] {
  const src = readFileSync(file, "utf8")
  if (/export\s+\*\s+from/.test(src)) return []
  const called = calledNames(src)
  const declared = declaredNames(src)
  // Импорт одного модуля может быть разбит на несколько строк
  // (`import { a } from "./state.ts"` + `import { b } from "./state.ts"`) —
  // собираем ВСЕ имена по модулю, иначе «used, но не imported» ложно срабатывает.
  const byModule = new Map<string, Set<string>>()
  for (const imp of importsOf(src)) {
    const set = byModule.get(imp.from) ?? new Set<string>()
    for (const n of imp.names) set.add(n)
    byModule.set(imp.from, set)
  }
  const gaps: ImportGap[] = []
  for (const [from, importedHere] of byModule) {
    if (!from.startsWith("./") && !from.startsWith("../")) continue
    const target = resolveLocal(dirname(file), from)
    if (target === null) continue
    const ex = exportsOf(readFileSync(target, "utf8"))
    const missing = [...ex].filter((n) => called.has(n) && !importedHere.has(n) && !declared.has(n))
    if (missing.length > 0) gaps.push({ file, from, names: missing })
  }
  return gaps
}

/** Разрешение локального модуля: ./x.ts, ./x.js (strip-types живёт на .ts-исходниках), ./x. */
function resolveLocal(fromDir: string, spec: string): string | null {
  const raw = join(fromDir, spec)
  const candidates = [raw, raw.replace(/\.js$/, ".ts"), `${raw}.ts`]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

/** Сверка одного файла с его локальными зависимостями. */
export function gapsIn(file: string): ImportGap[] {
  const src = readFileSync(file, "utf8")
  if (/export\s+\*\s+from/.test(src)) return [] // ре-экспорт «всё» — статически не посчитать
  const gaps: ImportGap[] = []
  for (const imp of importsOf(src)) {
    if (!imp.from.startsWith("./") && !imp.from.startsWith("../")) continue
    const target = resolveLocal(dirname(file), imp.from)
    if (target === null) {
      gaps.push({ file, from: imp.from, names: ["<файл не найден>"] })
      continue
    }
    const ex = exportsOf(readFileSync(target, "utf8"))
    const missing = imp.names.filter((n) => !ex.has(n))
    if (missing.length > 0) gaps.push({ file, from: imp.from, names: missing })
  }
  return gaps
}

/** Гейт по всему DEV_CONSOLE: все *.ts, кроме себя. */
function main(): void {
  const self = fileURLToPath(import.meta.url)
  const dir = dirname(self)
  const targets = readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f))
    .filter((f) => f !== self)
  const all: ImportGap[] = []
  for (const f of targets) all.push(...gapsIn(f))
  // T146: вторая половина P0-класса — вызов без импорта (ReferenceError в рантайме).
  const undefinedUses: ImportGap[] = []
  for (const f of targets) undefinedUses.push(...undefinedUsesIn(f))
  if (all.length === 0 && undefinedUses.length === 0) {
    console.log(
      `T130 import-gate: OK (${targets.length} файлов, потерянных импортов нет, необъявленных вызовов нет)`,
    )
    return
  }
  for (const g of all) {
    console.error(`T130 import-gate: ${g.file} → ${g.from}: НЕТ ЭКСПОРТА ${g.names.join(", ")}`)
  }
  for (const g of undefinedUses) {
    console.error(
      `T130 import-gate: ${g.file} → ${g.from}: ВЫЗОВ БЕЗ ИМПОРТА ${g.names.join(", ")} (ReferenceError в рантайме)`,
    )
  }
  process.exitCode = 1
}

// Точка входа — только при прямом запуске (импорт из тестов не побочничает).
const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === "string" &&
  /import_gate\.ts$/.test(process.argv[1].replace(/\\/g, "/"))
if (invokedDirectly) main()
