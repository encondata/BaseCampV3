<#
.SYNOPSIS
ServerSherpa kiosk installer (laptop edition) for Windows 10 22H2 / Windows 11.

.DESCRIPTION
  irm https://raw.githubusercontent.com/encondata/BaseCampV3/main/kiosk_laptop/installer/install.ps1 | iex
  powershell -ExecutionPolicy Bypass -File kiosk_laptop\installer\install.ps1     # from a checkout

The same command installs, repairs and upgrades: it turns on WSL2, installs
Docker Desktop (resuming on its own after a restart), saves the settings,
writes the compose file, starts the kiosk and prints a summary.

Environment overrides:
  KIOSK_DIR              install folder (default C:\ProgramData\ServerSherpaKiosk)
  KIOSK_DATA_DIR         data folder    (default C:\ProgramData\ServerSherpaKiosk\data)
  KIOSK_IMAGE            full image reference (tests and CI)
  KIOSK_INSTALLER_REF    git ref the companion files are fetched from (default main)
  KIOSK_NONINTERACTIVE   1 = never prompt
  KIOSK_CONFIRM_PURGE    DELETE = confirm -PurgeData without a prompt

Testing hooks (not for normal use):
  KIOSK_TEMPLATE_DIR     read companion files from this folder instead of downloading
  KIOSK_INSTALL_LIB=1    define the functions without running (same as -LibraryOnly)

Written for Windows PowerShell 5.1 and kept plain ASCII (5.1 reads a file
without a byte-order mark as the ANSI code page).

.PARAMETER ApiUrl
Cloud API URL (default https://api.serversherpa.com).
.PARAMETER PortalUrl
Portal URL (default: the API URL with api. -> portal.).
.PARAMETER Channel
stable (default) or edge.
.PARAMETER Yes
Never prompt.
.PARAMETER Uninstall
Remove the kiosk (the data folder is kept).
.PARAMETER PurgeData
With -Uninstall, also delete the data folder (asks you to type DELETE).
.PARAMETER Resume
Continue an install after a restart (set up by the installer itself).
.PARAMETER LibraryOnly
Define the functions and return without running (for Pester).
#>
# Write-Host is how an interactive installer talks to the technician (and Start-Transcript logs it).
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'Interactive installer output; captured by Start-Transcript.')]
# The installer runs unattended end to end; -WhatIf/-Confirm would not mean anything here.
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '', Justification = 'Installer steps, not reusable cmdlets.')]
# Get-KioskPaths, Install-LoginItems and Remove-LoginItems are the agreed interface names.
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseSingularNouns', '', Justification = 'Interface names fixed by the plan.')]
[CmdletBinding()]
param(
    [string]$ApiUrl,
    [string]$PortalUrl,
    [string]$Channel,
    [switch]$Yes,
    [switch]$Uninstall,
    [switch]$PurgeData,
    [switch]$Resume,
    [switch]$LibraryOnly
)

# -- Constants --------------------------------------------------------------
$DefaultApiUrl = 'https://api.serversherpa.com'
$LegacyProject = 'serversherpa-kiosk-laptop'
$KioskContainer = 'serversherpa-kiosk-edge-1'     # project "serversherpa-kiosk", service "edge"
$KioskUrl = 'http://localhost:8090'
$ResumeValueName = 'ServerSherpaKioskInstall'
$RunOnceKey = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
$DockerDesktopExe = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
$DockerBinDir = "$env:ProgramFiles\Docker\Docker\resources\bin"
$RestartMarker = 'KIOSK_RESTART_PENDING'
$Dash = [string][char]0x2014                       # an em dash, kept out of the source as plain ASCII
$KioskEnvNames = @('KIOSK_DIR', 'KIOSK_DATA_DIR', 'KIOSK_IMAGE', 'KIOSK_NONINTERACTIVE', 'KIOSK_INSTALLER_REF',
    'KIOSK_TEMPLATE_DIR', 'KIOSK_CONFIRM_PURGE', 'EDGE_DATA_HOST_DIR')
$SelfPath = $PSCommandPath                         # empty under irm | iex
$AssumeYes = [bool]$Yes

# -- Output helpers ---------------------------------------------------------
function Write-Info { param([string]$Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Warn { param([string]$Message) Write-Host "Warning: $Message" -ForegroundColor Yellow }

# True when we may prompt: not forced non-interactive, not library mode, a console to read.
function Test-Interactive {
    if ($env:KIOSK_NONINTERACTIVE -eq '1' -or $AssumeYes -or $env:KIOSK_INSTALL_LIB -eq '1') { return $false }
    if (-not [Environment]::UserInteractive) { return $false }
    try { return -not [Console]::IsInputRedirected } catch { return $false }
}

function Read-Answer { param([string]$Prompt) Read-Host -Prompt $Prompt }

function Test-IsWindows { [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT }

# Thrown to stop the install cleanly (exit 0) until Windows restarts or the user signs in again.
function Request-Restart {
    param([string]$Message)
    throw "$RestartMarker $Message"
}

# -- Companion files ----------------------------------------------------------
function Get-BaseUrl {
    $ref = $env:KIOSK_INSTALLER_REF
    if (-not $ref) { $ref = 'main' }
    "https://raw.githubusercontent.com/encondata/BaseCampV3/$ref/kiosk_laptop/installer"
}

function Enable-Tls12 {
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch { Write-Verbose 'TLS 1.2 is already the default here.' }
}

# Get-CompanionText NAME: from KIOSK_TEMPLATE_DIR, else downloaded from the same ref.
function Get-CompanionText {
    param([Parameter(Mandatory = $true)][string]$Name)
    if ($env:KIOSK_TEMPLATE_DIR) {
        $p = Join-Path $env:KIOSK_TEMPLATE_DIR $Name
        if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw "Missing $p" }
        return [IO.File]::ReadAllText($p)
    }
    $url = "$(Get-BaseUrl)/$Name"
    Enable-Tls12
    try {
        $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 60
    } catch {
        throw "Couldn't download $url. Check the network, then re-run."
    }
    $c = $r.Content
    if ($c -is [byte[]]) { $c = [Text.Encoding]::UTF8.GetString($c) }
    [string]$c
}

# Write-TextFile PATH TEXT: UTF-8 without a byte-order mark (compose and env
# files must not start with one), via a temp file renamed into place.
function Write-TextFile {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)
    $tmp = "$Path.kiosk-tmp"
    try {
        [IO.File]::WriteAllText($tmp, $Text, (New-Object Text.UTF8Encoding $false))
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            [IO.File]::Replace($tmp, $Path, [NullString]::Value)   # $null would arrive as ""
        } else {
            [IO.File]::Move($tmp, $Path)
        }
    } finally {
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    }
}

