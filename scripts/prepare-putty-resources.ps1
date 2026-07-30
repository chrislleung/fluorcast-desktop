param(
  [string]$Destination = "src-tauri\resources\putty"
)

$ErrorActionPreference = "Stop"

$version = "0.84"
$baseUrl = "https://the.earth.li/~sgtatham/putty/$version/w64"
$tools = @(
  @{
    Name = "putty.exe"
    Url = "$baseUrl/putty.exe"
    Sha256 = "7056ca2f6a9f3c525845b116c7bf564ced3284a4083ea80d7e9ef51a16f612c4"
  },
  @{
    Name = "plink.exe"
    Url = "$baseUrl/plink.exe"
    Sha256 = "e5621ffe4879f0ec39ed40f688db9399c2d43054d41ef14472fa335c4693b915"
  },
  @{
    Name = "pscp.exe"
    Url = "$baseUrl/pscp.exe"
    Sha256 = "fb2d69f840026a562629d757095c968b5748daaf1d08fad14414a8ef79de319e"
  }
)

New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "fluorcast-putty-$version"
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

foreach ($tool in $tools) {
  $downloadPath = Join-Path $tempDir $tool.Name
  Invoke-WebRequest -Uri $tool.Url -OutFile $downloadPath
  $actualHash = (Get-FileHash -Path $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $tool.Sha256) {
    throw "SHA-256 mismatch for $($tool.Name). Expected $($tool.Sha256), got $actualHash."
  }
  Copy-Item -LiteralPath $downloadPath -Destination (Join-Path $Destination $tool.Name) -Force
}

@"
PuTTY $version standalone 64-bit Windows executables.
Source: https://www.chiark.greenend.org.uk/~sgtatham/putty/releases/$version.html
Checksums: https://the.earth.li/~sgtatham/putty/$version/sha256sums

putty.exe SHA-256 7056ca2f6a9f3c525845b116c7bf564ced3284a4083ea80d7e9ef51a16f612c4
plink.exe SHA-256 e5621ffe4879f0ec39ed40f688db9399c2d43054d41ef14472fa335c4693b915
pscp.exe  SHA-256 fb2d69f840026a562629d757095c968b5748daaf1d08fad14414a8ef79de319e
"@ | Set-Content -Path (Join-Path $Destination "README.txt") -Encoding UTF8

Write-Host "Prepared PuTTY $version resources in $Destination"
