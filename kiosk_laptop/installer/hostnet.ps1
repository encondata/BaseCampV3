<#
.SYNOPSIS
ServerSherpa kiosk host-network helper (laptop edition), Windows.

.DESCRIPTION
Installed by install.ps1 next to update.ps1 and run by the scheduled task
"ServerSherpa Kiosk Host Network" (at startup and every minute) as SYSTEM,
which has full control of the data folder; in session 0, so no window ever
shows. The Windows port of hostnet.sh.

Writes <data folder>\host-network.json, the laptop's LAN addresses, for the
edge (edge/hostnet.py), atomically:
  {"updated_at":"2026-10-01T18:00:00Z",
   "interfaces":[{"name":"Ethernet","ipv4":"10.10.48.57","prefix":24}],
   "gateway":"10.10.48.1"}
Built-in cmdlets only: Get-NetIPAddress -AddressFamily IPv4 (AddressState
Preferred) joined with Get-NetAdapter -Physical (adapters that are up).
"gateway" is the next hop of the best default route (Get-NetRoute, lowest
RouteMetric + InterfaceMetric), omitted when there is none or it isn't a
usable IPv4 address.
Once a day it also refreshes hostnet.ps1 and launch.ps1 from the installer
ref (config.env's KIOSK_INSTALLER_REF), since the nightly update job runs as
the user and can't write this folder; the last result is in
helpers-refresh.json.
Skips loopback, link-local,
multicast, and Docker/WSL/Hyper-V/VPN/bridge adapters. Prints nothing; exits
1 (keeping the old file, which then goes stale) when it can't read or write.

The data folder: KIOSK_DATA_DIR, else config.env's KIOSK_DATA_DIR, else the
default. Testing hooks: -LibraryOnly or KIOSK_HOSTNET_LIB=1 defines the
functions without running. Written for Windows PowerShell 5.1 and kept plain ASCII.

.PARAMETER LibraryOnly
Define the functions and return without running (for Pester).
#>
[CmdletBinding()]
param([switch]$LibraryOnly)

$HostnetScriptDir = $PSScriptRoot
$HostNetworkFile = 'host-network.json'
# Docker, WSL, Hyper-V, VPN/tunnel and bridge adapters (as hostnet.sh).
$HostnetExcludedNames = '^(docker|br-|veth|vethernet|utun|tun|tap|wg|bridge)'

# Get-HostnetDataDir: where host-network.json goes.
function Get-HostnetDataDir {
    if ($env:KIOSK_DATA_DIR) { return $env:KIOSK_DATA_DIR }
    $dir = $env:KIOSK_DIR
    if (-not $dir) { $dir = $HostnetScriptDir }
    $config = [IO.Path]::Combine($dir, 'config.env')
    if (Test-Path -LiteralPath $config -PathType Leaf) {
        foreach ($line in [IO.File]::ReadAllLines($config)) {
            if ($line -match '^KIOSK_DATA_DIR=(.+)$') { return $Matches[1].Trim() }
        }
    }
    $programData = $env:ProgramData
    if (-not $programData) { $programData = 'C:\ProgramData' }
    $programData + '\ServerSherpaKiosk\data'
}

# Test-HostnetAddress IP PREFIX: an address the edge will use (as
# edge/hostnet.py): dotted quad, prefix 0-32, not unspecified, loopback,
# link-local, multicast or broadcast.
function Test-HostnetAddress {
    param([string]$IPAddress, [int]$PrefixLength)
    if ($IPAddress -notmatch '^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$') { return $false }
    $o = @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3], [int]$Matches[4])
    foreach ($v in $o) { if ($v -gt 255) { return $false } }
    if ($PrefixLength -lt 0 -or $PrefixLength -gt 32) { return $false }
    if ($IPAddress -eq '0.0.0.0' -or $IPAddress -eq '255.255.255.255') { return $false }
    if ($o[0] -eq 127 -or ($o[0] -eq 169 -and $o[1] -eq 254) -or ($o[0] -ge 224 -and $o[0] -le 239)) { return $false }
    $true
}

