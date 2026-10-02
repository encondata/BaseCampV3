<#
.SYNOPSIS
ServerSherpa kiosk host-network helper (laptop edition), Windows.

.DESCRIPTION
Installed by install.ps1 next to update.ps1 and run by the scheduled task
"ServerSherpa Kiosk Host Network" (hidden, at sign-in and every minute) as the
signed-in user, whom the data folder's permissions give full control. The
Windows port of hostnet.sh.

Writes <data folder>\host-network.json, the laptop's LAN addresses, for the
edge (edge/hostnet.py), atomically:
  {"updated_at":"2026-10-01T18:00:00Z",
   "interfaces":[{"name":"Ethernet","ipv4":"10.10.48.57","prefix":24}]}
Built-in cmdlets only: Get-NetIPAddress -AddressFamily IPv4 joined with
Get-NetAdapter -Physical (adapters that are up). Skips loopback, link-local,
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
# of the physical adapters that are up, as name/ipv4/prefix entries.
function ConvertTo-HostInterfaceList {
    param([object[]]$Addresses = @(), [object[]]$Adapters = @())
    $up = @{}
    foreach ($a in $Adapters) { if ("$($a.Status)" -eq 'Up') { $up[[int]$a.ifIndex] = $true } }
    foreach ($addr in $Addresses) {
        if (-not $up.ContainsKey([int]$addr.InterfaceIndex)) { continue }
        $name = [string]$addr.InterfaceAlias
        if ($name -match $HostnetExcludedNames) { continue }
        $ip = [string]$addr.IPAddress
        $prefix = [int]$addr.PrefixLength
        if (-not (Test-HostnetAddress -IPAddress $ip -PrefixLength $prefix)) { continue }
        [ordered]@{ name = $name; ipv4 = $ip; prefix = $prefix }
    }
}

# ConvertTo-HostNetworkJson INTERFACES NOW: the file's JSON (updated_at in UTC).
function ConvertTo-HostNetworkJson {
    param([object[]]$Interfaces = @(), [Parameter(Mandatory = $true)][datetime]$Now)
    $stamp = $Now.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
    # Each entry on its own and the list joined by hand: Windows PowerShell 5.1
    # can serialize a wrapped array as {"value": [...], "Count": n}.
    $items = @(foreach ($i in $Interfaces) { ConvertTo-Json -InputObject $i -Compress })
    '{"updated_at":' + (ConvertTo-Json -InputObject $stamp -Compress) + ',"interfaces":[' + ($items -join ',') + ']}'
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
    $json = ConvertTo-HostNetworkJson -Interfaces $list -Now ([datetime]::UtcNow)
    if (Write-HostNetworkFile -DataDir (Get-HostnetDataDir) -Text $json) { return 0 }
    1
}

# Run only as the last statement, so a partly downloaded script runs nothing.
if ($LibraryOnly -or $env:KIOSK_HOSTNET_LIB -eq '1') { return }
exit (Invoke-HostNetwork)
