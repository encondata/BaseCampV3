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
.PARAMETER StartFresh
Don't look for a phase-1 kiosk's data (the kiosk gets a new identity).
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
    [switch]$StartFresh,
    [switch]$Resume,
    [switch]$LibraryOnly
)

# -- Constants --------------------------------------------------------------
$DefaultApiUrl = 'https://api.serversherpa.com'
$LegacyProject = 'serversherpa-kiosk-laptop'
$LegacyFilter = "label=com.docker.compose.project=$LegacyProject"
# A Go template raw string (backquotes) for "/data": Windows PowerShell 5.1
# drops double quotes inside native command arguments.
$LegacyMountFormat = '{{range .Mounts}}{{if eq .Destination `/data`}}{{.Source}}{{end}}{{end}}'
$KioskContainer = 'serversherpa-kiosk-edge-1'     # project "serversherpa-kiosk", service "edge"
$PreviousTag = 'serversherpa-kiosk-laptop:previous'   # kept by update.ps1
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

# A console someone can type into (never in library mode, so tests can't block).
function Test-ConsoleAvailable {
    if ($env:KIOSK_INSTALL_LIB -eq '1') { return $false }
    if (-not [Environment]::UserInteractive) { return $false }
    try { return -not [Console]::IsInputRedirected } catch { return $false }
}

# True when we may ask questions: not -Yes, not forced non-interactive, a console.
function Test-Interactive {
    if ($env:KIOSK_NONINTERACTIVE -eq '1' -or $AssumeYes) { return $false }
    Test-ConsoleAvailable
}

# True when the closing "Press Enter" may wait. -Yes only means no questions:
# a technician who used it still needs to read the result in its own window.
function Test-CanPause {
    if ($env:KIOSK_NONINTERACTIVE -eq '1') { return $false }
    Test-ConsoleAvailable
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
        $p = Join-KioskPath $env:KIOSK_TEMPLATE_DIR $Name
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

# Join-KioskPath PATH CHILD: like Join-Path, without checking that the drive
# exists (so C:\ paths also work in the tests on macOS/Linux).
function Join-KioskPath {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$ChildPath)
    [IO.Path]::Combine($Path, $ChildPath)
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
# A single-quoted PowerShell literal. PowerShell also treats the curly quotes
# U+2018..U+201B as single quotes, so those are doubled too.
function ConvertTo-PsLiteral {
    param([AllowEmptyString()][string]$Value)
    "'" + ($Value -replace '[''\u2018-\u201B]', '$0$0') + "'"
}

# The command the elevated PowerShell runs: the kiosk environment (an elevated
# process doesn't inherit it), then this script with the same parameters.
function Get-ElevationCommand {
    param([Parameter(Mandatory = $true)][string]$ScriptPath, [hashtable]$Parameters = @{}, [switch]$NoChildMarker)
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($n in $KioskEnvNames) {
        $v = [Environment]::GetEnvironmentVariable($n)
        if ($v) { $lines.Add("`$env:$n = $(ConvertTo-PsLiteral $v)") }
    }
    if (-not $NoChildMarker) { $lines.Add("`$env:KIOSK_ELEVATED_CHILD = '1'") }
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
    $tmp = Join-KioskPath ([IO.Path]::GetTempPath()) 'serversherpa-kiosk-install.ps1'
    Write-TextFile -Path $tmp -Text (Get-CompanionText -Name 'install.ps1')
    $tmp
}

# Assert-Admin: $null when already elevated; otherwise runs this script
# elevated (UAC) with the same parameters and returns its exit code (never
# $null, so the caller can't mistake a finished child for "already elevated").
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
    if ($null -eq $p -or $null -eq $p.ExitCode) { return 1 }
    [int]$p.ExitCode
}

# Test-Need64BitRelaunch: a 32-bit PowerShell on 64-bit Windows sees the
# 32-bit registry and System32 (WOW64), so the installer must not run there.
function Test-Need64BitRelaunch {
    param([bool]$Is64BitOperatingSystem, [bool]$Is64BitProcess)
    $Is64BitOperatingSystem -and -not $Is64BitProcess
}