# -- Platform -----------------------------------------------------------------
function Get-KioskPaths {
    $programData = $env:ProgramData
    if (-not $programData) { $programData = 'C:\ProgramData' }
    $install = $env:KIOSK_DIR
    if (-not $install) { $install = $programData + '\ServerSherpaKiosk' }
    $data = $env:KIOSK_DATA_DIR
    if (-not $data) { $data = $programData + '\ServerSherpaKiosk\data' }
    @{ Install = $install; Data = $data }
}

# Docker Desktop needs Windows 10 22H2 (build 19045) or later, and not Windows Server.
function Test-WindowsSupported {
    param([Parameter(Mandatory = $true)][int]$Build, [Parameter(Mandatory = $true)][int]$ProductType)
    ($ProductType -eq 1) -and ($Build -ge 19045)
}

function Assert-WindowsSupported {
    $build = [Environment]::OSVersion.Version.Build
    $productType = (Get-CimInstance -ClassName Win32_OperatingSystem).ProductType
    if (-not (Test-WindowsSupported -Build $build -ProductType $productType)) {
        if ($productType -ne 1) { throw 'Windows Server is not supported. Use Windows 10 22H2 or Windows 11.' }
        throw "Windows 10 22H2 (build 19045) or Windows 11 is required (this PC has build $build). Run Windows Update, then re-run."
    }
}

function Get-WindowsArch {
    try {
        if ((Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1).Architecture -eq 12) { return 'arm64' }
    } catch { Write-Verbose 'Falling back to the environment for the CPU architecture.' }
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { return 'arm64' }
    'amd64'
}

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# The person signed in at the console (Docker Desktop and the login items are
# theirs), even when UAC elevated this script under a different admin account.
# Returns @{ Name; Sid; Profile } or $null.
function Get-DesktopUser {
    $name = $null
    try { $name = (Get-CimInstance -ClassName Win32_ComputerSystem).UserName } catch { $name = $null }
    if (-not $name) {
        # Remote Desktop sessions: the owner of this session's Explorer.
        try {
            $sessionId = (Get-Process -Id $PID).SessionId
            $explorer = Get-CimInstance -ClassName Win32_Process -Filter "Name='explorer.exe' AND SessionId=$sessionId" | Select-Object -First 1
            if ($explorer) {
                $owner = Invoke-CimMethod -InputObject $explorer -MethodName GetOwner
                if ($owner.User) { $name = "$($owner.Domain)\$($owner.User)" }
            }
        } catch { $name = $null }
    }
    if (-not $name) { return $null }
    try {
        $sid = (New-Object Security.Principal.NTAccount $name).Translate([Security.Principal.SecurityIdentifier]).Value
    } catch { return $null }
    $userProfile = Get-CimInstance -ClassName Win32_UserProfile -Filter "SID='$sid'" -ErrorAction SilentlyContinue
    $profilePath = $null
    if ($userProfile) { $profilePath = $userProfile.LocalPath }
    @{ Name = $name; Sid = $sid; Profile = $profilePath }
}

# Chrome first, then Edge (always there on Windows 10/11).
function Find-Browser {
    param([string]$UserProfile)
    $localAppData = $env:LOCALAPPDATA
    if ($UserProfile) { $localAppData = $UserProfile + '\AppData\Local' }
    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$localAppData\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    )
    foreach ($c in $candidates) {
        if (Test-Path -Path $c -PathType Leaf) { return $c }
    }
    ''
}

# -- Elevation ----------------------------------------------------------------
function ConvertTo-PsLiteral { param([string]$Value) "'" + $Value.Replace("'", "''") + "'" }

# The command the elevated PowerShell runs: the kiosk environment (an elevated
# process doesn't inherit it), then this script with the same parameters.
function Get-ElevationCommand {
    param([Parameter(Mandatory = $true)][string]$ScriptPath, [hashtable]$Parameters = @{})
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($n in $KioskEnvNames) {
        $v = [Environment]::GetEnvironmentVariable($n)
        if ($v) { $lines.Add("`$env:$n = $(ConvertTo-PsLiteral $v)") }
    }
    $lines.Add("`$env:KIOSK_ELEVATED_CHILD = '1'")
    $call = "& $(ConvertTo-PsLiteral $ScriptPath)"
    foreach ($k in ($Parameters.Keys | Sort-Object)) {
        $v = $Parameters[$k]
        if ($v -is [switch] -or $v -is [bool]) {
            if ([bool]$v) { $call += " -$k" }
        } elseif ($null -ne $v -and "$v" -ne '') {
            $call += " -$k $(ConvertTo-PsLiteral ([string]$v))"
        }
    }
    $lines.Add($call)
    $lines.Add('exit $LASTEXITCODE')
    $lines -join "`n"
}

# This script as a file: itself, or (under irm | iex, where there is no file)
# a copy fetched from the same ref into %TEMP%.
function Get-SelfScriptPath {
    if ($SelfPath -and (Test-Path -LiteralPath $SelfPath -PathType Leaf)) { return $SelfPath }
    if (-not $env:KIOSK_INSTALLER_REF -and -not $env:KIOSK_TEMPLATE_DIR) {
        Write-Info 'Using the installer from the main branch (set KIOSK_INSTALLER_REF to use another).'
    }
    $tmp = Join-Path $env:TEMP 'serversherpa-kiosk-install.ps1'
    Write-TextFile -Path $tmp -Text (Get-CompanionText -Name 'install.ps1')
    $tmp
}

# Assert-Admin: $null when already elevated; otherwise runs this script
# elevated (UAC) with the same parameters and returns its exit code.
function Assert-Admin {
    param([hashtable]$Parameters = @{})
    if (Test-IsAdmin) { return $null }
    $script = Get-SelfScriptPath
    $command = Get-ElevationCommand -ScriptPath $script -Parameters $Parameters
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    Write-Info 'Administrator rights are needed; Windows will ask for permission. The install continues in a new window.'
    try {
        $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru `
            -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded)
    } catch {
        throw 'Administrator rights were not granted. Re-run and choose Yes when Windows asks.'
    }
    $p.ExitCode
}

# -- Configuration ------------------------------------------------------------
function Remove-TrailingSlash {
    param([string]$Value)
    if ($null -eq $Value) { return '' }
    $Value.TrimEnd('/')
}

# Get-PortalUrl: replace a leading api. host label with portal.
function Get-PortalUrl {
    param([string]$ApiUrl)
    $u = Remove-TrailingSlash $ApiUrl
    if ($u -match '^(https?://)api\.(.+)$') { return "$($Matches[1])portal.$($Matches[2])" }
    ''
}

# Read-KioskConfig: KEY=value lines into a hashtable, without running anything.
function Read-KioskConfig {
    param([Parameter(Mandatory = $true)][string]$Path)
    $h = @{}
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $h }
    foreach ($line in [IO.File]::ReadAllLines($Path)) {
        $line = $line.TrimEnd("`r")
        if ($line -match '^([A-Z_][A-Z0-9_]*)=(.*)$' -and -not $h.ContainsKey($Matches[1])) {
            $h[$Matches[1]] = $Matches[2]
        }
    }
    $h
}

