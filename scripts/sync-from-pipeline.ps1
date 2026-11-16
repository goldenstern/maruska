# T180: синк публичной зеркалки из источника правды (pipeline-setup).
# Копирует ТОЛЬКО фреймворк: DEV_CONSOLE, LAVK DEVATA, docs, package*.json.
# Приватный рантайм (DEVATA: леджер/чат/ключи) НЕ копируется никогда.
$ErrorActionPreference = "Stop"
$src = "C:\Users\banan\Developer\pipeline-setup"
$dst = "C:\Users\banan\Developer\maruska"
Copy-Item -Path (Join-Path $src "DEV_CONSOLE\*.ts") -Destination (Join-Path $dst "DEV_CONSOLE") -Force
Copy-Item -Path (Join-Path $src "DEV_CONSOLE\package.json") -Destination (Join-Path $dst "DEV_CONSOLE") -Force
Copy-Item -Path (Join-Path $src "LAVK DEVATA\*") -Destination (Join-Path $dst "LAVK DEVATA") -Force
Copy-Item -Path (Join-Path $src "docs\*") -Destination (Join-Path $dst "docs") -Force
Copy-Item -Path (Join-Path $src "package.json") -Destination $dst -Force
Copy-Item -Path (Join-Path $src "package-lock.json") -Destination $dst -Force
Write-Host "sync done; git status:"
git -C $dst status --short