# Assert-64BitProcess: $null when fine; otherwise runs this script in the
# 64-bit Windows PowerShell (sysnative) and returns its exit code.
function Assert-64BitProcess {
    param([hashtable]$Parameters = @{})
    if (-not (Test-IsWindows)) { return $null }
    if (-not (Test-Need64BitRelaunch -Is64BitOperatingSystem ([Environment]::Is64BitOperatingSystem) -Is64BitProcess ([Environment]::Is64BitProcess))) { return $null }
    $ps64 = "$env:windir\sysnative\WindowsPowerShell\v1.0\powershell.exe"
    if (-not (Test-Path -LiteralPath $ps64 -PathType Leaf)) {
        throw 'This is 32-bit PowerShell on 64-bit Windows. Open "Windows PowerShell" (not the x86 one) and run the install command again.'
    }
    Write-Info 'Switching to 64-bit PowerShell'
    $command = Get-ElevationCommand -ScriptPath (Get-SelfScriptPath) -Parameters $Parameters -NoChildMarker
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    & $ps64 -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded
    if ($null -eq $LASTEXITCODE) { return 1 }
    [int]$LASTEXITCODE
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
    if ($u -cmatch '^(https?://)api\.(.+)$') { return "$($Matches[1])portal.$($Matches[2])" }
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

function Assert-UrlScheme {
    param([string]$Label, [AllowEmptyString()][string]$Url)
    if ($Url -cnotmatch '^https?://.') { throw "$Label must start with http:// or https:// (got '$Url')." }
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

    Assert-UrlScheme -Label 'The API URL' -Url $api
    if ($portal) { Assert-UrlScheme -Label 'The portal URL' -Url $portal }

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

# The install folder lands in the RunOnce cmd /c start command, where % would
# expand environment variables, and in the shortcut and task command lines.
function Test-KioskInstallDir {
    param([AllowEmptyString()][string]$Path)
    if ($Path.Contains('%')) { throw "The install folder (KIOSK_DIR) can't contain %: $Path" }
}

# The data folder also lands in a YAML string and a host:/data volume spec.
function Test-KioskDataDir {
    param([AllowEmptyString()][string]$Path)
    if (-not $Path) { throw 'The data folder (KIOSK_DATA_DIR) is empty.' }
    Test-ConfigValue -Name 'Data folder' -Value $Path
    if ($Path -notmatch '^[A-Za-z]:[\\/]') { throw "The data folder must be a full path such as C:\Kiosk\data (got '$Path')." }
    if ($Path.Substring(2).Contains(':')) { throw "The data folder can't contain a colon except after the drive letter: $Path" }
}

$AdministratorsSid = 'S-1-5-32-544'
$SystemSid = 'S-1-5-18'

# The ACL building blocks, as wrappers Pester can mock (the .NET ACL types
# only work on Windows).
function New-KioskSecurity {
    param([switch]$Directory)
    if ($Directory) { return New-Object Security.AccessControl.DirectorySecurity }
    New-Object Security.AccessControl.FileSecurity
}

function New-KioskAccessRule {
    param([Parameter(Mandatory = $true)]$Sid, [Parameter(Mandatory = $true)][string]$Rights, [switch]$Inherit)
    if ($Inherit) {
        return New-Object Security.AccessControl.FileSystemAccessRule $Sid, $Rights, 'ContainerInherit,ObjectInherit', 'None', 'Allow'
    }
    New-Object Security.AccessControl.FileSystemAccessRule $Sid, $Rights, 'Allow'
}

# Set-KioskAcl PATH RULES [-Directory]: exactly these rules, inheritance from
# the parent off, and BUILTIN\Administrators the owner (an owner can always
# change the permissions, so a pre-created file or folder keeps no other owner).
function Set-KioskAcl {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][object[]]$Rules, [switch]$Directory)
    $acl = New-KioskSecurity -Directory:$Directory
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner((ConvertTo-SecurityIdentifier -Sid $AdministratorsSid))
    foreach ($r in $Rules) {
        $acl.AddAccessRule((New-KioskAccessRule -Sid (ConvertTo-SecurityIdentifier -Sid $r[0]) -Rights $r[1] -Inherit:$Directory))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

# Administrators and SYSTEM full control, signed-in users read; inheritance off.
function Set-KioskFileAcl {
    param([Parameter(Mandatory = $true)][string]$Path)
    Set-KioskAcl -Path $Path -Rules @(@($AdministratorsSid, 'FullControl'), @($SystemSid, 'FullControl'), @('S-1-5-32-545', 'ReadAndExecute'))
}

# Set-KioskDirAcl PATH [USERSID] [-UsersRead]: Administrators + SYSTEM full
# control, plus the given user (full control) and/or Users (read); inherited
# by everything inside; the parent's permissions are not inherited.
function Set-KioskDirAcl {
    param([Parameter(Mandatory = $true)][string]$Path, [string]$UserSid, [switch]$UsersRead)
    $rules = @(@($AdministratorsSid, 'FullControl'), @($SystemSid, 'FullControl'))
    if ($UserSid) { $rules += , @($UserSid, 'FullControl') }
    if ($UsersRead) { $rules += , @('S-1-5-32-545', 'ReadAndExecute') }
    Set-KioskAcl -Path $Path -Rules $rules -Directory
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
    # A fresh file with the install ACL: a planted one (with its own write
    # rights) never survives into what the elevated resume reads.
    Remove-PlantedFile -Path $Path
    Write-TextFile -Path $Path -Text $json
    Set-KioskFileAcl -Path $Path
}

# Remove-PlantedFile PATH: delete a file before it is rewritten, so nothing of
# the old file (its permissions included) is kept.
function Remove-PlantedFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
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

# The RunOnce value: cmd's start returns at once, so sign-in isn't held up
# while the install runs in its own window.
function Get-ResumeCommand {
    param([Parameter(Mandatory = $true)][string]$InstallDir)
    "cmd.exe /c start `"ServerSherpa Kiosk install`" powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\install.ps1`" -Resume"
}

# Save-InstallerCopy: this script into the install folder (RunOnce runs that copy).
function Save-InstallerCopy {
    param([Parameter(Mandatory = $true)][string]$InstallDir)
    $dest = Join-KioskPath $InstallDir 'install.ps1'
    # RunOnce runs this copy elevated: a fresh file with the install ACL, so a
    # planted copy (with its own write rights) never survives.
    if ($SelfPath -and (Test-Path -LiteralPath $SelfPath -PathType Leaf)) {
        if ((Resolve-Path -LiteralPath $SelfPath).Path -ne $dest) {
            Remove-PlantedFile -Path $dest
            Copy-Item -LiteralPath $SelfPath -Destination $dest -Force
        }
    } else {
        Remove-PlantedFile -Path $dest
        Write-TextFile -Path $dest -Text (Get-CompanionText -Name 'install.ps1')
    }
    Set-KioskFileAcl -Path $dest
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
        $state = Join-KioskPath $InstallDir 'install-state.json'
        if (Test-Path -LiteralPath $state) { Remove-Item -LiteralPath $state -Force }
    }
}

# Is this account in the local Administrators group (S-1-5-32-544)?
function Test-UserIsAdmin {
    param([string]$Sid)
    if (-not $Sid) { return $false }
    try {
        $members = Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction Stop
        return [bool]($members | Where-Object { $_.SID -and $_.SID.Value -eq $Sid })
    } catch { return $false }
}

# Get-RestartMessage: what to do now, and who the install continues for.
# HKLM RunOnce only runs when an administrator signs in.
function Get-RestartMessage {
    param([string]$Reason, [ValidateSet('restart', 'signout')][string]$Action = 'restart',
        [bool]$DesktopUserIsAdmin, [string]$DesktopUserName)
    $msg = $Reason
    if ($Action -eq 'signout') { $msg += ' Sign out of Windows and back in (or restart).' } else { $msg += ' Restart Windows now.' }
    if ($DesktopUserIsAdmin) {
        $msg += ' The install continues automatically when an administrator signs in.'
    } else {
        $who = 'This PC''s user'
        if ($DesktopUserName) { $who = $DesktopUserName }
        $msg += " The install continues automatically only when an administrator signs in. $who isn't an administrator, so after that either sign in once as an administrator, or run the install command again."
    }
    $msg
}

# Stop here until Windows restarts (or the user signs in again); RunOnce
# continues the install at the next administrator sign-in.
function Stop-ForRestart {
    param([string]$InstallDir, [string]$Step, [hashtable]$Arguments, [string]$Reason,
        [ValidateSet('restart', 'signout')][string]$Action = 'restart', $DesktopUser)
    Save-ResumeState -Path (Join-KioskPath $InstallDir 'install-state.json') -Step $Step -Arguments $Arguments
    Register-Resume -InstallDir $InstallDir
    $isAdmin = $false
    $name = $null
    if ($DesktopUser) { $isAdmin = Test-UserIsAdmin -Sid $DesktopUser.Sid; $name = $DesktopUser.Name }
    Request-Restart -Message (Get-RestartMessage -Reason $Reason -Action $Action -DesktopUserIsAdmin $isAdmin -DesktopUserName $name)
}

# -- Docker ---------------------------------------------------------------------
# Invoke-Docker -Arguments ARGS [-Stream]: every docker call goes through here
# (Pester mocks it). Throws when docker fails; returns its output otherwise.
# -Stream shows the output (pull progress) instead of returning it; a failure
# still carries it in the error.
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
            # Shown as it comes (pull progress), and kept for the error message.
            $out = @(& docker @Arguments 2>&1 | ForEach-Object { $line = "$_"; $line | Out-Host; $line })
        } else {
            $out = @(& docker @Arguments 2>&1 | ForEach-Object { "$_" })
        }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $eap
    }
    if ($code -ne 0) { throw "docker $($Arguments -join ' ') failed (exit $code). $($out -join ' ')" }
    if (-not $Stream) { $out }
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

# Get-WslFeatureState NAME: Enabled, Disabled, EnablePending, ... ('' if unknown).
function Get-WslFeatureState {
    param([Parameter(Mandatory = $true)][string]$Name)
    try { return [string](Get-WindowsOptionalFeature -Online -FeatureName $Name -ErrorAction Stop).State }
    catch { return '' }
}

