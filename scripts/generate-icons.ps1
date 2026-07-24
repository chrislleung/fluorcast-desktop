param(
  [string]$Source = "app-icon.svg"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Source)) {
  throw "Logo source not found: $Source"
}

npm.cmd exec -- tauri icon $Source
