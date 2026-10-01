<#
.SYNOPSIS
ServerSherpa kiosk launcher (laptop edition), Windows.

.DESCRIPTION
Run at sign-in (the all-users StartUp shortcut) and from the ServerSherpa
Kiosk shortcuts on the Desktop and in the Start menu. Waits for the kiosk to
answer, then opens it in the browser the installer found (KIOSK_BROWSER in
config.env), in app mode. The Windows port of launch.sh.

Environment: KIOSK_LAUNCH_TIMEOUT_S (default 300), KIOSK_LAUNCH_POLL_S (2).
Testing hooks: -LibraryOnly or KIOSK_LAUNCH_LIB=1 defines the functions
without running. Written for Windows PowerShell 5.1 and kept plain ASCII.

.PARAMETER LibraryOnly
Define the functions and return without running (for Pester).
#>
[CmdletBinding()]
param([switch]$LibraryOnly)

$LaunchScriptDir = $PSScriptRoot
$KioskUrl = 'http://localhost:8090'
# Probed on 127.0.0.1: Docker publishes the port there only, and localhost
# may try ::1 first. The browser still opens localhost.
$KioskIdentityUrl = 'http://127.0.0.1:8090/edge/identity'

function Get-LaunchDir {
    if ($env:KIOSK_DIR) { return $env:KIOSK_DIR }
    $LaunchScriptDir
}

function Get-LaunchTimeout {
    $v = 0
    if ($env:KIOSK_LAUNCH_TIMEOUT_S -and [int]::TryParse($env:KIOSK_LAUNCH_TIMEOUT_S, [ref]$v)) { return $v }
    300
}

function Get-LaunchPollInterval {
    $v = 0
    if ($env:KIOSK_LAUNCH_POLL_S -and [int]::TryParse($env:KIOSK_LAUNCH_POLL_S, [ref]$v)) { return $v }
    2
}

function Test-KioskResponding {
    try {
        Invoke-WebRequest -Uri $KioskIdentityUrl -UseBasicParsing -TimeoutSec 3 | Out-Null
        return $true
    } catch { return $false }
}

# Wait-Kiosk: until /edge/identity answers ($true) or the timeout passes ($false).
function Wait-Kiosk {
    $timeout = Get-LaunchTimeout
    $deadline = (Get-Date).AddSeconds($timeout)
    while (-not (Test-KioskResponding)) {
        if ((Get-Date) -ge $deadline) {
            Write-Warning "The kiosk didn't answer at $KioskUrl within $timeout seconds; opening it anyway."
            return $false
        }
        Start-Sleep -Seconds (Get-LaunchPollInterval)
    }
    $true
}

# Get-KioskBrowser: KIOSK_BROWSER from config.env, read without running the file.
function Get-KioskBrowser {
    $config = [IO.Path]::Combine((Get-LaunchDir), 'config.env')
    if (-not (Test-Path -LiteralPath $config -PathType Leaf)) { return '' }
    foreach ($line in [IO.File]::ReadAllLines($config)) {
        if ($line -match '^KIOSK_BROWSER=(.*)$') { return $Matches[1].Trim() }
    }
    ''
}

# Open-Kiosk: the configured browser in app mode, else the default browser.
function Open-Kiosk {
    $b = Get-KioskBrowser
    if ($b) {
        try {
            Start-Process -FilePath $b -ArgumentList "--app=$KioskUrl" -ErrorAction Stop
            return
        } catch {
            Write-Warning "Couldn't start $b; opening the kiosk in the default browser."
        }
    }
    Start-Process -FilePath $KioskUrl
}

function Invoke-KioskLaunch {
    Wait-Kiosk | Out-Null
    Open-Kiosk
}

# Run only as the last statement, so a partly downloaded script runs nothing.
if ($LibraryOnly -or $env:KIOSK_LAUNCH_LIB -eq '1') { return }
Invoke-KioskLaunch
