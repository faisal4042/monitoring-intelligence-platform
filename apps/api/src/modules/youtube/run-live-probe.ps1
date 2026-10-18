# Runs live-probe.ts once: ONE search.list request. The key is decrypted into this process's environment only
# (inherited by the single node child), never printed, and removed afterwards. Requires -Confirmed.
param([switch]$Confirmed, [ValidateSet(1, 2)][int]$SearchLimit = 1)
$ErrorActionPreference = 'Stop'
if (-not $Confirmed) { throw 'refused: run with -Confirmed only after the owner''s final confirmation' }
$rt = Join-Path $env:LOCALAPPDATA 'MIPRuntime\youtube-mvp'
$secure = Get-Content (Join-Path $rt 'key.dpapi') | ConvertTo-SecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $env:YOUTUBE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
$env:YOUTUBE_MODE = 'live'; $env:YOUTUBE_LIVE_APPROVED = '1'; $env:YOUTUBE_PROBE_CONFIRMED = '1'; $env:YOUTUBE_PROBE_SEARCH_LIMIT = "$SearchLimit"
$env:YOUTUBE_MVP_DATABASE_URL = (Get-Content (Join-Path $rt 'test-db.json') -Raw | ConvertFrom-Json).url
try {
  Push-Location (Join-Path $PSScriptRoot '..\..\..')
  & node --import ./src/modules/youtube/probe-egress-guard.mjs --import tsx src/modules/youtube/live-probe.ts
} finally {
  Pop-Location
  Remove-Item Env:YOUTUBE_API_KEY, Env:YOUTUBE_PROBE_CONFIRMED, Env:YOUTUBE_LIVE_APPROVED, Env:YOUTUBE_PROBE_SEARCH_LIMIT -ErrorAction SilentlyContinue
}
