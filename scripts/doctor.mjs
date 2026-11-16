#!/usr/bin/env node
// Доктор установки «Маруська · Корпорация Ясность» (T181/T182).
// Проверяет, чем дышит машина: плагин, скилл, DEVATA, opencode.
// Запуск: node scripts/doctor.mjs  (из корня клона или любого гит-репо)
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { execFileSync } from "node:child_process"

const home = homedir()
let ok = true
const good = (t) => console.log(`  ✔ ${t}`)
const bad = (t) => { console.log(`  ✘ ${t}`); ok = false }
const warn = (t) => console.log(`  ? ${t}`)

console.log("╭── Маруська · Корпорация Ясность — доктор установки ──╮")

// 1. Плагин зарегистрирован в ~/.config/opencode/plugins/dev-console
const pluginPath = join(home, ".config", "opencode", "plugins", "dev-console")
if (!existsSync(pluginPath)) {
  bad(`плагин НЕ зарегистрирован: ${pluginPath} не существует`)
  console.log("      фикс Windows (PowerShell):")
  console.log(`      New-Item -ItemType Junction -Path "$env:USERPROFILE\\.config\\opencode\\plugins\\dev-console" -Target "<клон>\\DEV_CONSOLE"`)
  console.log("      фикс macOS/Linux:")
  console.log("      ln -s <клон>/DEV_CONSOLE ~/.config/opencode/plugins/dev-console")
} else {
  good(`плагин зарегистрирован: ${pluginPath}`)
  let real = null
  try { real = realpathSync(pluginPath) } catch {}
  if (real && real !== pluginPath) good(`указывает на: ${real}`)
  const idx = join(real ?? pluginPath, "index.ts")
  if (existsSync(idx)) good("index.ts плагина на месте")
  else bad("index.ts не найден в каталоге плагина — джанкен/симлинк ведёт не на DEV_CONSOLE клона")
  // npm-зависимость плагина резолвится? (node идёт вверх до node_modules клона)
  const dep = join(real ?? pluginPath, "node_modules", "@opencode", "plugin")
  const depUp = join(real ?? pluginPath, "..", "node_modules", "@opencode", "plugin")
  if (existsSync(dep) || existsSync(depUp)) good("зависимость @opencode/plugin резолвится")
  else bad("@opencode/plugin не найден — выполни npm install в КОРНЕ клона (рядом с DEV_CONSOLE)")
}

// 2. Скилл LAVK DEVATA подключён в конфиге
const cfg = join(home, ".config", "opencode", "opencode.json")
if (!existsSync(cfg)) {
  warn("нет ~/.config/opencode/opencode.json — скилл не подключён (маруська будет работать без правил Корпорации)")
} else {
  try {
    const j = JSON.parse(readFileSync(cfg, "utf8"))
    const skills = Array.isArray(j.skills) ? j.skills : []
    const lavk = skills.find((s) => /LAVK\s*DEVATA|maruska/i.test(String(s)))
    if (lavk) good(`скилл в конфиге: ${lavk}`)
    else warn("в массиве skills нет пути к LAVK DEVATA клона")
  } catch {
    warn("opencode.json не читается как JSON")
  }
}

// 3. Текущий каталог: гит-репо? DEVATA есть?
const cwd = process.cwd()
const isGit = existsSync(join(cwd, ".git")) || existsSync(join(resolve(cwd, ".."), ".git"))
if (!isGit) {
  warn(`${cwd} — не гит-репо: консоль живёт только в репо (гард non-git, inert)`)
} else if (existsSync(join(cwd, "DEVATA", "state.json"))) {
  good(`DEVATA инициализирована: ${join(cwd, "DEVATA")}`)
} else {
  warn(`в ${cwd} репо есть, но DEVATA нет — открой OpenCode в репо и начни сеанс: плагин создаст папку при загрузке`)
}

// 4. OpenCode CLI
try {
  const v = execFileSync("opencode", ["--version"], { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim()
  good(`opencode CLI: ${v}`)
} catch {
  warn("opencode CLI не найден в PATH (desktop-приложение — это ок; чистый CLI может отсутствовать)")
}

console.log(ok
  ? "╰── Итог: каркас жив. Если Маруська всё же молчит — пришли этот вывод своему Папе-оркестратору целиком."
  : "╰── Итог: есть пробелы ✘ — исправь по пометкам и перезапусти OpenCode.")
process.exitCode = ok ? 0 : 1