# Only a feature waiting for a restart counts as pending. Disabled does not:
# the Store WSL 2.x leaves Microsoft-Windows-Subsystem-Linux Disabled for good.
function Test-WslFeaturesPending {
    foreach ($f in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
        if ((Get-WslFeatureState -Name $f) -eq 'EnablePending') { return $true }
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

# Enable-WslFeature NAME: $true when Windows must restart to finish.
function Enable-WslFeature {
    param([Parameter(Mandatory = $true)][string]$Name)
    try {
        return [bool](Enable-WindowsOptionalFeature -Online -FeatureName $Name -All -NoRestart -ErrorAction Stop).RestartNeeded
    } catch {
        throw "Couldn't turn on $Name. Run Windows Update, then re-run. ($($_.Exception.Message))"
    }
}

# WSL is ready: Virtual Machine Platform is on and `wsl --status` answers.
function Test-WslReady {
    if ((Get-WslFeatureState -Name 'VirtualMachinePlatform') -ne 'Enabled') { return $false }
    $status = $null
    try { $status = Invoke-Wsl -Arguments @('--status') } catch { $status = $null }
    [bool]($status -and $status.ExitCode -eq 0)
}

# Enable-Wsl: WSL2 without a distribution. Returns $true when Windows must
# restart before Docker Desktop can use it.
function Enable-Wsl {
    if (Test-WslReady) {
        Write-Info 'WSL2 is on.'
        return $false
    }
    if (Test-WslFeaturesPending) { return $true }   # turned on earlier; waiting for the restart
    Write-Info 'Turning on WSL2 (Windows Subsystem for Linux)'
    $r = $null
    try { $r = Invoke-Wsl -Arguments @('--install', '--no-distribution') } catch { $r = $null }
    if ($r -and ($r.ExitCode -eq 3010 -or $r.Output -match 'restart|reboot')) { return $true }
    if (-not $r -or $r.ExitCode -ne 0) {
        # Older wsl.exe without --no-distribution: turn the features on directly.
        Write-Info 'Turning on the Windows features WSL2 needs'
        $restart = $false
        foreach ($f in @('Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform')) {
            if (Enable-WslFeature -Name $f) { $restart = $true }
        }
        if ($restart) { return $true }
    }
    Test-WslFeaturesPending
}

# Members of docker-users by SID (the group name is fixed by Docker Desktop;
# SIDs avoid name and domain-prefix mismatches).
function Test-DockerUsersMember {
    param([Parameter(Mandatory = $true)][string]$Sid)
    try {
        $members = Get-LocalGroupMember -Group 'docker-users' -ErrorAction Stop
        return [bool]($members | Where-Object { $_.SID -and $_.SID.Value -eq $Sid })
    } catch { return $false }
}

function ConvertTo-SecurityIdentifier {
    param([Parameter(Mandatory = $true)][string]$Sid)
    New-Object Security.Principal.SecurityIdentifier $Sid
}

# Add-DockerUsersMember SID: $true when newly added, $false when already a member.
function Add-DockerUsersMember {
    param([Parameter(Mandatory = $true)][string]$Sid)
    try {
        Add-LocalGroupMember -Group 'docker-users' -Member (ConvertTo-SecurityIdentifier -Sid $Sid) -ErrorAction Stop
        return $true
    } catch {
        if ($_.FullyQualifiedErrorId -like 'MemberExists*' -or $_.Exception.Message -match 'already a member') { return $false }
        throw "Couldn't add the signed-in user to the docker-users group ($($_.Exception.Message)). Add them in Computer Management > Local Users and Groups, sign out and back in, then re-run."
    }
}

# Confirm-DockerUsersMember: the signed-in user must be in docker-users, or
# Docker Desktop refuses to start for them. Runs on every install once Docker
# is there. Newly added counts only from the next sign-in, so stop and resume.
function Confirm-DockerUsersMember {
    param([Parameter(Mandatory = $true)][string]$InstallDir, [hashtable]$ResumeArguments = @{}, $DesktopUser)
    if (-not $DesktopUser) {
        Write-Warn 'No signed-in user found, so nobody was added to the docker-users group. Docker Desktop only starts for its members.'
        return
    }
    if (Test-DockerUsersMember -Sid $DesktopUser.Sid) { return }
    try {
        $added = Add-DockerUsersMember -Sid $DesktopUser.Sid
    } catch {
        # Administrators can run Docker Desktop without the group.
        if (-not (Test-UserIsAdmin -Sid $DesktopUser.Sid)) { throw }
        Write-Warn "$($_.Exception.Message) $($DesktopUser.Name) is an administrator, so Docker Desktop runs for them anyway; continuing."
        return
    }
    if (-not $added) { return }
    Stop-ForRestart -InstallDir $InstallDir -Step 'engine' -Arguments $ResumeArguments -Action 'signout' -DesktopUser $DesktopUser `
        -Reason "$($DesktopUser.Name) was added to the docker-users group, which counts from the next sign-in."
}

# Install-DockerDesktop: WSL2 (restart and resume if needed), then Docker Desktop.
function Install-DockerDesktop {
    param([Parameter(Mandatory = $true)][string]$InstallDir, [hashtable]$ResumeArguments = @{}, $DesktopUser)
    if ((Test-DockerInstalled) -or (Test-DockerEngine)) {
        Write-Info 'Docker Desktop is installed.'
        return
    }
    Assert-Virtualization
    if (Enable-Wsl) {
        Stop-ForRestart -InstallDir $InstallDir -Step 'docker' -Arguments $ResumeArguments -Action 'restart' -DesktopUser $DesktopUser `
            -Reason 'WSL2 was turned on and Windows needs to restart.'
    }
    $arch = Get-WindowsArch
    $url = "https://desktop.docker.com/win/main/$arch/Docker%20Desktop%20Installer.exe"
    $exe = Join-KioskPath ([IO.Path]::GetTempPath()) 'Docker Desktop Installer.exe'
    Write-Info "Downloading Docker Desktop ($arch)"
    Enable-Tls12
    try {
        Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing
    } catch {
        throw "Couldn't download Docker Desktop. Check the network, then re-run."
    }
    try {
        $sig = Get-AuthenticodeSignature -FilePath $exe
        if ("$($sig.Status)" -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Docker Inc') {
            throw "The Docker Desktop download isn't signed by Docker (signature: $($sig.Status)). Re-run; if it happens again, check for a proxy changing downloads."
        }
        Write-Info 'Installing Docker Desktop (this takes a few minutes)'
        $p = Start-Process -FilePath $exe -ArgumentList @('install', '--quiet', '--accept-license', '--backend=wsl-2') -Wait -PassThru
        if ($p.ExitCode -eq 3010) {
            # Join docker-users now, so this one restart also covers the
            # membership (no sign-out needed afterwards). A failure is left to
            # Confirm-DockerUsersMember after the restart.
            if ($DesktopUser -and -not (Test-DockerUsersMember -Sid $DesktopUser.Sid)) {
                try { Add-DockerUsersMember -Sid $DesktopUser.Sid | Out-Null }
                catch { Write-Warn "$($_.Exception.Message) The installer tries again after the restart." }
            }
            Stop-ForRestart -InstallDir $InstallDir -Step 'engine' -Arguments $ResumeArguments -Action 'restart' -DesktopUser $DesktopUser `
                -Reason 'Docker Desktop was installed and Windows needs to restart.'
        }
        if ($p.ExitCode -ne 0) { throw "Docker Desktop didn't install (exit code $($p.ExitCode)). Restart Windows, then re-run." }
    } finally {
        Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
    }
    Add-DockerToPath
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

function Test-DockerDesktopRunning {
    [bool](Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue)
}

# Start Docker Desktop as the signed-in user (never elevated): a one-time
# scheduled task running in their session, removed once it has launched.
function Start-DockerDesktopAsUser {
    param($DesktopUser, [int]$WaitSeconds = 15)
    if (-not (Test-Path -LiteralPath $DockerDesktopExe)) { Write-Warn "Docker Desktop isn't at $DockerDesktopExe; start it from the Start menu."; return }
    $task = 'ServerSherpa Kiosk Start Docker'
    try {
        if (-not $DesktopUser) { throw 'no desktop user' }
        $action = New-ScheduledTaskAction -Execute $DockerDesktopExe
        $principal = New-ScheduledTaskPrincipal -UserId $DesktopUser.Name -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Force | Out-Null
        try {
            Start-ScheduledTask -TaskName $task
            # Unregistering a task that is still Queued cancels the launch.
            $deadline = (Get-Date).AddSeconds($WaitSeconds)
            while ((Get-Date) -lt $deadline) {
                if (Test-DockerDesktopRunning) { break }
                $state = "$((Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue).State)"
                if ($state -and $state -ne 'Queued' -and $state -ne 'Ready') { break }
                Start-Sleep -Milliseconds 500
            }
        } finally {
            Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
        }
    } catch {
        try { Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$DockerDesktopExe`"" }
        catch { Write-Warn "Couldn't start Docker Desktop; open it from the Start menu." }
    }
}

# Enable-DockerAutostart: Docker Desktop starts at sign-in from now on, and now.
function Enable-DockerAutostart {
    param($DesktopUser)
    if ($DesktopUser -and $DesktopUser.Profile) {
        Set-DockerAutostart -Path (Join-KioskPath $DesktopUser.Profile 'AppData\Roaming\Docker\settings-store.json')
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
function Get-KioskPathOwnerSid {
    param([Parameter(Mandatory = $true)][string]$Path)
    (Get-Acl -LiteralPath $Path).GetOwner([Security.Principal.SecurityIdentifier]).Value
}

# Assert-KioskDataDirOwner: a data folder that already exists must belong to
# Administrators, SYSTEM or the desktop user; one someone else set up is never
# used (or changed).
function Assert-KioskDataDirOwner {
    param([Parameter(Mandatory = $true)][string]$DataDir, $DesktopUser)
    $fix = 'Move it aside (or set KIOSK_DATA_DIR to another folder), then run the install command again.'
    try { $owner = [string](Get-KioskPathOwnerSid -Path $DataDir) }
    catch { throw "Couldn't check who owns the data folder $DataDir ($($_.Exception.Message)). $fix" }
    $trusted = @($AdministratorsSid, $SystemSid)
    $who = 'Administrators or SYSTEM'
    if ($DesktopUser -and $DesktopUser.Sid) { $trusted += $DesktopUser.Sid; $who = "Administrators, SYSTEM or $($DesktopUser.Name)" }
    if ($trusted -notcontains $owner) {
        throw "The data folder $DataDir already exists and belongs to $owner, not to $who, so the installer won't use it. $fix"
    }
}

# Assert-KioskDataDirPlacement: the data folder may not be the install folder
# (whose ACL lets every user read) or inside it, except as its own data
# subfolder (the default), which gets its own protected ACL.
function Assert-KioskDataDirPlacement {
    param([Parameter(Mandatory = $true)][string]$InstallDir, [Parameter(Mandatory = $true)][string]$DataDir)
    $i = $InstallDir.Replace('/', '\').TrimEnd('\')
    $d = $DataDir.Replace('/', '\').TrimEnd('\')
    if ($d -ieq $i) { throw "The data folder can't be the install folder ($InstallDir). Set KIOSK_DATA_DIR to another folder, then run the install command again." }
    if ($d.StartsWith($i + '\', [StringComparison]::OrdinalIgnoreCase) -and $d -ine ($i + '\data')) {
        throw "The data folder can't be inside the install folder ($InstallDir) except as its data subfolder (got $DataDir). Set KIOSK_DATA_DIR to another folder, then run the install command again."
    }
}

# New-KioskDataDir: made once (Administrators, SYSTEM and the Docker Desktop
# user, who shares it into the engine), never touched again. An existing
# folder must have a trusted owner; an empty one (an earlier run stopped
# right after making it) gets its permissions again.
function New-KioskDataDir {
    param([Parameter(Mandatory = $true)][string]$DataDir, $DesktopUser)
    if (Test-Path -LiteralPath $DataDir -PathType Container) {
        Assert-KioskDataDirOwner -DataDir $DataDir -DesktopUser $DesktopUser
        if (Get-ChildItem -LiteralPath $DataDir -Force | Select-Object -First 1) { return }
    } else {
        New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
    }
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

# The phase-1 kiosk's containers, by their compose project label (not
# `compose -p ... stop`, which depends on the folder it runs in).
function Get-LegacyContainerIds {
    try { @(Invoke-Docker -Arguments @('ps', '-a', '-q', '--filter', $LegacyFilter) | ForEach-Object { "$_".Trim() } | Where-Object { $_ }) }
    catch { @() }
}

# Get-LegacyMountSource ID: the host folder that container mounts at /data.
function Get-LegacyMountSource {
    param([Parameter(Mandatory = $true)][string]$Id)
    try { return ((@(Invoke-Docker -Arguments @('inspect', '-f', $LegacyMountFormat, $Id)) -join '').Trim()) } catch { return '' }
}

# The phase-1 kiosk holds port 8090; stop it (nothing to stop is fine).
function Stop-LegacyKiosk {
    $ids = @(Get-LegacyContainerIds)
    if ($ids.Count -eq 0) { return }
    try { Invoke-Docker -Arguments (@('stop') + $ids) | Out-Null }
    catch { Write-Verbose 'No phase-1 kiosk to stop.' }
}

# ConvertFrom-DockerMountSource SOURCE: the Windows folder behind a bind
# mount's Source as Docker Desktop reports it, or '' for a folder inside WSL.
function ConvertFrom-DockerMountSource {
    param([AllowEmptyString()][string]$Source)
    if ($Source -match '^[A-Za-z]:[\\/]') { return $Source.Replace('/', '\') }
    if ($Source -match '^/(?:run/desktop/mnt/host|host_mnt|mnt/host)/([A-Za-z])(/.*)?$') {
        $rest = $Matches[2]
        if (-not $rest) { $rest = '/' }
        return $Matches[1].ToUpper() + ':' + $rest.Replace('/', '\')
    }
    ''
}

# Find-LegacyKioskData: @{ Dir; Unreadable }. Dir is the phase-1 data folder
# if it holds identity.json. The old container's /data mount wins over the
# profile-folder guess (the guess is only for when no old container exists);
# a mount Windows can't read (a WSL folder, a missing one) sets Unreadable.
function Find-LegacyKioskData {
    param([string]$UserProfile)
    $r = @{ Dir = ''; Unreadable = '' }
    if ($env:EDGE_DATA_HOST_DIR) {
        if (Test-Path -LiteralPath (Join-KioskPath $env:EDGE_DATA_HOST_DIR 'identity.json') -PathType Leaf) { $r.Dir = $env:EDGE_DATA_HOST_DIR }
        return $r
    }
    $src = ''
    foreach ($id in @(Get-LegacyContainerIds)) {
        $src = Get-LegacyMountSource -Id $id
        if ($src) { break }
    }
    if ($src) {
        $win = ConvertFrom-DockerMountSource -Source $src
        if ($win -and (Test-Path -LiteralPath $win -PathType Container)) {
            if (Test-Path -LiteralPath (Join-KioskPath $win 'identity.json') -PathType Leaf) { $r.Dir = $win }
        } else {
            $r.Unreadable = $src
        }
        return $r
    }
    $guess = Get-LegacyDataDir -UserProfile $UserProfile
    if (Test-Path -LiteralPath (Join-KioskPath $guess 'identity.json') -PathType Leaf) { $r.Dir = $guess }
    $r
}

# Invoke-LegacyMigration: the one-time phase-1 copy. Stops before the new
# kiosk starts when the old data can't be read, unless -StartFresh. $true if copied.
function Invoke-LegacyMigration {
    param([string]$UserProfile, [Parameter(Mandatory = $true)][string]$DataDir, [switch]$StartFresh)
    $found = Find-LegacyKioskData -UserProfile $UserProfile
    $any = $found.Dir
    if (-not $any) { $any = $found.Unreadable }
    if ($any -and $StartFresh) {
        Write-Warn "Starting fresh (-StartFresh): the earlier kiosk's data in $any was not copied."
        return $false
    }
    if ($found.Unreadable) {
        $where = $found.Unreadable
        if ((Test-Path -LiteralPath $DataDir -PathType Container) -and (Get-ChildItem -LiteralPath $DataDir -Force | Select-Object -First 1)) {
            Write-Info "Keeping the existing data in $DataDir (earlier kiosk data in $where was not copied)."
            return $false
        }
        Stop-LegacyKiosk
        $hint = ''
        if ($where.StartsWith('/run/desktop/mnt/host/wsl/')) {
            $hint = ' The data is inside the WSL distribution, usually ' + '\\wsl$\<distro>\home\<you>\ServerSherpaKiosk' + ' (<distro> is the Linux distribution it ran in, for example Ubuntu).'
        } elseif ($where.StartsWith('/')) {
            $hint = ' From Windows that folder is ' + '\\wsl$\<distro>' + $where.Replace('/', '\') + ' (<distro> is the Linux distribution it ran in, for example Ubuntu).'
        }
        throw ("The earlier kiosk keeps its data in $where, which this installer can't read.$hint The old kiosk was stopped. " +
            "Copy everything in that folder into $DataDir, then run the install command again. To start without it " +
            "(the kiosk gets a new identity, and scans the old one hadn't uploaded stay behind), run it again with -StartFresh.")
    }
    if (-not $found.Dir) { return $false }
    Copy-LegacyKioskData -LegacyDir $found.Dir -DataDir $DataDir
}

# Copy-LegacyKioskData: one-time copy of the phase-1 data into an absent or
# completely empty data folder, so nothing is ever overwritten. $true if copied.
function Copy-LegacyKioskData {
    param([Parameter(Mandatory = $true)][string]$LegacyDir, [Parameter(Mandatory = $true)][string]$DataDir)
    if (-not (Test-Path -LiteralPath (Join-KioskPath $LegacyDir 'identity.json') -PathType Leaf)) { return $false }
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

# update-state.json, shared with update.ps1 (same keys and format).
function Read-InstallUpdateState {
    param([Parameter(Mandatory = $true)][string]$Path)
    $st = @{ Previous = ''; Rejected = '' }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $st }
    try {
        $raw = [IO.File]::ReadAllText($Path)
        if ($raw.Trim()) {
            $o = $raw | ConvertFrom-Json
            if ($o.previous_image) { $st.Previous = [string]$o.previous_image }
            if ($o.rejected_image) { $st.Rejected = [string]$o.rejected_image }
        }
    } catch { Write-Warn "Couldn't read $Path; treating it as empty." }
    $st
}

# Write-InstallUpdateState: phase=done, previous_image and rejected_image kept.
# Written in place (not renamed), so the signed-in user's write permission on
# this one file stays (Install-LoginItems sets it).
function Write-InstallUpdateState {
    param([Parameter(Mandatory = $true)][string]$Path, [hashtable]$State, [string]$ImageRef)
    $o = [ordered]@{
        previous_image = $State.Previous
        image          = $ImageRef
        rejected_image = $State.Rejected
        phase          = 'done'
        updated_at     = (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz')
    }
    try { [IO.File]::WriteAllText($Path, (($o | ConvertTo-Json -Compress) + "`n"), (New-Object Text.UTF8Encoding $false)) }
    catch { Write-Warn "Couldn't write $Path." }
}

# Wait-KioskContainerHealthy: @{ Healthy; Status }, checked at least once,
# then every PollSeconds until the timeout.
function Wait-KioskContainerHealthy {
    param([int]$TimeoutSeconds = 120, [int]$PollSeconds = 3)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ($true) {
        $status = ''
        try { $status = ((Invoke-Docker -Arguments @('inspect', '-f', '{{.State.Health.Status}}', $KioskContainer)) -join '').Trim() } catch { $status = '' }
        if ($status -eq 'healthy') { return @{ Healthy = $true; Status = $status } }
        if ((Get-Date) -ge $deadline) {
            if (-not $status) { $status = 'unknown' }
            return @{ Healthy = $false; Status = $status }
        }
        Start-Sleep -Seconds $PollSeconds
    }
}

function Get-ImageId {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    try { return ((@(Invoke-Docker -Arguments $Arguments) -join '').Trim()) } catch { return '' }
}

# Test-DockerTag SOURCE TARGET: $true when docker tag worked.
function Test-DockerTag {
    param([Parameter(Mandatory = $true)][string]$Source, [Parameter(Mandatory = $true)][string]$Target)
    try { Invoke-Docker -Arguments @('tag', $Source, $Target) | Out-Null; return $true } catch { return $false }
}

# Docker Desktop's containerd image store can't find an image by its ID once
# it has no name left, even while a container runs it, so the running image is
# named :previous before the pull moves the channel tag, and images are put
# back by name (as update.ps1 does).

# Save-PreviousImageTag ID REF: tag image ID as :previous, from REF while REF
# still names it (before the pull), else by ID (classic store).
function Save-PreviousImageTag {
    param([Parameter(Mandatory = $true)][string]$Id, [Parameter(Mandatory = $true)][string]$Ref)
    if ((Get-ImageId -Arguments @('image', 'inspect', '-f', '{{.Id}}', $Ref)) -eq $Id) {
        if (Test-DockerTag -Source $Ref -Target $PreviousTag) { return $true }
    }
    if (Test-DockerTag -Source $Id -Target $PreviousTag) { return $true }
    Write-Warn "Couldn't tag the running image $Id as $PreviousTag (continuing)."
    $false
}

# Restore-ImageTag ID REF: put image ID back on REF, from :previous when it
# holds that image, else by ID (saying why). $true when tagged.
function Restore-ImageTag {
    param([Parameter(Mandatory = $true)][string]$Id, [Parameter(Mandatory = $true)][string]$Ref)
    $kept = Get-ImageId -Arguments @('image', 'inspect', '-f', '{{.Id}}', $PreviousTag)
    if ($kept -eq $Id) {
        if (Test-DockerTag -Source $PreviousTag -Target $Ref) { return $true }
        Write-Warn "Couldn't tag $Ref from $PreviousTag; trying $Id by ID."
    } elseif ($kept) {
        Write-Warn "$PreviousTag holds $kept, not $Id; tagging $Id by ID."
    } else {
        Write-Warn "$PreviousTag doesn't exist; tagging $Id by ID."
    }
    Test-DockerTag -Source $Id -Target $Ref
}

# Start-KioskContainer: compose up -d, then the health wait. @{ Healthy; Status }.
function Start-KioskContainer {
    param([string]$Compose, [int]$TimeoutSeconds, [int]$PollSeconds)
    try { Invoke-Docker -Arguments @('compose', '-f', $Compose, 'up', '-d') -Stream | Out-Null }
    catch { return @{ Healthy = $false; Status = "didn't start" } }
    Wait-KioskContainerHealthy -TimeoutSeconds $TimeoutSeconds -PollSeconds $PollSeconds
}

# Start-Kiosk: pull, start, wait until healthy, return /edge/identity (or
# $null). Respects update-state.json like the nightly update: a version that
# failed its health check here before is not started again, and a new version
# that doesn't get healthy is rolled back.
function Start-Kiosk {
    param([Parameter(Mandatory = $true)][string]$InstallDir, [Parameter(Mandatory = $true)][string]$ImageRef,
        [string]$Channel = 'stable', [int]$TimeoutSeconds = 120, [int]$PollSeconds = 3)
    $compose = Join-KioskPath $InstallDir 'docker-compose.yml'
    $statePath = Join-KioskPath $InstallDir 'update-state.json'
    $logs = "See: docker compose -f `"$compose`" logs edge"
    Stop-LegacyKiosk
    $prev = Get-ImageId -Arguments @('inspect', '-f', '{{.Image}}', $KioskContainer)
    # Before the pull, while the channel tag still names the running image.
    if ($prev) { Save-PreviousImageTag -Id $prev -Ref $ImageRef | Out-Null }
    Write-Info 'Downloading the kiosk image'
    try { Invoke-Docker -Arguments @('compose', '-f', $compose, 'pull') -Stream | Out-Null }
    catch {
        if ($_.Exception.Message -match 'manifest unknown|not found|denied|unauthorized') {
            $hint = 'try -Channel edge, or ask your administrator'
            if ($Channel -eq 'edge') { $hint = 'ask your administrator' }
            throw "The $Channel image isn't published yet, or its package isn't public $Dash $hint."
        }
        throw "Couldn't download the kiosk image. Check the network, then re-run."
    }
    $new = Get-ImageId -Arguments @('image', 'inspect', '-f', '{{.Id}}', $ImageRef)
    $state = Read-InstallUpdateState -Path $statePath
    if ($prev -and $new -and $new -ne $prev -and $new -eq $state.Rejected) {
        Write-Warn 'The newest version failed its health check on this laptop before; keeping the current one.'
        # The channel tag back on the running image, so compose doesn't recreate it.
        if (-not (Restore-ImageTag -Id $prev -Ref $ImageRef)) { throw "Couldn't keep the current version (docker tag failed)." }
        $new = $prev
    } elseif (-not $prev -and $new -and $new -eq $state.Rejected) {
        # No container to keep: like update.ps1, the kept :previous image if there is one.
        $kept = Get-ImageId -Arguments @('image', 'inspect', '-f', '{{.Id}}', $PreviousTag)
        $tagged = $false
        if ($kept -and $kept -ne $new) {
            $tagged = Test-DockerTag -Source $PreviousTag -Target $ImageRef
        }
        if ($tagged) {
            Write-Warn 'The newest version failed its health check on this laptop before; starting the kept previous version instead.'
            $new = $kept
        } else {
            Write-Warn 'The newest version failed its health check on this laptop before, and no earlier version is kept, so starting it anyway.'
        }
    }
    Write-Info 'Starting the kiosk'
    $r = Start-KioskContainer -Compose $compose -TimeoutSeconds $TimeoutSeconds -PollSeconds $PollSeconds
    if (-not $r.Healthy) {
        if ($prev -and $prev -ne $new) {
            Write-Warn "The new version didn't become healthy (status: $($r.Status)); going back to the previous one."
            if ($new) { $state.Rejected = $new }   # the nightly update won't try it again
            $back = Restore-ImageTag -Id $prev -Ref $ImageRef
            if ($back) { $r = Start-KioskContainer -Compose $compose -TimeoutSeconds $TimeoutSeconds -PollSeconds $PollSeconds }
            Write-InstallUpdateState -Path $statePath -State $state -ImageRef $ImageRef
            if ($back -and $r.Healthy) {
                throw "The new kiosk version didn't become healthy, so the installer rolled back to the previous version, which is running. $logs"
            }
            throw "The new kiosk version didn't become healthy, and the previous version isn't healthy either (status: $($r.Status)). $logs"
        }
        throw "The kiosk didn't become healthy in time (status: $($r.Status)). $logs"
    }
    # A re-run ends any update a crash left half done.
    Write-InstallUpdateState -Path $statePath -State $state -ImageRef $ImageRef
    $identity = Get-KioskJson -Path '/edge/identity'
    if (-not $identity) { Write-Warn "The kiosk is running but didn't answer $KioskUrl/edge/identity yet." }
    Write-Info 'The kiosk is running.'
    $identity
}

# -- Login items ------------------------------------------------------------------
$UpdateTaskName = 'ServerSherpa Kiosk Update'
$HostnetTaskName = 'ServerSherpa Kiosk Host Network'
$ShortcutName = 'ServerSherpa Kiosk.lnk'

# Join-WindowsPath DIR NAME: DIR\NAME for a Windows command line (the same on
# every host, so the tests check exactly what Windows gets).
function Join-WindowsPath {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$ChildPath)
    $Path.TrimEnd('\', '/') + '\' + $ChildPath
}

# Get-UpdateTaskSpec: the nightly update task, as plain values (Pester checks
# these; Install-LoginItems turns them into the scheduled task). It runs as the
# signed-in user only while they're signed in (Docker Desktop runs only then).
function Get-UpdateTaskSpec {
    param([Parameter(Mandatory = $true)][string]$InstallDir, [Parameter(Mandatory = $true)][string]$User)
    @{
        Name                      = $UpdateTaskName
        Time                      = '03:00'
        Execute                   = 'powershell.exe'
        Argument                  = "-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File `"$(Join-WindowsPath $InstallDir 'update.ps1')`""
        User                      = $User
        LogonType                 = 'Interactive'
        ExecutionTimeLimitMinutes = 30     # as update.sh's TimeoutStartSec
    }
}

# Get-HostnetTaskSpec: the host-network helper task (hostnet.ps1), as plain
# values. As SYSTEM (full control of the data folder and the script, and no
# dependence on who is signed in), at startup and every minute. It runs in
# session 0, so it never shows a window.
function Get-HostnetTaskSpec {
    param([Parameter(Mandatory = $true)][string]$InstallDir)
    @{
        Name                      = $HostnetTaskName
        Execute                   = 'powershell.exe'
        Argument                  = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$(Join-WindowsPath $InstallDir 'hostnet.ps1')`""
        User                      = 'NT AUTHORITY\SYSTEM'
        LogonType                 = 'ServiceAccount'
        RunLevel                  = 'Highest'
        RepeatMinutes             = 1
        ExecutionTimeLimitMinutes = 2
    }
}

# Get-ShortcutSpec: what the ServerSherpa Kiosk shortcuts run.
function Get-ShortcutSpec {
    param([Parameter(Mandatory = $true)][string]$InstallDir)
    $windir = $env:SystemRoot
    if (-not $windir) { $windir = 'C:\Windows' }
    @{
        Target           = $windir + '\System32\WindowsPowerShell\v1.0\powershell.exe'
        Arguments        = "-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File `"$(Join-WindowsPath $InstallDir 'launch.ps1')`""
        WorkingDirectory = $InstallDir
        Description      = 'Open the ServerSherpa kiosk'
    }
}

# Get-ShortcutPaths: Public Desktop, all-users Start menu, all-users StartUp.
function Get-ShortcutPaths {
    $public = $env:PUBLIC
    if (-not $public) { $public = 'C:\Users\Public' }
    $programData = $env:ProgramData
    if (-not $programData) { $programData = 'C:\ProgramData' }
    $programs = $programData + '\Microsoft\Windows\Start Menu\Programs'
    @(
        ($public + '\Desktop\' + $ShortcutName),
        ($programs + '\' + $ShortcutName),
        ($programs + '\StartUp\' + $ShortcutName)
    )
}

# New-KioskShortcut PATH SPEC: a .lnk through the Windows Script Host.
function New-KioskShortcut {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][hashtable]$Spec)
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($Path)
    $lnk.TargetPath = $Spec.Target
    $lnk.Arguments = $Spec.Arguments
    $lnk.WorkingDirectory = $Spec.WorkingDirectory
    $lnk.Description = $Spec.Description
    $lnk.WindowStyle = 7            # minimized: the PowerShell window barely shows
    $lnk.Save()
}

# Get-KioskUserWritableAclRules USERSID: like Set-KioskFileAcl's rules, plus
# Write + ReadAndExecute for that one user. The update task runs as them and
# rewrites the file in place, so it never needs delete rights (no Modify).
function Get-KioskUserWritableAclRules {
    param([Parameter(Mandatory = $true)][string]$UserSid)
    @(@('S-1-5-32-544', 'FullControl'), @('S-1-5-18', 'FullControl'), @('S-1-5-32-545', 'ReadAndExecute'), @($UserSid, 'Write, ReadAndExecute'))
}

# Set-KioskUserWritableFileAcl PATH USERSID: those rules, inheritance off,
# owned by Administrators.
function Set-KioskUserWritableFileAcl {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$UserSid)
    Set-KioskAcl -Path $Path -Rules (Get-KioskUserWritableAclRules -UserSid $UserSid)
}

# Register-UpdateTask SPEC: the scheduled task (replaced if it exists).
function Register-UpdateTask {
    param([Parameter(Mandatory = $true)][hashtable]$Spec)
    $action = New-ScheduledTaskAction -Execute $Spec.Execute -Argument $Spec.Argument
    $trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.Add([TimeSpan]::Parse($Spec.Time)))
    $principal = New-ScheduledTaskPrincipal -UserId $Spec.User -LogonType $Spec.LogonType
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes $Spec.ExecutionTimeLimitMinutes)
    Register-ScheduledTask -TaskName $Spec.Name -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
        -Description 'ServerSherpa kiosk nightly update (update.ps1; log in update.log).' -Force | Out-Null
}

# Register-HostnetTask SPEC: the host network task (replaced if it exists):
# at startup, and every minute from now on (a -Once trigger's repetition
# without a duration repeats indefinitely); on battery too, one run at a time.
function Register-HostnetTask {
    param([Parameter(Mandatory = $true)][hashtable]$Spec)
    $action = New-ScheduledTaskAction -Execute $Spec.Execute -Argument $Spec.Argument
    $triggers = @(
        (New-ScheduledTaskTrigger -AtStartup),
        (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes $Spec.RepeatMinutes))
    )
    $principal = New-ScheduledTaskPrincipal -UserId $Spec.User -LogonType $Spec.LogonType -RunLevel $Spec.RunLevel
    $settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes $Spec.ExecutionTimeLimitMinutes)
    Register-ScheduledTask -TaskName $Spec.Name -Action $action -Trigger $triggers -Principal $principal -Settings $settings `
        -Description 'ServerSherpa kiosk host network addresses (hostnet.ps1 writes host-network.json in the data folder).' -Force | Out-Null
}

# Wait-HostNetworkFile DATADIR SINCE: $true once host-network.json was written
# at or after SINCE (UTC), checked every second for about 10 seconds.
function Wait-HostNetworkFile {
    param([Parameter(Mandatory = $true)][string]$DataDir, [Parameter(Mandatory = $true)][datetime]$Since, [int]$Tries = 10)
    $path = Join-KioskPath $DataDir 'host-network.json'
    $floor = $Since.AddSeconds(-1)   # file times can round down
    for ($i = 0; ; $i++) {
        if ((Test-Path -LiteralPath $path -PathType Leaf) -and (Get-Item -LiteralPath $path).LastWriteTimeUtc -ge $floor) { return $true }
        if ($i -ge $Tries) { return $false }
        Start-Sleep -Seconds 1
    }
}

# Start-HostnetTask DATADIR: one run now, then a fresh host-network.json
# within about 10 seconds, or a warning (Kiosk Setup needs the file).
function Start-HostnetTask {
    param([string]$DataDir)
    $since = [datetime]::UtcNow
    try { Start-ScheduledTask -TaskName $HostnetTaskName -ErrorAction Stop }
    catch { Write-Verbose "The host network task didn't start now ($($_.Exception.Message))." }
    if (-not $DataDir) { return }
    if (-not (Wait-HostNetworkFile -DataDir $DataDir -Since $since)) {
        Write-Warn "Couldn't confirm the network helper is running $Dash RFID setup may not find readers."
    }
}

# Install-LoginItems: update.ps1/launch.ps1/hostnet.ps1, the nightly update
# and host network tasks, and the ServerSherpa Kiosk shortcuts (Public
# Desktop, Start menu, StartUp).
function Install-LoginItems {
    param([Parameter(Mandatory = $true)][string]$InstallDir, $DesktopUser, [string]$DataDir)
    foreach ($name in @('update.ps1', 'launch.ps1', 'hostnet.ps1')) {
        $dest = Join-KioskPath $InstallDir $name
        Write-TextFile -Path $dest -Text (Get-CompanionText -Name $name)
        Set-KioskFileAcl -Path $dest
    }
    if ($DesktopUser) {
        # The install folder is read-only for users; the update task (running as
        # the signed-in user) may write its log and state files, and only those.
        foreach ($name in @('update.log', 'update-state.json')) {
            $p = Join-KioskPath $InstallDir $name
            if (-not (Test-Path -LiteralPath $p)) { [IO.File]::WriteAllText($p, '') }
            Set-KioskUserWritableFileAcl -Path $p -UserSid $DesktopUser.Sid
        }
        try {
            Register-UpdateTask -Spec (Get-UpdateTaskSpec -InstallDir $InstallDir -User $DesktopUser.Name)
            Write-Info "Nightly update scheduled (03:00, while $($DesktopUser.Name) is signed in)."
        } catch {
            Write-Warn "Couldn't schedule the nightly update ($($_.Exception.Message)). Re-run the installer to try again."
        }
    } else {
        Write-Warn "No signed-in user found, so the nightly update wasn't scheduled. Re-run the installer from the kiosk's account."
    }
    # As SYSTEM, so it doesn't depend on who is signed in.
    $hostnet = $false
    try {
        Register-HostnetTask -Spec (Get-HostnetTaskSpec -InstallDir $InstallDir)
        $hostnet = $true
    } catch {
        Write-Warn "Couldn't schedule the host network task, which RFID reader setup needs ($($_.Exception.Message)). Re-run the installer to try again."
    }
    if ($hostnet) { Start-HostnetTask -DataDir $DataDir }
    $spec = Get-ShortcutSpec -InstallDir $InstallDir
    foreach ($lnk in Get-ShortcutPaths) {
        try { New-KioskShortcut -Path $lnk -Spec $spec }
        catch { Write-Warn "Couldn't create $lnk ($($_.Exception.Message))." }
    }
    Write-Info 'The kiosk opens at sign-in, and from the ServerSherpa Kiosk shortcut on the Desktop and in the Start menu.'
}

# Remove-LoginItems: undo Install-LoginItems, stopping an update that is running
# (so it can't restart the container while uninstall stops it).
function Remove-LoginItems {
    param([string]$InstallDir, $DesktopUser)
    foreach ($name in @($UpdateTaskName, $HostnetTaskName)) {
        $task = $null
        try { $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop } catch { $task = $null }
        if ($task) {
            try { Stop-ScheduledTask -TaskName $name -ErrorAction Stop } catch { Write-Verbose "The task '$name' was not running." }
            try { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop }
            catch { Write-Warn "Couldn't remove the scheduled task '$name'; delete it in Task Scheduler." }
        }
    }
    foreach ($lnk in Get-ShortcutPaths) {
        if (Test-Path -LiteralPath $lnk) {
            try { Remove-Item -LiteralPath $lnk -Force -ErrorAction Stop }
            catch { Write-Warn "Couldn't remove $lnk ($($_.Exception.Message)); delete it by hand." }
        }
    }
    Write-Verbose "Login items removed for $InstallDir ($($DesktopUser.Name))."
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
    param($Identity, [hashtable]$Config, [string]$InstallDir, $DesktopUser)
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
    if ($DesktopUser) { Write-Host "  Set up for: $($DesktopUser.Name) (the kiosk opens when this account signs in)" }
    Write-Host ''
    Write-Host 'Next: sign in online on the kiosk, then open Kiosk Setup.'
    Write-Host 'The kiosk opens when someone signs in to Windows (Docker Desktop only runs then).'
    Write-Host 'For an unattended station, turn on automatic sign-in for that account'
    Write-Host '(for example with Sysinternals Autologon).'
    Write-Host 'USB label printers: Chrome/Edge reach a Zebra printer over WebUSB only after its'
    Write-Host 'driver is switched to WinUSB (for example with Zadig).'
}

# -- Uninstall ------------------------------------------------------------------
# Assert-SafeRemovePath LABEL PATH [-MinComponents N]: refuse paths it would
# be dangerous to remove from: empty, relative, a drive root, . or .. parts,
# fewer than N components (2, for recursive deletes such as the data purge;
# 1 for the install folder, where only named files are deleted, so D:\K works).
function Assert-SafeRemovePath {
    param([string]$Label, [AllowEmptyString()][string]$Path, [ValidateRange(1, 10)][int]$MinComponents = 2)
    if ([string]::IsNullOrWhiteSpace($Path)) { throw "$Label is empty; refusing to continue." }
    $p = $Path.Replace('\', '/')
    $min = $MinComponents
    if ($p.StartsWith('//')) {
        $rest = $p.Substring(2); $min = $MinComponents + 2  # \\server\share\...
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
        if (Test-Path -LiteralPath (Join-KioskPath $Path $f)) { return $true }
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
    $removed = 'the update task, the host network task and the launcher were already removed; re-running the installer puts them back'
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
    # Only named files are deleted from the install folder; the data folder may be deleted recursively.
    Assert-SafeRemovePath -Label 'The install folder (KIOSK_DIR)' -Path $InstallDir -MinComponents 1
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
    $compose = Join-KioskPath $InstallDir 'docker-compose.yml'
    if (Test-Path -LiteralPath $compose -PathType Leaf) {
        Stop-KioskForUninstall -ComposeFile $compose
    }
    foreach ($f in @('docker-compose.yml', 'config.env', 'install.ps1', 'update.ps1', 'launch.ps1', 'hostnet.ps1', 'install-state.json', 'update-state.json')) {
        $p = Join-KioskPath $InstallDir $f
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
    }
    Write-Info "Removed the kiosk from $InstallDir (install.log and update.log were kept). Docker stays installed."
    if ($PurgeData) {
        if (Test-Path -LiteralPath $DataDir -PathType Container) {
            Remove-Item -LiteralPath $DataDir -Recurse -Force
            Write-Info "Deleted the data folder $DataDir."
        }
    } else {
        Write-Info "Kept the data folder $DataDir. It holds the kiosk's identity (its serial and key) and any scans not yet uploaded; reinstalling picks it up again. To delete it too: -Uninstall -PurgeData."
    }
}

# The data folder setting: environment, then saved config, then the default
# (what uninstall works on, and what Merge-KioskConfig picks).
function Get-UninstallDataDir {
    param([hashtable]$Saved = @{})
    if ($env:KIOSK_DATA_DIR) { return $env:KIOSK_DATA_DIR }
    if ($Saved.KIOSK_DATA_DIR) { return $Saved.KIOSK_DATA_DIR }
    (Get-KioskPaths).Data
}

# -- Main -----------------------------------------------------------------------
function Start-InstallLog {
    param([string]$InstallDir)
    try {
        Start-Transcript -Path (Join-KioskPath $InstallDir 'install.log') -Append | Out-Null
        return $true
    } catch { return $false }
}

# Invoke-KioskInstaller: returns the exit code. Mirrors install.sh's main.
function Invoke-KioskInstaller {
    param([hashtable]$Parameters = @{})
    $ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest's progress bar slows 5.1 downloads badly
    $ErrorActionPreference = 'Stop'
    $logging = $false
    $relaunched = $false
    try {
        if ($Parameters.PurgeData -and -not $Parameters.Uninstall) { throw '-PurgeData only works with -Uninstall.' }
        # 64-bit first, so the elevated relaunch is 64-bit too.
        $childExit = Assert-64BitProcess -Parameters $Parameters
        if ($null -eq $childExit) { $childExit = Assert-Admin -Parameters $Parameters }
        if ($null -ne $childExit) { $relaunched = $true; return $childExit }

        $paths = Get-KioskPaths
        $installDir = $paths.Install
        $state = $null
        if ($Parameters.Resume) {
            $statePath = Join-KioskPath $installDir 'install-state.json'
            if ($SelfPath) { $statePath = Join-KioskPath (Split-Path -Parent $SelfPath) 'install-state.json' }
            $state = Read-ResumeState -Path $statePath
            if (-not $state) { throw "Nothing to resume ($statePath is missing). Run the install command again." }
            # The environment of the first run (RunOnce starts with a clean one).
            foreach ($n in $KioskEnvNames) {
                if ($state.arguments.ContainsKey("env:$n")) { [Environment]::SetEnvironmentVariable($n, [string]$state.arguments["env:$n"]) }
            }
            foreach ($k in @('ApiUrl', 'PortalUrl', 'Channel', 'Yes', 'StartFresh')) {
                if ($state.arguments.ContainsKey($k) -and -not $Parameters.ContainsKey($k)) { $Parameters[$k] = $state.arguments[$k] }
            }
            if ($Parameters.Yes) { $script:AssumeYes = $true }
            $paths = Get-KioskPaths
            $installDir = $paths.Install
        }
        Assert-SafeRemovePath -Label 'The install folder (KIOSK_DIR)' -Path $installDir -MinComponents 1
        if (-not $Parameters.Uninstall) { Test-KioskInstallDir -Path $installDir }
        $saved = Read-KioskConfig -Path (Join-KioskPath $installDir 'config.env')
        # Before the install folder's ACL (Users may read) is applied anywhere.
        if (-not $Parameters.Uninstall) { Assert-KioskDataDirPlacement -InstallDir $installDir -DataDir (Get-UninstallDataDir -Saved $saved) }
        $desktopUser = Get-DesktopUser

        if ($Parameters.Uninstall) {
            if (Test-Path -LiteralPath $installDir) { $logging = Start-InstallLog -InstallDir $installDir }
            # Only the data folder from the saved config: a damaged setting elsewhere must not block uninstall.
            Uninstall-Kiosk -InstallDir $installDir -DataDir (Get-UninstallDataDir -Saved $saved) -PurgeData:([bool]$Parameters.PurgeData) -DesktopUser $desktopUser
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
        $resumeArgs = @{ ApiUrl = $cfg.EDGE_CLOUD_API_URL; PortalUrl = $cfg.EDGE_PORTAL_URL; Channel = $cfg.KIOSK_CHANNEL; Yes = [bool]$Parameters.Yes; StartFresh = [bool]$Parameters.StartFresh }
        foreach ($n in $KioskEnvNames) {
            $v = [Environment]::GetEnvironmentVariable($n)
            if ($v) { $resumeArgs["env:$n"] = $v }
        }

        Add-DockerToPath
        if (-not $state -or $state.step -ne 'engine') {
            Install-DockerDesktop -InstallDir $installDir -ResumeArguments $resumeArgs -DesktopUser $desktopUser
        }
        # Every run once Docker is there (a resume at 'engine' and a plain re-run too).
        Confirm-DockerUsersMember -InstallDir $installDir -ResumeArguments $resumeArgs -DesktopUser $desktopUser
        Enable-DockerAutostart -DesktopUser $desktopUser
        Wait-DockerEngine -Seconds 180
        Assert-Compose
        New-KioskDataDir -DataDir $cfg.KIOSK_DATA_DIR -DesktopUser $desktopUser
        Write-KioskConfig -Path (Join-KioskPath $installDir 'config.env') -Config $cfg
        $compose = Join-KioskPath $installDir 'docker-compose.yml'
        $imageRef = Get-ImageRef -Channel $cfg.KIOSK_CHANNEL
        Write-TextFile -Path $compose -Text (Get-ComposeText -ImageRef $imageRef -DataDir $cfg.KIOSK_DATA_DIR)
        Set-KioskFileAcl -Path $compose
        Invoke-LegacyMigration -UserProfile $profilePath -DataDir $cfg.KIOSK_DATA_DIR -StartFresh:([bool]$Parameters.StartFresh) | Out-Null
        $identity = Start-Kiosk -InstallDir $installDir -ImageRef $imageRef -Channel $cfg.KIOSK_CHANNEL
        Install-LoginItems -InstallDir $installDir -DesktopUser $desktopUser -DataDir $cfg.KIOSK_DATA_DIR
        Remove-ResumeRegistration -InstallDir $installDir
        Write-Summary -Identity $identity -Config $cfg -InstallDir $installDir -DesktopUser $desktopUser
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
        # The elevated child and a RunOnce resume run in their own window: keep it open to read.
        if (-not $relaunched -and ($env:KIOSK_ELEVATED_CHILD -eq '1' -or $Parameters.Resume) -and (Test-CanPause)) {
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