# ConvertTo-HostInterfaceList ADDRESSES ADAPTERS: the usable IPv4 addresses
# of the physical adapters that are up, as name/ipv4/prefix entries. Only
# Preferred addresses: not Tentative (still being checked), Duplicate,
# Deprecated or Invalid.
function ConvertTo-HostInterfaceList {
    param([object[]]$Addresses = @(), [object[]]$Adapters = @())
    $up = @{}
    foreach ($a in $Adapters) { if ("$($a.Status)" -eq 'Up') { $up[[int]$a.ifIndex] = $true } }
    foreach ($addr in $Addresses) {
        if (-not $up.ContainsKey([int]$addr.InterfaceIndex)) { continue }
        if ("$($addr.AddressState)" -ne 'Preferred') { continue }
        $name = [string]$addr.InterfaceAlias
        if ($name -match $HostnetExcludedNames) { continue }
        $ip = [string]$addr.IPAddress
        $prefix = [int]$addr.PrefixLength
        if (-not (Test-HostnetAddress -IPAddress $ip -PrefixLength $prefix)) { continue }
        [ordered]@{ name = $name; ipv4 = $ip; prefix = $prefix }
    }
}

# Get-HostnetGateway ROUTES: the NextHop of the default route with the lowest
# RouteMetric + InterfaceMetric, skipping 0.0.0.0 (on-link) and any next hop
# the edge won't use; $null when nothing qualifies.
function Get-HostnetGateway {
    param([object[]]$Routes = @())
    $best = $null
    $bestMetric = [long]::MaxValue
    foreach ($r in $Routes) {
        $hop = [string]$r.NextHop
        if (-not (Test-HostnetAddress -IPAddress $hop -PrefixLength 32)) { continue }
        $metric = [long]$r.RouteMetric + [long]$r.InterfaceMetric
        if ($metric -lt $bestMetric) { $best = $hop; $bestMetric = $metric }
    }
    $best
}

# ConvertTo-HostNetworkJson INTERFACES NOW [GATEWAY]: the file's JSON
# (updated_at in UTC; "gateway" after the interfaces when GATEWAY is set).
function ConvertTo-HostNetworkJson {
    param([object[]]$Interfaces = @(), [Parameter(Mandatory = $true)][datetime]$Now, [string]$Gateway)
    $stamp = $Now.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
    # Each entry on its own and the list joined by hand: Windows PowerShell 5.1
    # can serialize a wrapped array as {"value": [...], "Count": n}.
    $items = @(foreach ($i in $Interfaces) { ConvertTo-Json -InputObject $i -Compress })
    $extra = ''
    if ($Gateway) { $extra = ',"gateway":' + (ConvertTo-Json -InputObject $Gateway -Compress) }
    '{"updated_at":' + (ConvertTo-Json -InputObject $stamp -Compress) + ',"interfaces":[' + ($items -join ',') + ']' + $extra + '}'
}

# Write-HostNetworkFile DIR TEXT: a temp file in DIR (UTF-8, no byte-order
# mark) moved over host-network.json, so the edge never reads half a file.
# Returns $false, quietly, when it can't.
function Write-HostNetworkFile {
    param([Parameter(Mandatory = $true)][string]$DataDir, [Parameter(Mandatory = $true)][string]$Text)
    if (-not (Test-Path -LiteralPath $DataDir -PathType Container)) { return $false }
    $path = [IO.Path]::Combine($DataDir, $HostNetworkFile)
    $tmp = [IO.Path]::Combine($DataDir, ".$HostNetworkFile.$([guid]::NewGuid().ToString('N')).tmp")
    try {
        [IO.File]::WriteAllText($tmp, $Text, (New-Object Text.UTF8Encoding $false))
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            [IO.File]::Replace($tmp, $path, [NullString]::Value)   # $null would arrive as ""
        } else {
            [IO.File]::Move($tmp, $path)
        }
        return $true
    } catch {
        return $false
    } finally {
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    }
}

