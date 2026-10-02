# hostnet.ps1: the Windows host-network helper (spec section 2.1), the port of
# hostnet.sh. Mirrors tests/test_hostnet_sh.py: Get-NetIPAddress and
# Get-NetAdapter -Physical are fed as plain objects (mocked in the run test).

# Pester idiom: variables set in BeforeAll/BeforeEach are used in It blocks,
# which PSScriptAnalyzer can't see.
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseDeclaredVarsMoreThanAssignments', '')]
param()

BeforeAll {
    $script:SavedEnv = @{}
    foreach ($n in @('KIOSK_HOSTNET_LIB', 'KIOSK_DIR', 'KIOSK_DATA_DIR')) {
        $script:SavedEnv[$n] = [Environment]::GetEnvironmentVariable($n)
    }
    $env:KIOSK_HOSTNET_LIB = '1'
    . "$PSScriptRoot/../hostnet.ps1" -LibraryOnly

    # Windows-only cmdlets: stubs where they don't exist (macOS/Linux pwsh), so Pester can mock them.
    $stubs = @{
        'Get-NetIPAddress' = 'param([string]$AddressFamily)'
        'Get-NetAdapter'   = 'param([switch]$Physical)'
    }
    foreach ($name in $stubs.Keys) {
        if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
            Set-Item -Path "function:global:$name" -Value ([scriptblock]::Create("[CmdletBinding()] $($stubs[$name]) throw 'stub: $name is Windows-only'"))
        }
    }

    function Get-FakeAddress {
        param([string]$Alias, [int]$Index, [string]$Ip, [int]$Prefix, [string]$State = 'Preferred')
        [pscustomobject]@{ InterfaceAlias = $Alias; InterfaceIndex = $Index; IPAddress = $Ip; PrefixLength = [byte]$Prefix; AddressFamily = 'IPv4'; AddressState = $State }
    }
    function Get-FakeAdapter {
        param([string]$Name, [int]$Index, [string]$Status = 'Up')
        [pscustomobject]@{ Name = $Name; InterfaceAlias = $Name; ifIndex = $Index; Status = $Status }
    }

    # What Get-NetIPAddress -AddressFamily IPv4 and Get-NetAdapter -Physical
    # return on a laptop with Docker Desktop/WSL, a VPN and a dead Wi-Fi.
    $script:Addresses = @(
        (Get-FakeAddress 'Loopback Pseudo-Interface 1' 1 '127.0.0.1' 8),
        (Get-FakeAddress 'Ethernet' 12 '10.10.48.57' 24),
        (Get-FakeAddress 'Ethernet' 12 '10.10.50.9' 23),
        (Get-FakeAddress 'Wi-Fi' 14 '192.168.1.20' 24),
        (Get-FakeAddress 'vEthernet (WSL (Hyper-V firewall))' 40 '172.25.160.1' 20),
        (Get-FakeAddress 'vEthernet (Default Switch)' 41 '172.30.0.1' 20),
        (Get-FakeAddress 'WireGuard Tunnel' 50 '10.8.0.2' 24),
        (Get-FakeAddress 'Ethernet 2' 16 '169.254.33.4' 16),
        (Get-FakeAddress 'Ethernet 3' 18 '172.20.10.3' 28),
        (Get-FakeAddress 'Ethernet 3' 18 '172.20.10.9' 28 'Tentative'),
        (Get-FakeAddress 'Ethernet 3' 18 '172.20.10.10' 28 'Duplicate'),
        (Get-FakeAddress 'Ethernet' 12 '10.10.48.99' 24 'Deprecated')
    )
    $script:Adapters = @(
        (Get-FakeAdapter 'Ethernet' 12),
        (Get-FakeAdapter 'Wi-Fi' 14 'Disconnected'),
        (Get-FakeAdapter 'Ethernet 2' 16),
        (Get-FakeAdapter 'Ethernet 3' 18)
    )
}

AfterAll {
    foreach ($n in $script:SavedEnv.Keys) { [Environment]::SetEnvironmentVariable($n, $script:SavedEnv[$n]) }
}