# Merge-KioskConfig: options beat the saved config beat the defaults.
# Options: ApiUrl, PortalUrl, Channel, DataDir, Browser.
function Merge-KioskConfig {
    param([hashtable]$Saved = @{}, [hashtable]$Options = @{})
    $optApi = Remove-TrailingSlash $Options.ApiUrl
    $savedApi = Remove-TrailingSlash $Saved.EDGE_CLOUD_API_URL
    $changed = ($optApi -ne '') -and ($optApi -ne $savedApi)
    $api = $optApi
    if (-not $api) { $api = $savedApi }
    if (-not $api) { $api = $DefaultApiUrl }

    $portal = Remove-TrailingSlash $Saved.EDGE_PORTAL_URL
    if ($Options.PortalUrl) {
        $portal = Remove-TrailingSlash $Options.PortalUrl
    } elseif ($changed -or -not $portal) {
        # Re-derive only when the API URL changed (or nothing was saved).
        $portal = Get-PortalUrl -ApiUrl $api
        if (-not $portal) {
            Write-Warn "Can't derive a portal URL from $api; links to the portal won't work until you pass -PortalUrl."
        }
    }

    $ch = $Options.Channel
    if (-not $ch) { $ch = $Saved.KIOSK_CHANNEL }
    if (-not $ch) { $ch = 'stable' }
    if ($ch -cne 'stable' -and $ch -cne 'edge') { throw "Unknown channel '$ch' (use stable or edge)." }

    # Data folder: environment, then saved config, then the default.
    $data = $Options.DataDir
    if (-not $data) { $data = $env:KIOSK_DATA_DIR }
    if (-not $data) { $data = $Saved.KIOSK_DATA_DIR }
    if (-not $data) { $data = (Get-KioskPaths).Data }

    $browser = $Options.Browser
    if ($null -eq $browser) { $browser = $Saved.KIOSK_BROWSER }
    if ($null -eq $browser) { $browser = '' }

    @{
        EDGE_CLOUD_API_URL = $api
        EDGE_PORTAL_URL    = $portal
        KIOSK_CHANNEL      = $ch
        KIOSK_DATA_DIR     = $data
        KIOSK_BROWSER      = $browser
    }
}

# A value goes into an env file read by compose: no newline, quote or $.
function Test-ConfigValue {
    param([string]$Name, [AllowEmptyString()][string]$Value)
    if ($Value -match '[\r\n''"$]') { throw "$Name contains a newline, quote or `$ character, which isn't allowed." }
}

# The data folder also lands in a YAML string and a host:/data volume spec.
function Test-KioskDataDir {
    param([AllowEmptyString()][string]$Path)
    if (-not $Path) { throw 'The data folder (KIOSK_DATA_DIR) is empty.' }
    Test-ConfigValue -Name 'Data folder' -Value $Path
    if ($Path -notmatch '^[A-Za-z]:[\\/]') { throw "The data folder must be a full path such as C:\Kiosk\data (got '$Path')." }
    if ($Path.Substring(2).Contains(':')) { throw "The data folder can't contain a colon except after the drive letter: $Path" }
}

# Administrators and SYSTEM full control, signed-in users read; inheritance off.
function Set-KioskFileAcl {
    param([Parameter(Mandatory = $true)][string]$Path)
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($r in @(@('S-1-5-32-544', 'FullControl'), @('S-1-5-18', 'FullControl'), @('S-1-5-32-545', 'ReadAndExecute'))) {
        $sid = New-Object Security.Principal.SecurityIdentifier $r[0]
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule $sid, $r[1], 'Allow'))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

# Set-KioskDirAcl PATH [USERSID] [-UsersRead]: Administrators + SYSTEM full
# control, plus the given user (full control) and/or Users (read); inherited
# by everything inside; the parent's permissions are not inherited.
function Set-KioskDirAcl {
    param([Parameter(Mandatory = $true)][string]$Path, [string]$UserSid, [switch]$UsersRead)
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $rules = @(@('S-1-5-32-544', 'FullControl'), @('S-1-5-18', 'FullControl'))
    if ($UserSid) { $rules += , @($UserSid, 'FullControl') }
    if ($UsersRead) { $rules += , @('S-1-5-32-545', 'ReadAndExecute') }
    foreach ($r in $rules) {
        $sid = New-Object Security.Principal.SecurityIdentifier $r[0]
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule $sid, $r[1], 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

# Write-KioskConfig: the settings plus the browser the launcher opens. No
# secrets in it: readable by users (the nightly update runs as the signed-in user).
function Write-KioskConfig {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][hashtable]$Config, [switch]$SkipAcl)
    Test-ConfigValue -Name 'API URL' -Value $Config.EDGE_CLOUD_API_URL
    Test-ConfigValue -Name 'Portal URL' -Value $Config.EDGE_PORTAL_URL
    Test-ConfigValue -Name 'Channel' -Value $Config.KIOSK_CHANNEL
    Test-ConfigValue -Name 'Browser' -Value $Config.KIOSK_BROWSER
    Test-KioskDataDir -Path $Config.KIOSK_DATA_DIR
    $text = ''
    foreach ($k in @('EDGE_CLOUD_API_URL', 'EDGE_PORTAL_URL', 'KIOSK_CHANNEL', 'KIOSK_DATA_DIR', 'KIOSK_BROWSER')) {
        $text += "$k=$($Config[$k])`n"
    }
    Write-TextFile -Path $Path -Text $text
    if (-not $SkipAcl) { Set-KioskFileAcl -Path $Path }
}

function Get-ImageRef {
    param([string]$Channel)
    if ($env:KIOSK_IMAGE) { return $env:KIOSK_IMAGE }
    "ghcr.io/encondata/serversherpa-kiosk-laptop:$Channel"
}

