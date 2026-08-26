# Start the Hubble DSH web instance as a detached Windows process.
param([int]$Port = 3080)
$root = "F:\AI-workspace\Hubble-v2"
$env:DSH_HOME = "$root\data\dsh-home"
# OPENROUTER_API_KEY is read from Reasonix's global .env if not already set
if (-not $env:OPENROUTER_API_KEY) {
  $line = Select-String -Path "$env:APPDATA\reasonix\.env" -Pattern '^OPENROUTER_API_KEY=(.+)$' | Select-Object -First 1
  if ($line) { $env:OPENROUTER_API_KEY = $line.Matches[0].Groups[1].Value }
}
$bin = "C:\Users\Rico\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js"
Start-Process -FilePath "C:\Program Files\nodejs\node.exe" `
  -ArgumentList "`"$bin`"","web","--no-open","--port","$Port" `
  -WorkingDirectory $root `
  -RedirectStandardOutput "$root\temp\dsh_boot.log" `
  -RedirectStandardError "$root\temp\dsh_err.log" `
  -WindowStyle Hidden
Write-Host "dsh launch requested on :$Port"
