# Key readiness without revealing it: the DPAPI file exists, decrypts for this user, and has the expected length.
$file = Join-Path $env:LOCALAPPDATA 'MIPRuntime\youtube-mvp\key.dpapi'
if (-not (Test-Path $file)) { 'KEY_READY=false (no key file)'; exit 1 }
try { $s = Get-Content $file | ConvertTo-SecureString } catch { 'KEY_READY=false (cannot decrypt for this user)'; exit 1 }
$acl = (Get-Acl $file).Access | ForEach-Object { "$($_.IdentityReference):$($_.FileSystemRights)" }
"KEY_READY=$($s.Length -eq 39) length=$($s.Length) written=$((Get-Item $file).LastWriteTime.ToString('s')) acl=$($acl -join ';')"
