# Hidden local entry of the YouTube Data API key. Stores it DPAPI-encrypted (current Windows user only) at
# %LOCALAPPDATA%\MIPRuntime\youtube-mvp\key.dpapi — outside Git. Prints only a format check, never the key.
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:LOCALAPPDATA 'MIPRuntime\youtube-mvp'
$file = Join-Path $dir 'key.dpapi'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Write-Host 'MIP YouTube MVP - enter the YouTube Data API v3 key. Typing is hidden.'
$secure = Read-Host -Prompt 'YouTube API key' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $ok = $plain -cmatch '^AIza[0-9A-Za-z_-]{35}$'
  $len = $plain.Length
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr); $plain = $null
}
if (-not $ok) { Write-Host "Format check FAILED (length $len, expected 39 starting with AIza). Nothing was saved."; Read-Host 'Press Enter to close'; exit 1 }
$secure | ConvertFrom-SecureString | Set-Content -Path $file -Encoding ascii
icacls $file /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
Write-Host "Saved, DPAPI-encrypted for $env:USERNAME only. Format OK (length $len). You can close this window."
Read-Host 'Press Enter to close'