# Get-ComposeText: the runtime compose file from the template. The data folder
# is written with forward slashes (C:/ProgramData/...), which Docker Desktop accepts.
function Get-ComposeText {
    param([Parameter(Mandatory = $true)][string]$ImageRef, [Parameter(Mandatory = $true)][string]$DataDir)
    Test-ConfigValue -Name 'Image' -Value $ImageRef
    Test-KioskDataDir -Path $DataDir
    $tpl = Get-CompanionText -Name 'docker-compose.yml'
    $tpl.Replace('__IMAGE__', $ImageRef).Replace('__DATA_DIR__', $DataDir.Replace('\', '/'))
}

# -- Resume after restart -------------------------------------------------------
function Save-ResumeState {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Step, [hashtable]$Arguments = @{})
    $plain = @{}
    foreach ($k in $Arguments.Keys) {
        $v = $Arguments[$k]
        if ($v -is [switch]) { $v = $v.IsPresent }
        $plain[$k] = $v
    }
    $json = (@{ step = $Step; arguments = $plain } | ConvertTo-Json -Depth 5)
    Write-TextFile -Path $Path -Text $json
}

# Read-ResumeState: { step, arguments } with arguments as a hashtable
# (built by hand: Windows PowerShell 5.1 has no ConvertFrom-Json -AsHashtable).
function Read-ResumeState {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $o = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
    $h = @{}
    if ($o.arguments) {
        foreach ($p in $o.arguments.PSObject.Properties) { $h[$p.Name] = $p.Value }
    }
    [pscustomobject]@{ step = [string]$o.step; arguments = $h }
}

function Get-ResumeCommand {
    param([Parameter(Mandatory = $true)][string]$InstallDir)
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\install.ps1`" -Resume"
}

# Save-InstallerCopy: this script into the install folder (RunOnce runs that copy).
function Save-InstallerCopy {
    param([Parameter(Mandatory = $true)][string]$InstallDir)
    $dest = Join-Path $InstallDir 'install.ps1'
    if ($SelfPath -and (Test-Path -LiteralPath $SelfPath -PathType Leaf)) {
        if ((Resolve-Path -LiteralPath $SelfPath).Path -ne $dest) { Copy-Item -LiteralPath $SelfPath -Destination $dest -Force }
    } else {
        Write-TextFile -Path $dest -Text (Get-CompanionText -Name 'install.ps1')
    }
}

function Register-Resume {
    param([Parameter(Mandatory = $true)][string]$InstallDir)
    Save-InstallerCopy -InstallDir $InstallDir
    if (-not (Test-Path -LiteralPath $RunOnceKey)) { New-Item -Path $RunOnceKey -Force | Out-Null }
    Set-ItemProperty -LiteralPath $RunOnceKey -Name $ResumeValueName -Value (Get-ResumeCommand -InstallDir $InstallDir)
}

function Remove-ResumeRegistration {
    param([string]$InstallDir)
    if (Test-IsWindows) {
        Remove-ItemProperty -LiteralPath $RunOnceKey -Name $ResumeValueName -ErrorAction SilentlyContinue
    }
    if ($InstallDir) {
        $state = Join-Path $InstallDir 'install-state.json'
        if (Test-Path -LiteralPath $state) { Remove-Item -LiteralPath $state -Force }
    }
}

# Stop here until Windows restarts (or the user signs in again); the install
# continues on its own at the next sign-in.
function Stop-ForRestart {
    param([string]$InstallDir, [string]$Step, [hashtable]$Arguments, [string]$Message)
    Save-ResumeState -Path (Join-Path $InstallDir 'install-state.json') -Step $Step -Arguments $Arguments
    Register-Resume -InstallDir $InstallDir
    Request-Restart -Message $Message
}

# -- Docker ---------------------------------------------------------------------
# Invoke-Docker -Arguments ARGS [-Stream]: every docker call goes through here
# (Pester mocks it). Throws when docker fails; returns its output otherwise.
# -Stream shows the output (pull progress) instead of returning it.
function Invoke-Docker {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string[]]$Arguments, [switch]$Stream)
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'The docker command was not found.' }
    $eap = $ErrorActionPreference
    # Windows PowerShell 5.1 turns native stderr lines into errors under Stop.
    $ErrorActionPreference = 'Continue'
    $out = @()
    try {
        if ($Stream) {
            & docker @Arguments | Out-Host
        } else {
            $out = @(& docker @Arguments 2>&1 | ForEach-Object { "$_" })
        }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $eap
    }
    if ($code -ne 0) { throw "docker $($Arguments -join ' ') failed (exit $code). $($out -join ' ')" }
    $out
}

function Test-DockerEngine {
    try { Invoke-Docker -Arguments @('version') | Out-Null; $true } catch { $false }
}

function Test-DockerInstalled {
    [bool](Get-Command docker -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath $DockerDesktopExe -PathType Leaf)
}

# Docker Desktop's CLI folder on PATH for this process (a fresh install isn't there yet).
function Add-DockerToPath {
    if ((Test-Path -LiteralPath $DockerBinDir) -and -not (($env:Path -split ';') -contains $DockerBinDir)) {
        $env:Path = "$env:Path;$DockerBinDir"
    }
}

# Virtualization must be on in the firmware (or a hypervisor already running,
# which hides the firmware flag).
function Assert-Virtualization {
    $hv = $false
    try { $hv = [bool](Get-CimInstance -ClassName Win32_ComputerSystem).HypervisorPresent } catch { $hv = $false }
    if ($hv) { return }
    $fw = $false
    try { $fw = [bool]((Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1).VirtualizationFirmwareEnabled) } catch { $fw = $false }
    if ($fw) { return }
    throw ("Virtualization is turned off in this PC's firmware, and Docker needs it. Restart into the BIOS/UEFI setup " +
        "(usually F2, F10, F12 or Del while the PC starts), turn on Intel VT-x / Intel Virtualization Technology or " +
        "AMD-V / SVM Mode, save, start Windows, then re-run this command.")
}

function Test-WslFeaturesPending {
    foreach ($f in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
        try {
            $s = (Get-WindowsOptionalFeature -Online -FeatureName $f -ErrorAction Stop).State
            if ("$s" -ne 'Enabled') { return $true }
        } catch { Write-Verbose "Couldn't read the state of $f." }
    }
    $false
}

# Invoke-Wsl ARGS: wsl.exe output as text (UTF-8 via WSL_UTF8) and its exit code.
function Invoke-Wsl {
    param([string[]]$Arguments)
    $env:WSL_UTF8 = '1'
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = (& wsl.exe @Arguments 2>&1 | ForEach-Object { "$_" }) -join "`n"
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $eap }
    @{ Output = ($out -replace "`0", ''); ExitCode = $code }
}

# Enable-Wsl: WSL2 without a distribution. Returns $true when Windows must
# restart before Docker Desktop can use it.
function Enable-Wsl {
    $status = $null
    try { $status = Invoke-Wsl -Arguments @('--status') } catch { $status = $null }
    if ($status -and $status.ExitCode -eq 0 -and -not (Test-WslFeaturesPending)) {
        Write-Info 'WSL2 is on.'
        return $false
    }
    Write-Info 'Turning on WSL2 (Windows Subsystem for Linux)'
    $r = $null
    try { $r = Invoke-Wsl -Arguments @('--install', '--no-distribution') } catch { $r = $null }
    if ($r -and ($r.ExitCode -eq 3010 -or $r.Output -match 'restart|reboot')) { return $true }
    if (-not $r -or $r.ExitCode -ne 0) {
        # Older wsl.exe without --no-distribution: turn the features on directly.
        Write-Info 'Turning on the Windows features WSL2 needs'
        $restart = $false
        foreach ($f in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
            try {
                $res = Enable-WindowsOptionalFeature -Online -FeatureName $f -All -NoRestart -ErrorAction Stop
                if ($res.RestartNeeded) { $restart = $true }
            } catch {
                throw "Couldn't turn on $f. Run Windows Update, then re-run. ($($_.Exception.Message))"
            }
        }
        if ($restart) { return $true }
    }
    Test-WslFeaturesPending
}