# Invoke-HostNetwork: one run; returns the exit code (0 written, 1 not).
function Invoke-HostNetwork {
    try {
        $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop)
        $adapters = @(Get-NetAdapter -Physical -ErrorAction Stop)
    } catch {
        return 1
    }
    $list = @(ConvertTo-HostInterfaceList -Addresses $addresses -Adapters $adapters)
    # No default route, or a failing cmdlet, only means no gateway.
    $gateway = $null
    try {
        $routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue)
        $gateway = Get-HostnetGateway -Routes $routes
    } catch {
        $gateway = $null
    }
    $json = ConvertTo-HostNetworkJson -Interfaces $list -Now ([datetime]::UtcNow) -Gateway $gateway
    if (Write-HostNetworkFile -DataDir (Get-HostnetDataDir) -Text $json) { return 0 }
    1
}

# -- Helper-script refresh ----------------------------------------------------
# The nightly update job runs as the signed-in user, who can't write the
# install folder (and must not be able to: SYSTEM runs these scripts). This
# task is SYSTEM, so it refreshes hostnet.ps1 and launch.ps1 itself, at most
# once every 24 hours, from the ref the laptop was installed from. The result
# of the last attempt is in helpers-refresh.json next to the scripts.
$HelperScripts = @('hostnet.ps1', 'launch.ps1')
$HelperRefreshFile = 'helpers-refresh.json'
$HelperRefreshHours = 24

function Get-HostnetInstallDir {
    $dir = $env:KIOSK_DIR
    if (-not $dir) { $dir = $HostnetScriptDir }
    $dir
}

# Get-HostnetInstallerRef: config.env's KIOSK_INSTALLER_REF when it is a plain
# git ref (letters, digits, . _ / -, no ".."), else main.
function Get-HostnetInstallerRef {
    $config = [IO.Path]::Combine((Get-HostnetInstallDir), 'config.env')
    if (Test-Path -LiteralPath $config -PathType Leaf) {
        foreach ($line in [IO.File]::ReadAllLines($config)) {
            if ($line.TrimEnd("`r") -match '^KIOSK_INSTALLER_REF=(.+)$') {
                $ref = $Matches[1].Trim()
                if ($ref -match '^[A-Za-z0-9._/-]+$' -and $ref -notlike '*..*') { return $ref }
                return 'main'
            }
        }
    }
    'main'
}

# Get-HostnetHelperText NAME: KIOSK_TEMPLATE_DIR's copy (tests), else downloaded
# (30-second timeout, so a dead network can't hold up this every-minute task).
function Get-HostnetHelperText {
    param([Parameter(Mandatory = $true)][string]$Name)
    if ($env:KIOSK_TEMPLATE_DIR) { return [IO.File]::ReadAllText([IO.Path]::Combine($env:KIOSK_TEMPLATE_DIR, $Name)) }
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch { Write-Verbose 'TLS 1.2 is already the default here.' }
    $url = "https://raw.githubusercontent.com/encondata/BaseCampV3/$(Get-HostnetInstallerRef)/kiosk_laptop/installer/$Name"
    $c = (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 30).Content
    if ($c -is [byte[]]) { $c = [Text.Encoding]::UTF8.GetString($c) }
    [string]$c
}