Describe 'ConvertTo-HostInterfaceList' {
    It 'keeps the IPv4 addresses of physical adapters that are up, minus unusable ones' {
        $list = @(ConvertTo-HostInterfaceList -Addresses $script:Addresses -Adapters $script:Adapters)
        ($list | ForEach-Object { "$($_.name)|$($_.ipv4)|$($_.prefix)" }) -join ';' |
            Should -Be 'Ethernet|10.10.48.57|24;Ethernet|10.10.50.9|23;Ethernet 3|172.20.10.3|28'
        $list[0].prefix | Should -BeOfType [int]
    }
    It 'keeps only addresses whose AddressState is Preferred: <_>' -ForEach @('Tentative', 'Duplicate', 'Deprecated', 'Invalid', '') {
        $a = @(Get-FakeAddress 'Ethernet' 12 '10.10.48.57' 24 $_)
        @(ConvertTo-HostInterfaceList -Addresses $a -Adapters @(Get-FakeAdapter 'Ethernet' 12)).Count | Should -Be 0
    }
    It 'returns nothing when no adapter is up' {
        @(ConvertTo-HostInterfaceList -Addresses $script:Addresses -Adapters @()).Count | Should -Be 0
    }
    It 'drops virtual adapter names even when they are physical: <_>' -ForEach @('docker0', 'br-abc', 'veth12', 'vEthernet (WSL)', 'utun0', 'tun0', 'TAP-Windows Adapter', 'wg0', 'Bridge 1') {
        $a = @(Get-FakeAddress $_ 7 '10.0.0.5' 24)
        @(ConvertTo-HostInterfaceList -Addresses $a -Adapters @(Get-FakeAdapter $_ 7)).Count | Should -Be 0
    }
}

Describe 'Test-HostnetAddress' {
    It 'refuses <Ip>/<Prefix>' -ForEach @(
        @{ Ip = '127.0.0.1'; Prefix = 8 }, @{ Ip = '169.254.1.1'; Prefix = 16 }, @{ Ip = '0.0.0.0'; Prefix = 0 },
        @{ Ip = '224.0.0.1'; Prefix = 4 }, @{ Ip = '239.1.1.1'; Prefix = 8 }, @{ Ip = '255.255.255.255'; Prefix = 32 },
        @{ Ip = '10.0.0.256'; Prefix = 24 }, @{ Ip = '10.0.0'; Prefix = 24 }, @{ Ip = '10.1'; Prefix = 24 },
        @{ Ip = '10.0.0.5'; Prefix = 33 }, @{ Ip = '10.0.0.5'; Prefix = -1 }, @{ Ip = 'a.b.c.d'; Prefix = 24 }
    ) {
        Test-HostnetAddress -IPAddress $Ip -PrefixLength $Prefix | Should -BeFalse
    }
    It 'accepts LAN addresses' {
        Test-HostnetAddress -IPAddress '10.10.48.57' -PrefixLength 24 | Should -BeTrue
        Test-HostnetAddress -IPAddress '192.168.1.20' -PrefixLength 32 | Should -BeTrue
        Test-HostnetAddress -IPAddress '172.16.0.1' -PrefixLength 0 | Should -BeTrue
    }
}

Describe 'ConvertTo-HostNetworkJson' {
    It 'writes the edge contract: updated_at in UTC, then the interfaces' {
        $now = [datetime]::SpecifyKind([datetime]'2026-10-01T18:00:00', [DateTimeKind]::Utc)
        $list = @(ConvertTo-HostInterfaceList -Addresses $script:Addresses -Adapters $script:Adapters)
        $text = ConvertTo-HostNetworkJson -Interfaces $list -Now $now
        $text | Should -BeLike '{"updated_at":"2026-10-01T18:00:00Z","interfaces":*'
        $o = $text | ConvertFrom-Json
        $o.interfaces.Count | Should -Be 3
        $o.interfaces[0].name | Should -Be 'Ethernet'
        $o.interfaces[0].ipv4 | Should -Be '10.10.48.57'
        $o.interfaces[0].prefix | Should -Be 24
    }
    It 'keeps a single interface as a list, and no interfaces as an empty list' {
        $now = [datetime]::UtcNow
        $one = @([ordered]@{ name = 'Wi-Fi "5G"'; ipv4 = '192.168.1.20'; prefix = 24 })
        $t1 = ConvertTo-HostNetworkJson -Interfaces $one -Now $now
        $t1 | Should -BeLike '*"interfaces":`[{*'
        ($t1 | ConvertFrom-Json).interfaces[0].name | Should -Be 'Wi-Fi "5G"'
        ConvertTo-HostNetworkJson -Interfaces @() -Now $now | Should -BeLike '*"interfaces":`[`]}'
    }
    It 'converts a local time to UTC' {
        $local = [datetime]::SpecifyKind([datetime]'2026-10-01T12:00:00', [DateTimeKind]::Local)
        $expected = $local.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", [Globalization.CultureInfo]::InvariantCulture)
        (ConvertTo-HostNetworkJson -Interfaces @() -Now $local) | Should -BeLike "*`"updated_at`":`"$expected`"*"
    }
}