function Test-DockerUsersMember {
    param([Parameter(Mandatory = $true)][string]$Sid)
    try {
        $members = Get-LocalGroupMember -Group 'docker-users' -ErrorAction Stop
        return [bool]($members | Where-Object { $_.SID -and $_.SID.Value -eq $Sid })
    } catch { return $false }
}

function Add-DockerUsersMember {
    param([Parameter(Mandatory = $true)][string]$Name)
    try {
        Add-LocalGroupMember -Group 'docker-users' -Member $Name -ErrorAction Stop
    } catch {
        & net.exe localgroup docker-users $Name /add | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Warn "Couldn't add $Name to the docker-users group; add them in Computer Management, then sign out and back in." }
    }
}

# Install-DockerDesktop: WSL2 (restart and resume if needed), Docker Desktop,
# and the signed-in user in docker-users (sign out and resume if newly added).
function Install-DockerDesktop {
    param([Parameter(Mandatory = $true)][string]$InstallDir, [hashtable]$ResumeArguments = @{}, $DesktopUser)
    if ((Get-Command docker -ErrorAction SilentlyContinue) -or (Test-DockerInstalled) -or (Test-DockerEngine)) {
        Write-Info 'Docker Desktop is installed.'
        return
    }
    Assert-Virtualization
    if (Enable-Wsl) {
        Stop-ForRestart -InstallDir $InstallDir -Step 'docker' -Arguments $ResumeArguments `
            -Message 'WSL2 was turned on and Windows needs to restart. Restart now; the install continues on its own after you sign in again.'
    }
    $wasMember = $true
    if ($DesktopUser) { $wasMember = Test-DockerUsersMember -Sid $DesktopUser.Sid }

    $arch = Get-WindowsArch
    $url = "https://desktop.docker.com/win/main/$arch/Docker%20Desktop%20Installer.exe"
    $exe = Join-Path $env:TEMP 'Docker Desktop Installer.exe'
    Write-Info "Downloading Docker Desktop ($arch)"
    Enable-Tls12
    try {
        Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing
    } catch {
        throw "Couldn't download Docker Desktop. Check the network, then re-run."
    }
    try {
        $sig = Get-AuthenticodeSignature -FilePath $exe
        if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Docker Inc') {
            throw "The Docker Desktop download isn't signed by Docker (signature: $($sig.Status)). Re-run; if it happens again, check for a proxy changing downloads."
        }
        Write-Info 'Installing Docker Desktop (this takes a few minutes)'
        $p = Start-Process -FilePath $exe -ArgumentList @('install', '--quiet', '--accept-license', '--backend=wsl-2') -Wait -PassThru
        if ($p.ExitCode -eq 3010) {
            Stop-ForRestart -InstallDir $InstallDir -Step 'engine' -Arguments $ResumeArguments `
                -Message 'Docker Desktop was installed and Windows needs to restart. Restart now; the install continues on its own after you sign in again.'
        }
        if ($p.ExitCode -ne 0) { throw "Docker Desktop didn't install (exit code $($p.ExitCode)). Restart Windows, then re-run." }
    } finally {
        Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
    }
    Add-DockerToPath
    if ($DesktopUser -and -not $wasMember) {
        Add-DockerUsersMember -Name $DesktopUser.Name
        # Group membership counts only from the next sign-in; Docker Desktop refuses to start before that.
        Stop-ForRestart -InstallDir $InstallDir -Step 'engine' -Arguments $ResumeArguments `
            -Message "$($DesktopUser.Name) was added to the docker-users group. Sign out and back in (or restart); the install continues on its own after you sign in."
    }
}

# Set-DockerAutostart PATH: "AutoStart": true in Docker Desktop's
# settings-store.json, every other key kept, written via a temp file.
function Set-DockerAutostart {
    param([Parameter(Mandatory = $true)][string]$Path)
    $manual = 'In Docker Desktop > Settings > General, turn on Start Docker Desktop when you sign in.'
    try {
        $dir = Split-Path -Parent $Path
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $data = $null
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            $raw = [IO.File]::ReadAllText($Path)
            if ($raw.Trim()) { $data = $raw | ConvertFrom-Json }
            if ($null -ne $data -and -not ($data -is [Management.Automation.PSCustomObject])) {
                Write-Warn "$Path isn't a settings object; left it alone. $manual"
                return
            }
        }
        if ($null -eq $data) { $data = New-Object PSObject }
        $data | Add-Member -NotePropertyName 'AutoStart' -NotePropertyValue $true -Force
        Write-TextFile -Path $Path -Text ($data | ConvertTo-Json -Depth 32)
    } catch {
        Write-Warn "Couldn't update $Path. $manual"
    }
}

# Start Docker Desktop as the signed-in user (never elevated): a one-time
# scheduled task running in their session.
function Start-DockerDesktopAsUser {
    param($DesktopUser)
    if (-not (Test-Path -LiteralPath $DockerDesktopExe)) { Write-Warn "Docker Desktop isn't at $DockerDesktopExe; start it from the Start menu."; return }
    $task = 'ServerSherpa Kiosk Start Docker'
    try {
        if (-not $DesktopUser) { throw 'no desktop user' }
        $action = New-ScheduledTaskAction -Execute $DockerDesktopExe
        $principal = New-ScheduledTaskPrincipal -UserId $DesktopUser.Name -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Force | Out-Null
        Start-ScheduledTask -TaskName $task
        Start-Sleep -Seconds 3
        Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
    } catch {
        try { Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$DockerDesktopExe`"" }
        catch { Write-Warn "Couldn't start Docker Desktop; open it from the Start menu." }
    }
}

# Enable-DockerAutostart: Docker Desktop starts at sign-in from now on, and now.
function Enable-DockerAutostart {
    param($DesktopUser)
    if ($DesktopUser -and $DesktopUser.Profile) {
        Set-DockerAutostart -Path (Join-Path $DesktopUser.Profile 'AppData\Roaming\Docker\settings-store.json')
    } else {
        Write-Warn 'No signed-in user found. In Docker Desktop > Settings > General, turn on Start Docker Desktop when you sign in.'
    }
    if (-not (Test-DockerEngine)) {
        Write-Info 'Starting Docker Desktop'
        Start-DockerDesktopAsUser -DesktopUser $DesktopUser
    }
}

function Wait-DockerEngine {
    param([int]$Seconds = 180, [int]$PollSeconds = 3)
    Write-Info "Waiting for the Docker engine (up to $([math]::Ceiling($Seconds / 60)) minutes)"
    $deadline = (Get-Date).AddSeconds($Seconds)
    while (-not (Test-DockerEngine)) {
        if ((Get-Date) -ge $deadline) {
            throw "Docker didn't start $Dash open Docker Desktop once, accept any prompt, then re-run this command."
        }
        Start-Sleep -Seconds $PollSeconds
    }
}