# Get-HostnetHelperProblem TEXT: why a downloaded script can't be used, or $null.
function Get-HostnetHelperProblem {
    param([AllowEmptyString()][string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return 'empty' }
    if ($Text -match '[^\x00-\x7F]') { return 'not plain ASCII' }
    $tokens = $null; $errors = $null
    [void][Management.Automation.Language.Parser]::ParseInput($Text, [ref]$tokens, [ref]$errors)
    if ($errors -and $errors.Count -gt 0) { return 'syntax error' }
    if ($Text -notmatch '(?s)^\s*(<#.*?#>|(#[^\n]*\n\s*)+)' -or $Matches[1] -notlike '*ServerSherpa*') { return 'not a ServerSherpa script' }
    $null
}

# Sync-HostnetHelper NAME: "refreshed", "unchanged" or "failed (why)". The
# old file stays on any failure; a temp file is moved over it, so nothing
# reads half a script.
function Sync-HostnetHelper {
    param([Parameter(Mandatory = $true)][string]$Name)
    $cur = [IO.Path]::Combine((Get-HostnetInstallDir), $Name)
    $tmp = "$cur.kiosk-tmp"
    try {
        try { $text = Get-HostnetHelperText -Name $Name } catch { return 'failed (download)' }
        $why = Get-HostnetHelperProblem -Text $text
        if ($why) { return "failed ($why)" }
        if ((Test-Path -LiteralPath $cur -PathType Leaf) -and ([IO.File]::ReadAllText($cur) -ceq $text)) { return 'unchanged' }
        try { [IO.File]::WriteAllText($tmp, $text, (New-Object Text.UTF8Encoding $false)) }
        catch { return 'failed (write)' }
        try {
            if (Test-Path -LiteralPath $cur -PathType Leaf) { [IO.File]::Replace($tmp, $cur, [NullString]::Value) }
            else { [IO.File]::Move($tmp, $cur) }
        } catch { return 'failed (replace)' }
        'refreshed'
    } finally {
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    }
}

# Test-HelperRefreshDue MARKER: $true unless the marker's checked_at is
# less than 24 hours old (missing, unreadable or in the future counts as due).
function Test-HelperRefreshDue {
    param([Parameter(Mandatory = $true)][string]$MarkerPath)
    try {
        $m = [IO.File]::ReadAllText($MarkerPath) | ConvertFrom-Json
        $at = [datetime]::Parse([string]$m.checked_at, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal)
        $age = [datetime]::UtcNow - $at
        return ($age.TotalHours -ge $HelperRefreshHours -or $age.TotalSeconds -lt 0)
    } catch { return $true }
}

# Invoke-HelperRefresh: once a day, hostnet.ps1 and launch.ps1 (never
# update.ps1). The marker is written first, so a run that stalls or dies
# isn't retried every minute, and again with the results. A refreshed
# hostnet.ps1 takes effect on the next minute's run. Never throws.
function Invoke-HelperRefresh {
    try {
        $marker = [IO.Path]::Combine((Get-HostnetInstallDir), $HelperRefreshFile)
        if (-not (Test-HelperRefreshDue -MarkerPath $marker)) { return }
        $stamp = [datetime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
        $utf8 = New-Object Text.UTF8Encoding $false
        [IO.File]::WriteAllText($marker, '{"checked_at":"' + $stamp + '"}', $utf8)
        $results = @()
        foreach ($name in $HelperScripts) {
            $r = 'failed (error)'
            try { $r = Sync-HostnetHelper -Name $name } catch { $r = 'failed (error)' }
            $results += ConvertTo-Json -InputObject $name -Compress
            $results[-1] += ':' + (ConvertTo-Json -InputObject ([string]$r) -Compress)
        }
        [IO.File]::WriteAllText($marker, '{"checked_at":"' + $stamp + '","ref":' + (ConvertTo-Json -InputObject (Get-HostnetInstallerRef) -Compress) + ',"results":{' + ($results -join ',') + '}}', $utf8)
    } catch {
        Write-Verbose "Helper refresh skipped: $($_.Exception.Message)"
    }
}

# Invoke-HostnetMain: the network file first; then the daily refresh, which
# can't change the exit code.
function Invoke-HostnetMain {
    $rc = Invoke-HostNetwork
    try { Invoke-HelperRefresh } catch { Write-Verbose 'Helper refresh failed.' }
    $rc
}

# Run only as the last statement, so a partly downloaded script runs nothing.
if ($LibraryOnly -or $env:KIOSK_HOSTNET_LIB -eq '1') { return }
exit (Invoke-HostnetMain)
