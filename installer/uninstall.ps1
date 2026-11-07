<# ECC uninstaller (Windows) — stops task, removes files, leaves restore points intact #>
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host '✗ elevated shell required'; exit 1 }
Unregister-ScheduledTask -TaskName 'EdgeControlCenter' -Confirm:$false -ErrorAction SilentlyContinue
Get-NetFirewallRule -DisplayName 'EDGE*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Remove-Item "$env:ProgramFiles\EdgeControlCenter" -Recurse -Force -ErrorAction SilentlyContinue
Write-Host '✓ ECC removed. System restore points kept — roll back anytime from System Restore.'