function Assert-Compose {
    try { Invoke-Docker -Arguments @('compose', 'version') | Out-Null }
    catch { throw "Docker Compose isn't available to Docker Desktop. Update or reinstall Docker Desktop, then re-run." }
}

# -- Data folder ----------------------------------------------------------------
# New-KioskDataDir: made once (Administrators, SYSTEM and the Docker Desktop
# user, who shares it into the engine), never touched again.
function New-KioskDataDir {
    param([Parameter(Mandatory = $true)][string]$DataDir, $DesktopUser)
    if (Test-Path -LiteralPath $DataDir -PathType Container) { return }
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
    $sid = $null
    if ($DesktopUser) { $sid = $DesktopUser.Sid } else { Write-Warn "No signed-in user found; only administrators can read $DataDir." }
    Set-KioskDirAcl -Path $DataDir -UserSid $sid
}

function Get-LegacyDataDir {
    param([string]$UserProfile)
    if ($env:EDGE_DATA_HOST_DIR) { return $env:EDGE_DATA_HOST_DIR }
    if (-not $UserProfile) { $UserProfile = $HOME }
    $UserProfile + '\ServerSherpaKiosk'
}

# The phase-1 manual install holds port 8090.
function Stop-LegacyKiosk {
    try { Invoke-Docker -Arguments @('compose', '-p', $LegacyProject, 'stop') | Out-Null }
    catch { Write-Verbose 'No phase-1 kiosk to stop.' }
}

