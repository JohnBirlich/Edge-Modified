<#
.SYNOPSIS
  Edge Control Center — Windows installer (v1.0.0 "IGNITION")
.DESCRIPTION
  * Verifies elevation (required for privileged paths)
  * Creates a mandatory system restore point BEFORE any change
  * Installs the ECC core + EBP agent, registers the auto-start task
  * Emits a restore anchor consumed by the server on first run
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "$env:ProgramFiles\EdgeControlCenter",
  [int]$Port = 3327
)
$ErrorActionPreference = 'Stop'

# --- 1. elevation check -----------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host '✗ Run this installer from an elevated PowerShell.' -ForegroundColor Red; exit 1 }

Write-Host '╔══════════════════════════════════════════════╗'
Write-Host '║   EDGE CONTROL CENTER  v1.0.0  "IGNITION"    ║'
Write-Host '╚══════════════════════════════════════════════╝'

# --- 2. MANDATORY restore point --------------------------------------------
Write- "`n[1/6] Creating system restore point (mandatory)… "
try {
  Enable-ComputerRestore -Drive "$env:SystemDrive\" -ErrorAction SilentlyContinue
  Checkpoint-Computer -Description "EDGE-ECC pre-install v1.0.0" -RestorePointType MODIFY_SETTINGS
  Write-Host '✓' -ForegroundColor Green
} catch {
  Write-Host "⚠ restore point failed: $($_.Exception.Message) — aborting per policy." -ForegroundColor Yellow
  exit 2
}

# --- 3. prerequisites -------------------------------------------------------
Write- "[2/6] Checking prerequisites… "
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Host '✗ Node.js ≥ 18 required (https://nodejs.org).'; exit 3 }
$v = (node --version) -replace 'v','' -split '\.'
if ([int]$v[0] -lt 18) { Write-Host "✗ Node ≥ 18 required, found $($v[0])."; exit 3 }
Write-Host "✓ Node $($v -join '.')"

# --- 4. install files -------------------------------------------------------
Write- "[3/6] Installing core → $InstallDir… "
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$src = $PSScriptRoot
Copy-Item "$src\control-center" $InstallDir -Recurse -Force
Copy-Item "$src\VERSION.json" $InstallDir -Force
Copy-Item "$src\agent" $InstallDir -Recurse -Force
Write-Host '✓'

# --- 5. firewall + auto-start ----------------------------------------------
Write- "[4/6] Firewall rule (EBP 3327/tcp + discovery 33270/udp)… "
New-NetFirewallRule -DisplayName 'EDGE Control Center' -Direction Inbound `
  -Protocol TCP -LocalPort $Port -Action Allow -ErrorAction SilentlyContinue | Out-Null
New-NetFirewallRule -DisplayName 'EDGE Bridge Discovery' -Direction Inbound `
  -Protocol UDP -LocalPort 33270 -Action Allow -ErrorAction SilentlyContinue | Out-Null
Write-Host '✓'

Write- "[5/6] Registering auto-start task… "
$act = New-ScheduledTaskAction -Execute 'node.exe' -Argument "server.js" -WorkingDirectory "$InstallDir\control-center"
$trg = New-ScheduledTaskTrigger -AtLogOn
$set = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'EdgeControlCenter' -Action $act -Trigger $trg -Settings $set -Force | Out-Null
Write-Host '✓'

# --- 6. first run + health probe -------------------------------------------
Write- "[6/6] Starting service & health probe… "
Start-ScheduledTask -TaskName 'EdgeControlCenter'
$ok = $false
foreach ($i in 1..10) {
  Start-Sleep -Seconds 1
  try { $r = Invoke-RestMethod "http://127.0.0.1:$Port/api/state" -TimeoutSec 2; $ok = $true; break } catch { }
}
if (-not $ok) { Write-Host '✗ health probe failed after 10 s — see server log.' -ForegroundColor Red; exit 4 }
Write-Host "✓ Edge Control Center $($r.version.version) live on http://127.0.0.1:$Port" -ForegroundColor Green

Write- @"

Next steps:
  • Open http://127.0.0.1:$Port  → Admin panel → user 'hasberd', default passphrase 'ardor-3327' → ROTATE IT
  • Bridge the other OS:  python agent\edge-agent.py pair <this-host> 3327
  • Update channel:       installer\update.ps1 -Channel stable|beta|alpha
Rollback:  System Restore → 'EDGE-ECC pre-install v1.0.0'  (or installer\uninstall.ps1)
"@ -ForegroundColor Cyan