Describe 'Write-HostNetworkFile' {
    BeforeEach {
        $script:data = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        New-Item -ItemType Directory $script:data | Out-Null
    }
    It 'replaces host-network.json atomically and leaves no temp file' {
        [IO.File]::WriteAllText((Join-Path $script:data 'host-network.json'), 'old')
        Write-HostNetworkFile -DataDir $script:data -Text '{"a":1}' | Should -BeTrue
        [IO.File]::ReadAllText((Join-Path $script:data 'host-network.json')) | Should -Be '{"a":1}'
        @(Get-ChildItem -LiteralPath $script:data -Force).Name | Should -Be @('host-network.json')
    }
    It 'creates it when missing, as UTF-8 without a byte-order mark' {
        Write-HostNetworkFile -DataDir $script:data -Text '{}' | Should -BeTrue
        $bytes = [IO.File]::ReadAllBytes((Join-Path $script:data 'host-network.json'))
        $bytes[0] | Should -Be ([byte][char]'{')
    }
    It 'returns false, quietly, when the folder is missing' {
        Write-HostNetworkFile -DataDir (Join-Path $script:data 'none') -Text '{}' | Should -BeFalse
    }
}

Describe 'Get-HostnetDataDir' {
    BeforeEach {
        $script:dir = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        New-Item -ItemType Directory $script:dir | Out-Null
        $env:KIOSK_DIR = $script:dir
    }
    AfterEach { $env:KIOSK_DIR = $null; $env:KIOSK_DATA_DIR = $null }
    It 'uses KIOSK_DATA_DIR, then config.env, then the default' {
        $env:KIOSK_DATA_DIR = 'D:\from-env'
        Get-HostnetDataDir | Should -Be 'D:\from-env'
        $env:KIOSK_DATA_DIR = $null
        [IO.File]::WriteAllText((Join-Path $script:dir 'config.env'), "EDGE_CLOUD_API_URL=x`nKIOSK_DATA_DIR=E:\from-config`n")
        Get-HostnetDataDir | Should -Be 'E:\from-config'
        [IO.File]::WriteAllText((Join-Path $script:dir 'config.env'), "KIOSK_CHANNEL=stable`n")
        Get-HostnetDataDir | Should -BeLike '*\ServerSherpaKiosk\data'
    }
}

Describe 'Invoke-HostNetwork' {
    BeforeEach {
        $script:data = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        New-Item -ItemType Directory $script:data | Out-Null
        $env:KIOSK_DATA_DIR = $script:data
        Mock Get-NetIPAddress { $script:Addresses } -ParameterFilter { $AddressFamily -eq 'IPv4' }
        Mock Get-NetAdapter { $script:Adapters } -ParameterFilter { $Physical }
    }
    AfterEach { $env:KIOSK_DATA_DIR = $null }
    It 'writes the file from the two cmdlets and returns 0, printing nothing' {
        $out = @(Invoke-HostNetwork)
        $out | Should -Be @(0)
        $o = [IO.File]::ReadAllText((Join-Path $script:data 'host-network.json')) | ConvertFrom-Json
        @($o.interfaces | ForEach-Object { $_.ipv4 }) -join ',' | Should -Be '10.10.48.57,10.10.50.9,172.20.10.3'
        $age = ([datetime]::UtcNow - [datetime]::Parse($o.updated_at, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal)).TotalSeconds
        [math]::Abs($age) | Should -BeLessThan 60
    }
    It 'keeps the old file and returns 1 when a cmdlet fails' {
        Mock Get-NetAdapter { throw 'no CIM' } -ParameterFilter { $Physical }
        [IO.File]::WriteAllText((Join-Path $script:data 'host-network.json'), 'old')
        Invoke-HostNetwork | Should -Be 1
        [IO.File]::ReadAllText((Join-Path $script:data 'host-network.json')) | Should -Be 'old'
    }
    It 'returns 1 when the data folder is missing' {
        $env:KIOSK_DATA_DIR = Join-Path $script:data 'none'
        Invoke-HostNetwork | Should -Be 1
    }
}

Describe 'hostnet.ps1 hygiene' {
    It 'is plain ASCII, so Windows PowerShell 5.1 reads it correctly without a byte-order mark' {
        $bytes = [System.IO.File]::ReadAllBytes((Join-Path $PSScriptRoot '../hostnet.ps1'))
        ($bytes | Where-Object { $_ -gt 127 }).Count | Should -Be 0
    }
}