# Copy-LegacyKioskData: one-time copy of the phase-1 data into an absent or
# completely empty data folder, so nothing is ever overwritten. $true if copied.
function Copy-LegacyKioskData {
    param([Parameter(Mandatory = $true)][string]$LegacyDir, [Parameter(Mandatory = $true)][string]$DataDir)
    if (-not (Test-Path -LiteralPath (Join-Path $LegacyDir 'identity.json') -PathType Leaf)) { return $false }
    if ((Test-Path -LiteralPath $DataDir -PathType Container) -and
        (Get-ChildItem -LiteralPath $DataDir -Force | Select-Object -First 1)) {
        Write-Info "Keeping the existing data in $DataDir (earlier kiosk data in $LegacyDir was not copied)."
        return $false
    }
    Write-Info "Found the earlier kiosk data in $LegacyDir; copying it to $DataDir"
    Stop-LegacyKiosk
    if (-not (Test-Path -LiteralPath $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
    Get-ChildItem -LiteralPath $LegacyDir -Force | Copy-Item -Destination $DataDir -Recurse -Force
    Write-Info "The old folder $LegacyDir was left in place; you can delete it once the kiosk works."
    $true
}

# -- Start ----------------------------------------------------------------------
function Get-KioskJson {
    param([string]$Path)
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:8090$Path" -UseBasicParsing -TimeoutSec 5
        return ($r.Content | ConvertFrom-Json)
    } catch { return $null }
}

# Start-Kiosk: pull, start, wait until healthy, return /edge/identity (or $null).
function Start-Kiosk {
    param([Parameter(Mandatory = $true)][string]$InstallDir, [int]$TimeoutSeconds = 120, [int]$PollSeconds = 3)
    $compose = Join-Path $InstallDir 'docker-compose.yml'
    Stop-LegacyKiosk
    Write-Info 'Downloading the kiosk image'
    try { Invoke-Docker -Arguments @('compose', '-f', $compose, 'pull') -Stream }
    catch { throw "Couldn't download the kiosk image. Check the network, then re-run." }
    Write-Info 'Starting the kiosk'
    try { Invoke-Docker -Arguments @('compose', '-f', $compose, 'up', '-d') -Stream }
    catch { throw "The kiosk didn't start. See the messages above, then re-run." }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ($true) {
        $status = ''
        try { $status = (Invoke-Docker -Arguments @('inspect', '-f', '{{.State.Health.Status}}', $KioskContainer)) -join '' } catch { $status = '' }
        if ($status.Trim() -eq 'healthy') { break }
        if ((Get-Date) -ge $deadline) {
            $shown = $status.Trim()
            if (-not $shown) { $shown = 'unknown' }
            throw "The kiosk didn't become healthy in time (status: $shown). See: docker compose -f `"$compose`" logs edge"
        }
        Start-Sleep -Seconds $PollSeconds
    }
    $identity = Get-KioskJson -Path '/edge/identity'
    if (-not $identity) { Write-Warn "The kiosk is running but didn't answer $KioskUrl/edge/identity yet." }
    Write-Info 'The kiosk is running.'
    $identity
}

# -- Login items (Task 6 fills these in) -----------------------------------------
# Install-LoginItems: update.ps1/launch.ps1, the nightly update task, the
# Startup-folder launcher and the Desktop/Start menu shortcuts.
function Install-LoginItems {
    param([string]$InstallDir, $DesktopUser)
    Write-Verbose "Login items for $InstallDir ($($DesktopUser.Name)) are not set up yet."
}

# Remove-LoginItems: undo Install-LoginItems (and stop a running update).
function Remove-LoginItems {
    param([string]$InstallDir, $DesktopUser)
    Write-Verbose "No login items to remove for $InstallDir ($($DesktopUser.Name)) yet."
}

# -- Settings -------------------------------------------------------------------
# Read-KioskSettings: ask for the URLs nobody has set yet. Returns the options, updated.
function Read-KioskSettings {
    param([hashtable]$Saved, [hashtable]$Options)
    $needApi = -not $Options.ApiUrl -and -not $Saved.EDGE_CLOUD_API_URL
    $needPortal = -not $Options.PortalUrl -and -not $Saved.EDGE_PORTAL_URL
    if (-not ($needApi -or $needPortal) -or -not (Test-Interactive)) { return $Options }
    if ($needApi) {
        $a = Read-Answer -Prompt "ServerSherpa API URL [$DefaultApiUrl]"
        if (-not $a) { $a = $DefaultApiUrl }
        $Options.ApiUrl = $a
    }
    if ($needPortal) {
        $api = $Options.ApiUrl
        if (-not $api) { $api = $Saved.EDGE_CLOUD_API_URL }
        if (-not $api) { $api = $DefaultApiUrl }
        $derived = Get-PortalUrl -ApiUrl $api
        $shown = $derived
        if (-not $shown) { $shown = 'none' }
        $a = Read-Answer -Prompt "Portal URL [$shown]"
        if ($a) { $Options.PortalUrl = $a }
    }
    $Options
}

function Test-ApiReachable {
    param([string]$ApiUrl)
    try {
        Invoke-WebRequest -Uri "$ApiUrl/system/status" -UseBasicParsing -TimeoutSec 5 | Out-Null
        Write-Info "ServerSherpa answers at $ApiUrl"
    } catch {
        Write-Warn "Couldn't reach $ApiUrl/system/status. Continuing; the kiosk works offline and connects once the network is up."
    }
}

# -- Summary --------------------------------------------------------------------
function Write-Summary {
    param($Identity, [hashtable]$Config, [string]$InstallDir)
    $serial = 'unknown'; $name = 'unknown'; $version = 'unknown'
    if ($Identity) {
        if ($Identity.serial) { $serial = $Identity.serial }
        if ($Identity.name) { $name = $Identity.name }
    }
    $status = Get-KioskJson -Path '/edge/status'
    if ($status -and $status.version) { $version = $status.version }
    Write-Host ''
    Write-Info 'The ServerSherpa kiosk is installed.'
    Write-Host "  Serial:   $serial"
    Write-Host "  Name:     $name"
    Write-Host "  Open:     $KioskUrl"
    Write-Host "  Channel:  $($Config.KIOSK_CHANNEL) (version $version); updates nightly at 03:00"
    Write-Host "  Log:      $InstallDir\install.log"
    Write-Host ''
    Write-Host 'Next: sign in online on the kiosk, then open Kiosk Setup.'
    Write-Host 'The kiosk opens when someone signs in to Windows (Docker Desktop only runs then).'
    Write-Host 'For an unattended station, turn on automatic sign-in for that account'
    Write-Host '(for example with Sysinternals Autologon).'
    Write-Host 'USB label printers: Chrome/Edge reach a Zebra printer over WebUSB only after its'
    Write-Host 'driver is switched to WinUSB (for example with Zadig).'
}

# -- Uninstall ------------------------------------------------------------------
# Assert-SafeRemovePath LABEL PATH: refuse paths it would be dangerous to
# remove: empty, relative, a drive root, fewer than two components, . or ..
function Assert-SafeRemovePath {
    param([string]$Label, [AllowEmptyString()][string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { throw "$Label is empty; refusing to continue." }
    $p = $Path.Replace('\', '/')
    $min = 2
    if ($p.StartsWith('//')) {
        $rest = $p.Substring(2); $min = 4                  # \\server\share\a\b
    } elseif ($p -match '^[A-Za-z]:') {
        if ($p -notmatch '^[A-Za-z]:/') { throw "$Label must be a full path (got '$Path'); refusing to continue." }
        $rest = $p.Substring(3)
    } elseif ($p.StartsWith('/')) {
        $rest = $p.Substring(1)
    } else {
        throw "$Label must be a full path (got '$Path'); refusing to continue."
    }
    $parts = @($rest.Split('/') | Where-Object { $_ -ne '' })
    foreach ($part in $parts) {
        if ($part -eq '.' -or $part -eq '..') { throw "$Label can't contain . or .. parts ($Path); refusing to continue." }
    }
    if ($parts.Count -lt $min) { throw "$Label '$Path' is too close to the top of the disk; refusing to continue." }
}

# A folder only counts as kiosk data when it is empty or holds kiosk files.
function Test-LooksLikeKioskData {
    param([string]$Path)
    if (-not (Get-ChildItem -LiteralPath $Path -Force | Select-Object -First 1)) { return $true }
    foreach ($f in @('identity.json', 'edge.db', 'edge.key')) {
        if (Test-Path -LiteralPath (Join-Path $Path $f)) { return $true }
    }
    $false
}

function Confirm-Purge {
    param([string]$DataDir)
    $ans = $env:KIOSK_CONFIRM_PURGE
    if (-not $ans) {
        if (-not (Test-Interactive)) {
            throw 'Deleting the data folder needs confirmation: run in a PowerShell window, or set KIOSK_CONFIRM_PURGE=DELETE.'
        }
        Write-Host "This deletes ${DataDir}: the kiosk identity and any scans not yet uploaded."
        $ans = Read-Answer -Prompt 'Type DELETE to delete it'
    }
    if ($ans -cne 'DELETE') { throw 'Not confirmed; nothing was removed.' }
}

# Stop-KioskForUninstall: compose down, or stop before any file is removed if
# the container may still be there (Docker Desktop would bring it back).
function Stop-KioskForUninstall {
    param([Parameter(Mandatory = $true)][string]$ComposeFile)
    if (-not (Test-DockerInstalled)) {
        Write-Warn "Docker isn't installed, so there is no kiosk container to stop; continuing."
        return
    }
    Add-DockerToPath
    $removed = 'the update task and launcher were already removed; re-running the installer puts them back'
    try { Invoke-Docker -Arguments @('compose', '-f', $ComposeFile, 'down') | Out-Null; return } catch { Write-Verbose 'compose down failed.' }
    if (-not (Test-DockerEngine)) {
        throw "Docker isn't running $Dash start Docker Desktop and re-run -Uninstall ($removed)"
    }
    $exists = $true
    try { Invoke-Docker -Arguments @('inspect', $KioskContainer) | Out-Null } catch { $exists = $false }
    if ($exists) {
        throw "Couldn't remove the kiosk container $KioskContainer $Dash check Docker Desktop, then re-run -Uninstall ($removed)"
    }
}

function Uninstall-Kiosk {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$InstallDir,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$DataDir,
        [switch]$PurgeData, $DesktopUser)
    Assert-SafeRemovePath -Label 'The install folder (KIOSK_DIR)' -Path $InstallDir
    Assert-SafeRemovePath -Label 'The data folder (KIOSK_DATA_DIR)' -Path $DataDir
    if ($PurgeData -and (Test-Path -LiteralPath $DataDir -PathType Container)) {
        if (-not (Test-LooksLikeKioskData -Path $DataDir)) {
            throw "$DataDir doesn't look like kiosk data (no identity.json or edge.db); refusing to delete it."
        }
        Confirm-Purge -DataDir $DataDir
    }
    Write-Info 'Removing the ServerSherpa kiosk'
    # The update task first, so it can't restart the container in between.
    Remove-LoginItems -InstallDir $InstallDir -DesktopUser $DesktopUser
    Remove-ResumeRegistration -InstallDir $InstallDir
    $compose = Join-Path $InstallDir 'docker-compose.yml'
    if (Test-Path -LiteralPath $compose -PathType Leaf) {
        Stop-KioskForUninstall -ComposeFile $compose
    }
    foreach ($f in @('docker-compose.yml', 'config.env', 'install.ps1', 'update.ps1', 'launch.ps1', 'install-state.json', 'update-state.json')) {
        $p = Join-Path $InstallDir $f
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
    }
    Write-Info "Removed the kiosk from $InstallDir (install.log was kept). Docker stays installed."
    if ($PurgeData) {
        if (Test-Path -LiteralPath $DataDir -PathType Container) {
            Remove-Item -LiteralPath $DataDir -Recurse -Force
            Write-Info "Deleted the data folder $DataDir."
        }
    } else {
        Write-Info "Kept the data folder $DataDir. It holds the kiosk's identity (its serial and key) and any scans not yet uploaded; reinstalling picks it up again. To delete it too: -Uninstall -PurgeData."
    }
}

# -- Main -----------------------------------------------------------------------
function Start-InstallLog {
    param([string]$InstallDir)
    try {
        Start-Transcript -Path (Join-Path $InstallDir 'install.log') -Append | Out-Null
        return $true
    } catch { return $false }
}

# Invoke-KioskInstaller: returns the exit code. Mirrors install.sh's main.
function Invoke-KioskInstaller {
    param([hashtable]$Parameters = @{})
    $ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest's progress bar slows 5.1 downloads badly
    $ErrorActionPreference = 'Stop'
    $logging = $false
    try {
        if ($Parameters.PurgeData -and -not $Parameters.Uninstall) { throw '-PurgeData only works with -Uninstall.' }
        $elevated = Assert-Admin -Parameters $Parameters
        if ($null -ne $elevated) { return $elevated }

        $paths = Get-KioskPaths
        $installDir = $paths.Install
        $state = $null
        if ($Parameters.Resume) {
            $statePath = Join-Path $installDir 'install-state.json'
            if ($SelfPath) { $statePath = Join-Path (Split-Path -Parent $SelfPath) 'install-state.json' }
            $state = Read-ResumeState -Path $statePath
            if (-not $state) { throw "Nothing to resume ($statePath is missing). Run the install command again." }
            # The environment of the first run (RunOnce starts with a clean one).
            foreach ($n in $KioskEnvNames) {
                if ($state.arguments.ContainsKey("env:$n")) { [Environment]::SetEnvironmentVariable($n, [string]$state.arguments["env:$n"]) }
            }
            foreach ($k in @('ApiUrl', 'PortalUrl', 'Channel', 'Yes')) {
                if ($state.arguments.ContainsKey($k) -and -not $Parameters.ContainsKey($k)) { $Parameters[$k] = $state.arguments[$k] }
            }
            if ($Parameters.Yes) { $script:AssumeYes = $true }
            $paths = Get-KioskPaths
            $installDir = $paths.Install
        }
        $saved = Read-KioskConfig -Path (Join-Path $installDir 'config.env')
        $desktopUser = Get-DesktopUser

        if ($Parameters.Uninstall) {
            if (Test-Path -LiteralPath $installDir) { $logging = Start-InstallLog -InstallDir $installDir }
            $cfg = Merge-KioskConfig -Saved $saved -Options @{ DataDir = $env:KIOSK_DATA_DIR }
            Uninstall-Kiosk -InstallDir $installDir -DataDir $cfg.KIOSK_DATA_DIR -PurgeData:([bool]$Parameters.PurgeData) -DesktopUser $desktopUser
            return 0
        }

        # Preflight.
        Assert-WindowsSupported
        $profilePath = $null
        if ($desktopUser) { $profilePath = $desktopUser.Profile }
        $browser = Find-Browser -UserProfile $profilePath
        if (-not $browser) { Write-Warn 'Neither Chrome nor Edge was found. Install Google Chrome (https://www.google.com/chrome/) so the kiosk opens at sign-in.' }

        if (-not (Test-Path -LiteralPath $installDir)) { New-Item -ItemType Directory -Path $installDir -Force | Out-Null }
        # Users may read (the update task runs as the signed-in user) but not
        # write: RunOnce runs install.ps1 from here as an administrator.
        Set-KioskDirAcl -Path $installDir -UsersRead
        $logging = Start-InstallLog -InstallDir $installDir
        Write-Info "ServerSherpa kiosk installer ($(Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))"

        # Settings before Docker, so the person answers before the long steps.
        $options = @{ ApiUrl = $Parameters.ApiUrl; PortalUrl = $Parameters.PortalUrl; Channel = $Parameters.Channel; DataDir = $env:KIOSK_DATA_DIR; Browser = $browser }
        if ($state) {
            Write-Info "Continuing the install after the restart (step: $($state.step))."
        } else {
            $options = Read-KioskSettings -Saved $saved -Options $options
        }
        $cfg = Merge-KioskConfig -Saved $saved -Options $options
        Test-KioskDataDir -Path $cfg.KIOSK_DATA_DIR
        Test-ApiReachable -ApiUrl $cfg.EDGE_CLOUD_API_URL

        # What a resumed run needs: the answers and the environment.
        $resumeArgs = @{ ApiUrl = $cfg.EDGE_CLOUD_API_URL; PortalUrl = $cfg.EDGE_PORTAL_URL; Channel = $cfg.KIOSK_CHANNEL; Yes = [bool]$Parameters.Yes }
        foreach ($n in $KioskEnvNames) {
            $v = [Environment]::GetEnvironmentVariable($n)
            if ($v) { $resumeArgs["env:$n"] = $v }
        }

        Add-DockerToPath
        if (-not $state -or $state.step -ne 'engine') {
            Install-DockerDesktop -InstallDir $installDir -ResumeArguments $resumeArgs -DesktopUser $desktopUser
        }
        Enable-DockerAutostart -DesktopUser $desktopUser
        Wait-DockerEngine -Seconds 180
        Assert-Compose
        New-KioskDataDir -DataDir $cfg.KIOSK_DATA_DIR -DesktopUser $desktopUser
        Write-KioskConfig -Path (Join-Path $installDir 'config.env') -Config $cfg
        $compose = Join-Path $installDir 'docker-compose.yml'
        Write-TextFile -Path $compose -Text (Get-ComposeText -ImageRef (Get-ImageRef -Channel $cfg.KIOSK_CHANNEL) -DataDir $cfg.KIOSK_DATA_DIR)
        Set-KioskFileAcl -Path $compose
        Copy-LegacyKioskData -LegacyDir (Get-LegacyDataDir -UserProfile $profilePath) -DataDir $cfg.KIOSK_DATA_DIR | Out-Null
        $identity = Start-Kiosk -InstallDir $installDir
        Install-LoginItems -InstallDir $installDir -DesktopUser $desktopUser
        Remove-ResumeRegistration -InstallDir $installDir
        Write-Summary -Identity $identity -Config $cfg -InstallDir $installDir
        return 0
    } catch {
        $msg = $_.Exception.Message
        if ($msg.StartsWith($RestartMarker)) {
            Write-Host ''
            Write-Info $msg.Substring($RestartMarker.Length).Trim()
            return 0
        }
        Write-Host "Error: $msg" -ForegroundColor Red
        return 1
    } finally {
        if ($logging) { try { Stop-Transcript | Out-Null } catch { Write-Verbose 'No transcript to stop.' } }
        if ($env:KIOSK_ELEVATED_CHILD -eq '1' -and (Test-Interactive)) {
            Read-Answer -Prompt 'Press Enter to close this window' | Out-Null
        }
    }
}

# Run only as the last statement, so a partly downloaded script runs nothing.
if ($LibraryOnly -or $env:KIOSK_INSTALL_LIB -eq '1') { return }
$bound = @{}
foreach ($k in $PSBoundParameters.Keys) { $bound[$k] = $PSBoundParameters[$k] }
$exitCode = Invoke-KioskInstaller -Parameters $bound
# Under irm | iex there is no script file, and exit would close the window.
if ($SelfPath) { exit $exitCode }
