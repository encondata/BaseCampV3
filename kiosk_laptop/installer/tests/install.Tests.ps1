# Pester idiom: variables set in BeforeAll/BeforeEach are used in It blocks,
# which PSScriptAnalyzer can't see.
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseDeclaredVarsMoreThanAssignments', '')]
param()

BeforeAll {
    $script:SavedEnv = @{}
    foreach ($n in @('KIOSK_INSTALL_LIB', 'KIOSK_TEMPLATE_DIR', 'KIOSK_DIR', 'KIOSK_DATA_DIR', 'KIOSK_IMAGE', 'KIOSK_CONFIRM_PURGE', 'EDGE_DATA_HOST_DIR',
            'KIOSK_NONINTERACTIVE', 'KIOSK_ELEVATED_CHILD')) {
        $script:SavedEnv[$n] = [Environment]::GetEnvironmentVariable($n)
    }
    $env:KIOSK_INSTALL_LIB = '1'
    $env:KIOSK_TEMPLATE_DIR = (Resolve-Path "$PSScriptRoot/..").Path
    . "$PSScriptRoot/../install.ps1" -LibraryOnly

    # Windows-only cmdlets: stubs where they don't exist (macOS/Linux pwsh), so Pester can mock them.
    $stubs = @{
        'Get-WindowsOptionalFeature'    = 'param([switch]$Online, [string]$FeatureName)'
        'Enable-WindowsOptionalFeature' = 'param([switch]$Online, [string]$FeatureName, [switch]$All, [switch]$NoRestart)'
        'Get-LocalGroupMember'          = 'param([string]$Group, $SID)'
        'Add-LocalGroupMember'          = 'param([string]$Group, $Member)'
        'Get-AuthenticodeSignature'     = 'param([string]$FilePath)'
        'New-ScheduledTaskAction'       = 'param([string]$Execute, [string]$Argument)'
        'New-ScheduledTaskPrincipal'    = 'param([string]$UserId, [string]$LogonType, [string]$RunLevel)'
        'New-ScheduledTaskTrigger'      = 'param([switch]$Daily, [switch]$AtStartup, [switch]$Once, $At, $RepetitionInterval)'
        'New-ScheduledTaskSettingsSet'  = 'param([switch]$StartWhenAvailable, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries, [switch]$Hidden, $MultipleInstances, $ExecutionTimeLimit)'
        'Register-ScheduledTask'        = 'param([string]$TaskName, $Action, $Principal, $Trigger, $Settings, [string]$Description, [switch]$Force)'
        'Start-ScheduledTask'           = 'param([string]$TaskName)'
        'Stop-ScheduledTask'            = 'param([string]$TaskName)'
        'Get-ScheduledTask'             = 'param([string]$TaskName)'
        'Unregister-ScheduledTask'      = 'param([string]$TaskName, [switch]$Confirm)'
        'Set-Acl'                       = 'param([string]$LiteralPath, $AclObject)'
        'Get-Acl'                       = 'param([string]$LiteralPath)'
    }
    foreach ($name in $stubs.Keys) {
        if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
            Set-Item -Path "function:global:$name" -Value ([scriptblock]::Create("[CmdletBinding()] $($stubs[$name]) throw 'stub: $name is Windows-only'"))
        }
    }
}

AfterAll {
    foreach ($n in $script:SavedEnv.Keys) { [Environment]::SetEnvironmentVariable($n, $script:SavedEnv[$n]) }
}

Describe 'Windows support gate' {
    It 'accepts Windows 10 22H2 and 11 client builds' {
        Test-WindowsSupported -Build 19045 -ProductType 1 | Should -BeTrue
        Test-WindowsSupported -Build 22631 -ProductType 1 | Should -BeTrue
    }
    It 'refuses older builds and Server' {
        Test-WindowsSupported -Build 19044 -ProductType 1 | Should -BeFalse
        Test-WindowsSupported -Build 20348 -ProductType 3 | Should -BeFalse
    }
}

Describe 'Paths' {
    It 'defaults under ProgramData and honors overrides' {
        $env:KIOSK_DIR = $null; $env:KIOSK_DATA_DIR = $null
        (Get-KioskPaths).Install | Should -Be 'C:\ProgramData\ServerSherpaKiosk'
        (Get-KioskPaths).Data | Should -Be 'C:\ProgramData\ServerSherpaKiosk\data'
        $env:KIOSK_DIR = 'D:\K'; (Get-KioskPaths).Install | Should -Be 'D:\K'; $env:KIOSK_DIR = $null
    }
}

Describe 'Portal URL' {
    It 'derives portal from api' {
        Get-PortalUrl -ApiUrl 'https://api.serversherpa.com' | Should -Be 'https://portal.serversherpa.com'
        Get-PortalUrl -ApiUrl 'http://10.0.0.5:8000' | Should -Be ''
    }
}

Describe 'Config' {
    It 'keeps saved values, lets options win, defaults otherwise' {
        $saved = @{ EDGE_CLOUD_API_URL = 'https://api.a.com'; KIOSK_CHANNEL = 'edge' }
        (Merge-KioskConfig -Saved $saved -Options @{}).EDGE_CLOUD_API_URL | Should -Be 'https://api.a.com'
        (Merge-KioskConfig -Saved $saved -Options @{ ApiUrl = 'https://api.b.com' }).EDGE_CLOUD_API_URL | Should -Be 'https://api.b.com'
        $d = Merge-KioskConfig -Saved @{} -Options @{}
        $d.EDGE_CLOUD_API_URL | Should -Be 'https://api.serversherpa.com'
        $d.EDGE_PORTAL_URL | Should -Be 'https://portal.serversherpa.com'
        $d.KIOSK_CHANNEL | Should -Be 'stable'
    }
    It 'rejects an unknown channel' {
        { Merge-KioskConfig -Saved @{} -Options @{ Channel = 'nightly' } } | Should -Throw '*channel*'
    }
    It 'round-trips through config.env and rejects unsafe values' {
        $p = Join-Path $TestDrive 'config.env'
        $c = @{ EDGE_CLOUD_API_URL = 'https://api.a.com'; EDGE_PORTAL_URL = ''; KIOSK_CHANNEL = 'stable'; KIOSK_DATA_DIR = 'C:\d'; KIOSK_BROWSER = '' }
        Write-KioskConfig -Path $p -Config $c -SkipAcl
        (Read-KioskConfig -Path $p).EDGE_CLOUD_API_URL | Should -Be 'https://api.a.com'
        $c.EDGE_CLOUD_API_URL = 'https://x.com/$(whoami)'
        { Write-KioskConfig -Path $p -Config $c -SkipAcl } | Should -Throw
    }
}

Describe 'Compose file' {
    It 'renders image, the UI and reader ports on all interfaces, and a forward-slash data path' {
        $t = Get-ComposeText -ImageRef 'ghcr.io/encondata/serversherpa-kiosk-laptop:stable' -DataDir 'C:\ProgramData\ServerSherpaKiosk\data'
        $t | Should -Match 'image: ghcr.io/encondata/serversherpa-kiosk-laptop:stable'
        $t | Should -Match '"C:/ProgramData/ServerSherpaKiosk/data:/data"'
        $t | Should -Match '- "0\.0\.0\.0:8090:8090"'
        $t | Should -Match '- "0\.0\.0\.0:8091:8091"'
        $t | Should -Not -Match '127\.0\.0\.1'
    }
    It 'uses KIOSK_IMAGE when set' {
        $env:KIOSK_IMAGE = 'local/kiosk:test'
        Get-ImageRef -Channel stable | Should -Be 'local/kiosk:test'
        $env:KIOSK_IMAGE = $null
        Get-ImageRef -Channel edge | Should -Be 'ghcr.io/encondata/serversherpa-kiosk-laptop:edge'
    }
}

Describe 'Resume after reboot' {
    BeforeEach { Mock Set-KioskFileAcl {} }
    It 'saves and reads the step and arguments' {
        $p = Join-Path $TestDrive 'install-state.json'
        Save-ResumeState -Path $p -Step 'docker' -Arguments @{ ApiUrl = 'https://api.a.com'; Yes = $true }
        $s = Read-ResumeState -Path $p
        $s.step | Should -Be 'docker'
        $s.arguments.ApiUrl | Should -Be 'https://api.a.com'
    }
}

Describe 'Uninstall' {
    It 'keeps data unless purge is confirmed' {
        $inst = Join-Path $TestDrive 'inst'; $data = Join-Path $TestDrive 'data'
        New-Item -ItemType Directory $inst, $data | Out-Null
        'x' | Set-Content (Join-Path $inst 'config.env'); '{}' | Set-Content (Join-Path $data 'identity.json')
        'x' | Set-Content (Join-Path $inst 'hostnet.ps1')
        Mock Invoke-Docker {}
        Mock Remove-LoginItems {}
        Uninstall-Kiosk -InstallDir $inst -DataDir $data
        Test-Path (Join-Path $data 'identity.json') | Should -BeTrue
        Test-Path (Join-Path $inst 'config.env') | Should -BeFalse
        Test-Path (Join-Path $inst 'hostnet.ps1') | Should -BeFalse
        { Uninstall-Kiosk -InstallDir $inst -DataDir $data -PurgeData } | Should -Throw
        $env:KIOSK_CONFIRM_PURGE = 'DELETE'
        Uninstall-Kiosk -InstallDir $inst -DataDir $data -PurgeData
        Test-Path $data | Should -BeFalse
        $env:KIOSK_CONFIRM_PURGE = $null
    }
}

# -- Beyond the brief: the lessons from the reviewed shell installer -----

Describe 'Saved data folder' {
    AfterEach { $env:KIOSK_DATA_DIR = $null }
    It 'keeps a saved custom data folder on a re-run without the env' {
        $env:KIOSK_DATA_DIR = $null
        $saved = @{ KIOSK_DATA_DIR = 'D:\KioskData' }
        (Merge-KioskConfig -Saved $saved -Options @{}).KIOSK_DATA_DIR | Should -Be 'D:\KioskData'
    }
    It 'lets the env win over the saved folder' {
        $env:KIOSK_DATA_DIR = 'E:\Other'
        $saved = @{ KIOSK_DATA_DIR = 'D:\KioskData' }
        (Merge-KioskConfig -Saved $saved -Options @{}).KIOSK_DATA_DIR | Should -Be 'E:\Other'
    }
    It 'falls back to the default' {
        $env:KIOSK_DATA_DIR = $null
        (Merge-KioskConfig -Saved @{} -Options @{}).KIOSK_DATA_DIR | Should -Be 'C:\ProgramData\ServerSherpaKiosk\data'
    }
}

Describe 'Portal re-derivation' {
    It 'keeps a saved portal when the API URL is unchanged (ignoring trailing slashes)' {
        $saved = @{ EDGE_CLOUD_API_URL = 'https://api.a.com/'; EDGE_PORTAL_URL = 'https://custom.a.com' }
        (Merge-KioskConfig -Saved $saved -Options @{ ApiUrl = 'https://api.a.com//' }).EDGE_PORTAL_URL | Should -Be 'https://custom.a.com'
    }
    It 're-derives the portal when the API URL changes' {
        $saved = @{ EDGE_CLOUD_API_URL = 'https://api.a.com'; EDGE_PORTAL_URL = 'https://custom.a.com' }
        (Merge-KioskConfig -Saved $saved -Options @{ ApiUrl = 'https://api.b.com' }).EDGE_PORTAL_URL | Should -Be 'https://portal.b.com'
    }
    It 'lets an explicit portal win' {
        (Merge-KioskConfig -Saved @{} -Options @{ PortalUrl = 'https://p.example.com/' }).EDGE_PORTAL_URL | Should -Be 'https://p.example.com'
    }
    It 'warns when no portal can be derived' {
        Mock Write-Warn {}
        (Merge-KioskConfig -Saved @{} -Options @{ ApiUrl = 'http://10.0.0.5:8000' }).EDGE_PORTAL_URL | Should -Be ''
        Should -Invoke Write-Warn -Times 1 -ParameterFilter { $Message -like '*portal*' }
    }
}

Describe 'Data folder characters' {
    It 'accepts drive paths' {
        { Test-KioskDataDir -Path 'C:\ProgramData\ServerSherpaKiosk\data' } | Should -Not -Throw
        { Test-KioskDataDir -Path 'D:\Kiosk Data' } | Should -Not -Throw
    }
    It 'rejects quotes, newlines, $ and colons past the drive letter' {
        { Test-KioskDataDir -Path 'C:\a"b' } | Should -Throw
        { Test-KioskDataDir -Path "C:\a`nb" } | Should -Throw
        { Test-KioskDataDir -Path 'C:\a$b' } | Should -Throw
        { Test-KioskDataDir -Path 'C:\a:b' } | Should -Throw
        { Test-KioskDataDir -Path 'relative\data' } | Should -Throw
        { Test-KioskDataDir -Path '' } | Should -Throw
    }
}

Describe 'Config file contents' {
    It 'writes the five keys without a byte-order mark' {
        $p = Join-Path $TestDrive 'c2.env'
        $c = @{ EDGE_CLOUD_API_URL = 'https://api.a.com'; EDGE_PORTAL_URL = 'https://portal.a.com'; KIOSK_CHANNEL = 'edge'; KIOSK_DATA_DIR = 'C:\d'; KIOSK_BROWSER = 'C:\Program Files\Google\Chrome\Application\chrome.exe' }
        Write-KioskConfig -Path $p -Config $c -SkipAcl
        $bytes = [System.IO.File]::ReadAllBytes($p)
        $bytes[0] | Should -Be ([byte][char]'E')
        $lines = [System.IO.File]::ReadAllText($p) -split "`n" | Where-Object { $_ }
        ($lines | ForEach-Object { ($_ -split '=', 2)[0] }) -join ',' | Should -Be 'EDGE_CLOUD_API_URL,EDGE_PORTAL_URL,KIOSK_CHANNEL,KIOSK_DATA_DIR,KIOSK_BROWSER'
        (Read-KioskConfig -Path $p).KIOSK_BROWSER | Should -Be 'C:\Program Files\Google\Chrome\Application\chrome.exe'
    }
    It 'replaces an existing config.env on a re-run' {
        $p = Join-Path $TestDrive 'c3.env'
        $c = @{ EDGE_CLOUD_API_URL = 'https://api.a.com'; EDGE_PORTAL_URL = ''; KIOSK_CHANNEL = 'stable'; KIOSK_DATA_DIR = 'C:\d'; KIOSK_BROWSER = '' }
        Write-KioskConfig -Path $p -Config $c -SkipAcl
        $c.KIOSK_CHANNEL = 'edge'
        Write-KioskConfig -Path $p -Config $c -SkipAcl
        (Read-KioskConfig -Path $p).KIOSK_CHANNEL | Should -Be 'edge'
        Test-Path "$p.kiosk-tmp" | Should -BeFalse
    }
    It 'reads a missing file as empty' {
        (Read-KioskConfig -Path (Join-Path $TestDrive 'nope.env')).Count | Should -Be 0
    }
}

Describe 'Docker Desktop autostart setting' {
    It 'sets AutoStart and keeps every other key' {
        $p = Join-Path $TestDrive 'Docker/settings-store.json'
        New-Item -ItemType Directory (Split-Path $p) -Force | Out-Null
        '{ "AutoStart": false, "MemoryMiB": 4096, "Nested": { "a": [1, 2] } }' | Set-Content $p
        Set-DockerAutostart -Path $p
        $j = Get-Content $p -Raw | ConvertFrom-Json
        $j.AutoStart | Should -BeTrue
        $j.MemoryMiB | Should -Be 4096
        $j.Nested.a.Count | Should -Be 2
        Test-Path "$p.kiosk-tmp" | Should -BeFalse
    }
    It 'creates the file when missing' {
        $p = Join-Path $TestDrive 'NewDocker/settings-store.json'
        Set-DockerAutostart -Path $p
        (Get-Content $p -Raw | ConvertFrom-Json).AutoStart | Should -BeTrue
    }
    It 'leaves a file that is not a JSON object alone' {
        $p = Join-Path $TestDrive 'Weird/settings-store.json'
        New-Item -ItemType Directory (Split-Path $p) -Force | Out-Null
        '[1, 2]' | Set-Content $p
        Mock Write-Warn {}
        Set-DockerAutostart -Path $p
        (Get-Content $p -Raw).Trim() | Should -Be '[1, 2]'
        Should -Invoke Write-Warn -Times 1
    }
}

Describe 'Phase-1 data migration' {
    BeforeEach {
        $legacy = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        New-Item -ItemType Directory $legacy | Out-Null
        '{"serial":"K1"}' | Set-Content (Join-Path $legacy 'identity.json')
        # the phase-1 container, found by its compose label
        Mock Invoke-Docker { if ($Arguments[0] -eq 'ps') { 'abc123' } }
    }
    It 'copies into an absent data folder and stops the phase-1 kiosk' {
        $data = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        Copy-LegacyKioskData -LegacyDir $legacy -DataDir $data | Should -BeTrue
        Test-Path (Join-Path $data 'identity.json') | Should -BeTrue
        Test-Path (Join-Path $legacy 'identity.json') | Should -BeTrue
        Should -Invoke Invoke-Docker -ParameterFilter { ($Arguments -join ' ') -eq 'stop abc123' }
    }
    It 'copies into an empty data folder' {
        $data = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        New-Item -ItemType Directory $data | Out-Null
        Copy-LegacyKioskData -LegacyDir $legacy -DataDir $data | Should -BeTrue
        Test-Path (Join-Path $data 'identity.json') | Should -BeTrue
    }
    It 'never overwrites a data folder that holds anything' {
        $data = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        New-Item -ItemType Directory $data | Out-Null
        'keep' | Set-Content (Join-Path $data 'edge.db')
        Copy-LegacyKioskData -LegacyDir $legacy -DataDir $data | Should -BeFalse
        Test-Path (Join-Path $data 'identity.json') | Should -BeFalse
        Should -Invoke Invoke-Docker -Times 0
    }
    It 'does nothing without phase-1 identity.json' {
        $empty = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        New-Item -ItemType Directory $empty | Out-Null
        $data = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        Copy-LegacyKioskData -LegacyDir $empty -DataDir $data | Should -BeFalse
        Test-Path $data | Should -BeFalse
    }
}

Describe 'Phase-1 data location' {
    AfterEach { $env:EDGE_DATA_HOST_DIR = $null }
    It 'honors EDGE_DATA_HOST_DIR, else the profile folder' {
        $env:EDGE_DATA_HOST_DIR = 'X:\old'
        Get-LegacyDataDir -UserProfile 'C:\Users\tech' | Should -Be 'X:\old'
        $env:EDGE_DATA_HOST_DIR = $null
        Get-LegacyDataDir -UserProfile 'C:\Users\tech' | Should -Be 'C:\Users\tech\ServerSherpaKiosk'
    }
}

Describe 'Recursive delete guard' {
    It 'refuses empty paths, drive roots and shallow paths' {
        { Assert-SafeRemovePath -Label 'x' -Path '' } | Should -Throw
        { Assert-SafeRemovePath -Label 'x' -Path 'C:\' } | Should -Throw
        { Assert-SafeRemovePath -Label 'x' -Path 'C:' } | Should -Throw
        { Assert-SafeRemovePath -Label 'x' -Path 'C:\Data' } | Should -Throw
        { Assert-SafeRemovePath -Label 'x' -Path '/' } | Should -Throw
        { Assert-SafeRemovePath -Label 'x' -Path 'relative\path\here' } | Should -Throw
        { Assert-SafeRemovePath -Label 'x' -Path 'C:\a\..\b' } | Should -Throw
        { Assert-SafeRemovePath -Label 'x' -Path '\\server\share' } | Should -Throw
    }
    It 'allows normal kiosk folders' {
        { Assert-SafeRemovePath -Label 'x' -Path 'C:\ProgramData\ServerSherpaKiosk\data' } | Should -Not -Throw
        { Assert-SafeRemovePath -Label 'x' -Path 'D:\K\data' } | Should -Not -Throw
        { Assert-SafeRemovePath -Label 'x' -Path $TestDrive } | Should -Not -Throw
    }
}

Describe 'Uninstall with a compose file' {
    BeforeEach {
        $inst = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        $data = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        New-Item -ItemType Directory $inst, $data | Out-Null
        'x' | Set-Content (Join-Path $inst 'docker-compose.yml')
        'x' | Set-Content (Join-Path $inst 'config.env')
        'log' | Set-Content (Join-Path $inst 'install.log')
        Mock Remove-LoginItems {}
        Mock Test-DockerInstalled { $true }
    }
    It 'removes login items first, then compose down, then files (install.log kept)' {
        $script:order = @()
        Mock Remove-LoginItems { $script:order += 'login' }
        Mock Invoke-Docker { $script:order += ($Arguments -join ' ') }
        Uninstall-Kiosk -InstallDir $inst -DataDir $data
        $script:order[0] | Should -Be 'login'
        $script:order[1] | Should -BeLike 'compose -f * down'
        Test-Path (Join-Path $inst 'docker-compose.yml') | Should -BeFalse
        Test-Path (Join-Path $inst 'install.log') | Should -BeTrue
    }
    It 'stops with the Docker-not-running message and keeps the files when the engine is down' {
        Mock Invoke-Docker { throw 'docker failed' }
        { Uninstall-Kiosk -InstallDir $inst -DataDir $data } | Should -Throw "*Docker isn't running*start Docker Desktop and re-run -Uninstall*re-running the installer puts them back*"
        Test-Path (Join-Path $inst 'docker-compose.yml') | Should -BeTrue
        Should -Invoke Remove-LoginItems -Times 1
    }
    It 'stops when the engine answers but the container is still there' {
        Mock Invoke-Docker { throw 'down failed' } -ParameterFilter { $Arguments -contains 'down' }
        Mock Invoke-Docker { 'ok' }
        { Uninstall-Kiosk -InstallDir $inst -DataDir $data } | Should -Throw '*serversherpa-kiosk-edge-1*'
        Test-Path (Join-Path $inst 'config.env') | Should -BeTrue
    }
    It 'continues when the engine answers and the container is gone' {
        Mock Invoke-Docker { throw 'failed' } -ParameterFilter { $Arguments -contains 'down' -or $Arguments -contains 'inspect' }
        Mock Invoke-Docker { 'ok' }
        Uninstall-Kiosk -InstallDir $inst -DataDir $data
        Test-Path (Join-Path $inst 'config.env') | Should -BeFalse
    }
    It 'warns and continues when Docker is not installed' {
        Mock Test-DockerInstalled { $false }
        Mock Invoke-Docker { throw 'should not be called' }
        Mock Write-Warn {}
        Uninstall-Kiosk -InstallDir $inst -DataDir $data
        Should -Invoke Write-Warn -ParameterFilter { $Message -like "*Docker isn't installed*" }
        Test-Path (Join-Path $inst 'docker-compose.yml') | Should -BeFalse
    }
    It 'refuses to purge a folder that does not look like kiosk data' {
        'x' | Set-Content (Join-Path $data 'unrelated.txt')
        $env:KIOSK_CONFIRM_PURGE = 'DELETE'
        try {
            { Uninstall-Kiosk -InstallDir $inst -DataDir $data -PurgeData } | Should -Throw "*doesn't look like kiosk data*"
        } finally { $env:KIOSK_CONFIRM_PURGE = $null }
        Test-Path (Join-Path $data 'unrelated.txt') | Should -BeTrue
    }
    It 'refuses a shallow data folder before removing anything' {
        Mock Invoke-Docker {}
        { Uninstall-Kiosk -InstallDir $inst -DataDir 'C:\' } | Should -Throw
        Should -Invoke Remove-LoginItems -Times 0
    }
}

Describe 'Browser' {
    It 'prefers Chrome over Edge' {
        Mock Test-Path { $true } -ParameterFilter { $Path -like '*chrome.exe' }
        Mock Test-Path { $true } -ParameterFilter { $Path -like '*msedge.exe' }
        Find-Browser | Should -BeLike '*chrome.exe'
    }
    It 'falls back to Edge' {
        Mock Test-Path { $false } -ParameterFilter { $Path -like '*chrome.exe' }
        Mock Test-Path { $true } -ParameterFilter { $Path -like '*msedge.exe' }
        Find-Browser | Should -BeLike '*msedge.exe'
    }
}

Describe 'Elevation command' {
    It 'forwards parameters and kiosk environment with safe quoting' {
        $curly = [string][char]0x2019
        $image = "o'brien/kiosk:test$curly"
        $script = "C:\Temp Dir\it's\serversherpa-kiosk-install.ps1"
        $api = "https://api.a.com/x y'z$curly" + [char]0x2018 + 'end'
        $env:KIOSK_IMAGE = $image
        try {
            $cmd = Get-ElevationCommand -ScriptPath $script -Parameters @{ ApiUrl = $api; Yes = [switch]$true; Uninstall = [switch]$false }
        } finally { $env:KIOSK_IMAGE = $null }
        $tokens = $null; $errors = $null
        $ast = [Management.Automation.Language.Parser]::ParseInput($cmd, [ref]$tokens, [ref]$errors)
        $errors.Count | Should -Be 0
        $strings = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.StringConstantExpressionAst] }, $true) | ForEach-Object { $_.Value })
        $strings | Should -Contain $image
        $strings | Should -Contain $script
        $strings | Should -Contain $api
        $cmd | Should -Match '-Yes(\s|$)'
        $cmd | Should -Not -Match '-Uninstall'
        $cmd | Should -Match 'KIOSK_ELEVATED_CHILD'
        Get-ElevationCommand -ScriptPath $script -NoChildMarker | Should -Not -Match 'KIOSK_ELEVATED_CHILD'
    }
}

Describe 'Assert-Admin' {
    BeforeEach { Mock Get-SelfScriptPath { 'C:\Temp\i.ps1' } }
    It 'returns $null when already elevated' {
        Mock Test-IsAdmin { $true }
        Mock Start-Process {}
        Assert-Admin | Should -BeNullOrEmpty
        Should -Invoke Start-Process -Times 0
    }
    It 'maps a child without an exit code to 1, never $null' {
        Mock Test-IsAdmin { $false }
        Mock Start-Process { [pscustomobject]@{ ExitCode = $null } }
        Assert-Admin | Should -Be 1
    }
    It "returns the child's exit code" {
        Mock Test-IsAdmin { $false }
        Mock Start-Process { [pscustomobject]@{ ExitCode = 0 } }
        $r = Assert-Admin
        $null -eq $r | Should -BeFalse
        $r | Should -Be 0
    }
}

Describe '64-bit PowerShell' {
    It 'relaunches only a 32-bit process on 64-bit Windows' {
        Test-Need64BitRelaunch -Is64BitOperatingSystem $true -Is64BitProcess $false | Should -BeTrue
        Test-Need64BitRelaunch -Is64BitOperatingSystem $true -Is64BitProcess $true | Should -BeFalse
        Test-Need64BitRelaunch -Is64BitOperatingSystem $false -Is64BitProcess $false | Should -BeFalse
    }
}

Describe 'Script hygiene' {
    It 'is plain ASCII, so Windows PowerShell 5.1 reads it correctly without a byte-order mark' {
        $bytes = [System.IO.File]::ReadAllBytes((Join-Path $PSScriptRoot '../install.ps1'))
        ($bytes | Where-Object { $_ -gt 127 }).Count | Should -Be 0
    }
}

Describe 'WSL decision table' {
    BeforeEach {
        $script:features = @{ 'Microsoft-Windows-Subsystem-Linux' = 'Disabled'; 'VirtualMachinePlatform' = 'Disabled' }
        $script:statusExit = 1
        $script:installExit = 0
        $script:installEnables = 'EnablePending'
        Mock Get-WslFeatureState { $script:features[$Name] }
        Mock Invoke-Wsl { @{ Output = ''; ExitCode = $script:statusExit } } -ParameterFilter { $Arguments -contains '--status' }
        Mock Invoke-Wsl {
            if ($script:installEnables) { $script:features['VirtualMachinePlatform'] = $script:installEnables }
            @{ Output = ''; ExitCode = $script:installExit }
        } -ParameterFilter { $Arguments -contains '--install' }
        Mock Enable-WslFeature { $true }
    }
    It 'Enabled platform + Store WSL (legacy feature Disabled) + status OK: ready, no restart' {
        $script:features['VirtualMachinePlatform'] = 'Enabled'
        $script:statusExit = 0
        Enable-Wsl | Should -BeFalse
        Should -Invoke Invoke-Wsl -Times 0 -ParameterFilter { $Arguments -contains '--install' }
    }
    It 'Disabled: installs, then the pending platform needs a restart' {
        Enable-Wsl | Should -BeTrue
        Should -Invoke Invoke-Wsl -Times 1 -ParameterFilter { $Arguments -contains '--install' }
    }
    It 'EnablePending: restart without installing again' {
        $script:features['VirtualMachinePlatform'] = 'EnablePending'
        Enable-Wsl | Should -BeTrue
        Should -Invoke Invoke-Wsl -Times 0 -ParameterFilter { $Arguments -contains '--install' }
    }
    It 'install exit 3010: restart' {
        $script:installExit = 3010
        $script:installEnables = $null
        Enable-Wsl | Should -BeTrue
    }
    It 'Enabled platform but status fails, install succeeds with nothing pending: no restart loop' {
        $script:features['VirtualMachinePlatform'] = 'Enabled'
        $script:installEnables = $null
        Enable-Wsl | Should -BeFalse
    }
    It 'older wsl.exe (install fails): turns the features on directly' {
        $script:installExit = 1
        $script:installEnables = $null
        Enable-Wsl | Should -BeTrue
        Should -Invoke Enable-WslFeature -Times 2
    }
    It 'pending means EnablePending only, not Disabled' {
        Test-WslFeaturesPending | Should -BeFalse
        $script:features['Microsoft-Windows-Subsystem-Linux'] = 'EnablePending'
        Test-WslFeaturesPending | Should -BeTrue
    }
}

Describe 'docker-users membership' {
    BeforeEach {
        $user = @{ Name = 'PC\tech'; Sid = 'S-1-5-21-1-2-3-1001'; Profile = 'C:\Users\tech' }
        Mock Stop-ForRestart {}
        Mock Add-DockerUsersMember { $true }
    }
    It 'already a member: no add, no sign-out' {
        Mock Test-DockerUsersMember { $true }
        Confirm-DockerUsersMember -InstallDir 'C:\K' -DesktopUser $user
        Should -Invoke Add-DockerUsersMember -Times 0
        Should -Invoke Stop-ForRestart -Times 0
    }
    It 'not a member: adds by SID and asks for a sign-out, resuming at engine' {
        Mock Test-DockerUsersMember { $false }
        Confirm-DockerUsersMember -InstallDir 'C:\K' -DesktopUser $user
        Should -Invoke Add-DockerUsersMember -Times 1 -ParameterFilter { $Sid -eq 'S-1-5-21-1-2-3-1001' }
        Should -Invoke Stop-ForRestart -Times 1 -ParameterFilter { $Step -eq 'engine' -and $Action -eq 'signout' }
    }
    It 'added concurrently ("already a member"): success, no sign-out' {
        Mock Test-DockerUsersMember { $false }
        Mock Add-DockerUsersMember { $false }
        Confirm-DockerUsersMember -InstallDir 'C:\K' -DesktopUser $user
        Should -Invoke Stop-ForRestart -Times 0
    }
    It 'checks membership by SID' {
        Mock Get-LocalGroupMember { @([pscustomobject]@{ SID = [pscustomobject]@{ Value = 'S-1-5-21-1-2-3-1001' } }) }
        Test-DockerUsersMember -Sid 'S-1-5-21-1-2-3-1001' | Should -BeTrue
        Test-DockerUsersMember -Sid 'S-1-5-21-9' | Should -BeFalse
    }
}

Describe 'Adding to docker-users' {
    It 'Add-DockerUsersMember treats "already a member" as success and adds by SID' {
        Mock ConvertTo-SecurityIdentifier { $Sid }   # SecurityIdentifier is Windows-only
        Mock Add-LocalGroupMember { throw 'S-1-5-21-1-2-3-1001 is already a member of group docker-users.' }
        Add-DockerUsersMember -Sid 'S-1-5-21-1-2-3-1001' | Should -BeFalse
        Mock Add-LocalGroupMember {}
        Add-DockerUsersMember -Sid 'S-1-5-21-1-2-3-1001' | Should -BeTrue
        Should -Invoke Add-LocalGroupMember -ParameterFilter { "$Member" -eq 'S-1-5-21-1-2-3-1001' -and $Group -eq 'docker-users' }
        Mock Add-LocalGroupMember { throw 'Access denied.' }
        { Add-DockerUsersMember -Sid 'S-1-5-21-1-2-3-1001' } | Should -Throw '*docker-users*'
    }
}

Describe 'Docker Desktop install needing a restart (3010)' {
    It 'stops for a restart and resumes at engine' {
        Mock Test-DockerInstalled { $false }
        Mock Test-DockerEngine { $false }
        Mock Assert-Virtualization {}
        Mock Enable-Wsl { $false }
        Mock Get-WindowsArch { 'amd64' }
        Mock Invoke-WebRequest {}
        Mock Get-AuthenticodeSignature { [pscustomobject]@{ Status = 'Valid'; SignerCertificate = [pscustomobject]@{ Subject = 'CN=Docker Inc, O=Docker Inc' } } }
        Mock Start-Process { [pscustomobject]@{ ExitCode = 3010 } }
        Mock Stop-ForRestart { throw 'KIOSK_RESTART_PENDING test' }
        { Install-DockerDesktop -InstallDir 'C:\K' } | Should -Throw '*KIOSK_RESTART_PENDING*'
        Should -Invoke Stop-ForRestart -Times 1 -ParameterFilter { $Step -eq 'engine' -and $Action -eq 'restart' }
    }
}

Describe 'Installer flow' {
    BeforeEach {
        $inst = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        New-Item -ItemType Directory $inst | Out-Null
        $SelfPath = Join-Path $inst 'install.ps1'
        $env:KIOSK_DIR = $inst
        foreach ($f in @('Assert-64BitProcess', 'Assert-Admin', 'Assert-WindowsSupported', 'Set-KioskDirAcl', 'Test-ApiReachable',
                'Add-DockerToPath', 'Install-DockerDesktop', 'Confirm-DockerUsersMember', 'Enable-DockerAutostart', 'Wait-DockerEngine',
                'Assert-Compose', 'New-KioskDataDir', 'Write-KioskConfig', 'Set-KioskFileAcl', 'Copy-LegacyKioskData', 'Invoke-LegacyMigration', 'Start-Kiosk',
                'Install-LoginItems', 'Remove-ResumeRegistration', 'Write-Summary', 'Uninstall-Kiosk')) {
            Mock $f {}
        }
        Mock Get-DesktopUser { @{ Name = 'PC\tech'; Sid = 'S-1-5-21-1'; Profile = 'C:\Users\tech' } }
        Mock Find-Browser { 'C:\chrome.exe' }
        Mock Start-InstallLog { $false }
    }
    AfterEach { $env:KIOSK_DIR = $null }
    It 'a resume at engine skips the Docker install but still checks docker-users' {
        Save-ResumeState -Path (Join-Path $inst 'install-state.json') -Step 'engine' -Arguments @{ ApiUrl = 'https://api.a.com'; Yes = $true; "env:KIOSK_DIR" = $inst }
        $env:KIOSK_DIR = $null
        Invoke-KioskInstaller -Parameters @{ Resume = $true } | Should -Be 0
        Should -Invoke Install-DockerDesktop -Times 0
        Should -Invoke Confirm-DockerUsersMember -Times 1
        Should -Invoke Start-Kiosk -Times 1
    }
    It 'a plain re-run also checks docker-users' {
        Invoke-KioskInstaller -Parameters @{ Yes = $true } | Should -Be 0
        Should -Invoke Install-DockerDesktop -Times 1
        Should -Invoke Confirm-DockerUsersMember -Times 1
    }
    It 'a restart request ends the run with exit code 0' {
        Mock Confirm-DockerUsersMember { throw 'KIOSK_RESTART_PENDING sign out' }
        Invoke-KioskInstaller -Parameters @{ Yes = $true } | Should -Be 0
        Should -Invoke Start-Kiosk -Times 0
    }
    It 'returns the relaunched child exit code without running the install' {
        Mock Assert-Admin { 1 }
        Invoke-KioskInstaller -Parameters @{ Yes = $true } | Should -Be 1
        Should -Invoke Get-DesktopUser -Times 0
    }
    It '-StartFresh reaches the phase-1 migration, and a resume keeps it' {
        Invoke-KioskInstaller -Parameters @{ Yes = $true; StartFresh = $true } | Should -Be 0
        Should -Invoke Invoke-LegacyMigration -Times 1 -ParameterFilter { $StartFresh }
        Save-ResumeState -Path (Join-Path $inst 'install-state.json') -Step 'engine' -Arguments @{ StartFresh = $true; "env:KIOSK_DIR" = $inst }
        $env:KIOSK_DIR = $null
        Invoke-KioskInstaller -Parameters @{ Resume = $true } | Should -Be 0
        Should -Invoke Invoke-LegacyMigration -Times 2 -Exactly -ParameterFilter { $StartFresh }
    }
    It 'passes the data folder to Install-LoginItems (it confirms host-network.json there)' {
        $env:KIOSK_DATA_DIR = 'D:\kioskdata'
        try { Invoke-KioskInstaller -Parameters @{ Yes = $true } | Should -Be 0 } finally { $env:KIOSK_DATA_DIR = $null }
        Should -Invoke Install-LoginItems -Times 1 -Exactly -ParameterFilter { $DataDir -eq 'D:\kioskdata' }
    }
    It 'passes the channel and image to Start-Kiosk' {
        Invoke-KioskInstaller -Parameters @{ Yes = $true; Channel = 'edge' } | Should -Be 0
        Should -Invoke Start-Kiosk -Times 1 -ParameterFilter { $Channel -eq 'edge' -and $ImageRef -like '*:edge' }
    }
    It 'uninstall reads only the data folder, so a damaged channel cannot block it' {
        "KIOSK_CHANNEL=nightly`nKIOSK_DATA_DIR=D:\KioskData`n" | Set-Content (Join-Path $inst 'config.env')
        Invoke-KioskInstaller -Parameters @{ Uninstall = $true } | Should -Be 0
        Should -Invoke Uninstall-Kiosk -Times 1 -ParameterFilter { $DataDir -eq 'D:\KioskData' -and $InstallDir -eq $inst }
    }
}

Describe 'RunOnce resume' {
    It 'registers a launcher that returns at once' {
        Get-ResumeCommand -InstallDir 'C:\ProgramData\ServerSherpaKiosk' |
            Should -Be 'cmd.exe /c start "ServerSherpa Kiosk install" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\ProgramData\ServerSherpaKiosk\install.ps1" -Resume'
    }
    It 'tells an administrator the install continues at their sign-in' {
        $m = Get-RestartMessage -Reason 'WSL2 was turned on.' -Action restart -DesktopUserIsAdmin $true -DesktopUserName 'PC\tech'
        $m | Should -BeLike 'WSL2 was turned on. Restart Windows now.*continues automatically when an administrator signs in.'
        $m | Should -Not -BeLike "*isn't an administrator*"
    }
    It 'tells a standard user to sign in as an administrator or re-run' {
        $m = Get-RestartMessage -Reason 'x was added.' -Action signout -DesktopUserIsAdmin $false -DesktopUserName 'PC\kiosk'
        $m | Should -BeLike '*Sign out of Windows and back in*'
        $m | Should -BeLike "*PC\kiosk isn't an administrator*sign in once as an administrator, or run the install command again.*"
    }
    It 'Stop-ForRestart saves the state, registers RunOnce and picks the message by admin membership' {
        Mock Save-ResumeState {}
        Mock Register-Resume {}
        Mock Test-UserIsAdmin { $false }
        { Stop-ForRestart -InstallDir 'C:\K' -Step 'docker' -Arguments @{} -Reason 'R.' -DesktopUser @{ Name = 'PC\kiosk'; Sid = 'S-1-5-21-2' } } |
            Should -Throw "KIOSK_RESTART_PENDING R. Restart Windows now.*isn't an administrator*"
        Should -Invoke Save-ResumeState -Times 1 -ParameterFilter { $Step -eq 'docker' }
        Should -Invoke Register-Resume -Times 1
        Mock Test-UserIsAdmin { $true }
        { Stop-ForRestart -InstallDir 'C:\K' -Step 'docker' -Arguments @{} -Reason 'R.' -DesktopUser @{ Name = 'PC\tech'; Sid = 'S-1-5-21-1' } } |
            Should -Throw '*continues automatically when an administrator signs in.'
    }
}

Describe 'Starting Docker Desktop as the user' {
    BeforeEach {
        Mock Test-Path { $true } -ParameterFilter { $LiteralPath -like '*Docker Desktop.exe' }
        Mock New-ScheduledTaskAction { 'action' }
        Mock New-ScheduledTaskPrincipal { 'principal' }
        Mock Register-ScheduledTask {}
        Mock Start-ScheduledTask {}
        Mock Unregister-ScheduledTask {}
        Mock Start-Sleep {}
        $script:taskStates = [System.Collections.Generic.Queue[string]]::new()
        foreach ($st in @('Queued', 'Queued', 'Running')) { $script:taskStates.Enqueue($st) }
        Mock Get-ScheduledTask { [pscustomobject]@{ State = $script:taskStates.Dequeue() } }
        $user = @{ Name = 'PC\tech'; Sid = 'S-1-5-21-1' }
    }
    It 'waits while the task is Queued, then removes it' {
        Mock Test-DockerDesktopRunning { $false }
        Start-DockerDesktopAsUser -DesktopUser $user
        Should -Invoke Get-ScheduledTask -Times 3 -Exactly
        Should -Invoke Unregister-ScheduledTask -Times 1 -Exactly
    }
    It 'stops waiting as soon as Docker Desktop is running' {
        Mock Test-DockerDesktopRunning { $true }
        Start-DockerDesktopAsUser -DesktopUser $user
        Should -Invoke Get-ScheduledTask -Times 0 -Exactly
        Should -Invoke Unregister-ScheduledTask -Times 1 -Exactly
    }
}

Describe 'Install folder rules agree' {
    It 'uninstall accepts a shallow install folder (only named files are removed) but not a drive root' {
        Mock Remove-LoginItems {}
        $data = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        { Uninstall-Kiosk -InstallDir 'D:\K' -DataDir $data } | Should -Not -Throw
        { Uninstall-Kiosk -InstallDir 'D:\' -DataDir $data } | Should -Throw '*too close to the top*'
    }
    It 'a shallow data folder is still refused for the recursive purge' {
        { Assert-SafeRemovePath -Label 'x' -Path 'D:\K' } | Should -Throw
        { Assert-SafeRemovePath -Label 'x' -Path 'D:\K' -MinComponents 1 } | Should -Not -Throw
    }
}

Describe 'Uninstall data folder' {
    AfterEach { $env:KIOSK_DATA_DIR = $null }
    It 'env, then the saved folder, then the default' {
        $env:KIOSK_DATA_DIR = $null
        Get-UninstallDataDir -Saved @{ KIOSK_DATA_DIR = 'D:\Saved'; KIOSK_CHANNEL = 'nightly' } | Should -Be 'D:\Saved'
        Get-UninstallDataDir -Saved @{} | Should -Be 'C:\ProgramData\ServerSherpaKiosk\data'
        $env:KIOSK_DATA_DIR = 'E:\Env'
        Get-UninstallDataDir -Saved @{ KIOSK_DATA_DIR = 'D:\Saved' } | Should -Be 'E:\Env'
    }
}

# -- Task 6: login items -------------------------------------------------------

Describe 'Login item specs' {
    It 'the nightly update task: name, 03:00, powershell.exe -File update.ps1, the signed-in user, interactive only' {
        $t = Get-UpdateTaskSpec -InstallDir 'C:\ProgramData\ServerSherpaKiosk' -User 'PC\tech'
        $t.Name | Should -Be 'ServerSherpa Kiosk Update'
        $t.Time | Should -Be '03:00'
        $t.Execute | Should -Be 'powershell.exe'
        $t.Argument | Should -Be '-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File "C:\ProgramData\ServerSherpaKiosk\update.ps1"'
        $t.LogonType | Should -Be 'Interactive'
        $t.User | Should -Be 'PC\tech'
        $t.ExecutionTimeLimitMinutes | Should -Be 30
    }
    It 'the shortcut runs launch.ps1 hidden through Windows PowerShell' {
        $s = Get-ShortcutSpec -InstallDir 'C:\ProgramData\ServerSherpaKiosk'
        $s.Target | Should -BeLike '*\WindowsPowerShell\v1.0\powershell.exe'
        $s.Arguments | Should -Be '-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File "C:\ProgramData\ServerSherpaKiosk\launch.ps1"'
        $s.WorkingDirectory | Should -Be 'C:\ProgramData\ServerSherpaKiosk'
    }
    It 'the host network task: name, hostnet.ps1 through Windows PowerShell, SYSTEM as a service account, every minute' {
        $t = Get-HostnetTaskSpec -InstallDir 'C:\ProgramData\ServerSherpaKiosk'
        $t.Name | Should -Be 'ServerSherpa Kiosk Host Network'
        $t.Execute | Should -Be 'powershell.exe'
        $t.Argument | Should -Be '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\ProgramData\ServerSherpaKiosk\hostnet.ps1"'
        $t.User | Should -Be 'NT AUTHORITY\SYSTEM'
        $t.LogonType | Should -Be 'ServiceAccount'
        $t.RunLevel | Should -Be 'Highest'
        $t.RepeatMinutes | Should -Be 1
        $t.ExecutionTimeLimitMinutes | Should -Be 2
    }
    It 'shortcuts go on the Public Desktop, the all-users Start menu and all-users StartUp' {
        $p = @(Get-ShortcutPaths)
        $p.Count | Should -Be 3
        $p | Should -Contain 'C:\Users\Public\Desktop\ServerSherpa Kiosk.lnk'
        $p | Should -Contain 'C:\ProgramData\Microsoft\Windows\Start Menu\Programs\ServerSherpa Kiosk.lnk'
        $p | Should -Contain 'C:\ProgramData\Microsoft\Windows\Start Menu\Programs\StartUp\ServerSherpa Kiosk.lnk'
    }
}

Describe 'Install-LoginItems' {
    BeforeEach {
        $inst = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        New-Item -ItemType Directory $inst | Out-Null
        $script:user = @{ Name = 'PC\tech'; Sid = 'S-1-5-21-1-2-3-1001'; Profile = 'C:\Users\tech' }
        Mock Set-KioskFileAcl {}
        Mock Set-KioskUserWritableFileAcl {}
        Mock New-KioskShortcut {}
        Mock New-ScheduledTaskAction { 'action' }
        Mock New-ScheduledTaskTrigger { 'daily' }
        Mock New-ScheduledTaskTrigger { 'startup' } -ParameterFilter { $AtStartup }
        Mock New-ScheduledTaskTrigger { 'every-minute' } -ParameterFilter { $Once }
        Mock New-ScheduledTaskPrincipal { "principal:$UserId" }
        Mock New-ScheduledTaskSettingsSet { 'settings' }
        Mock Register-ScheduledTask {}
        Mock Start-ScheduledTask {}
    }
    It 'copies update.ps1, launch.ps1 and hostnet.ps1 into the install folder' {
        Install-LoginItems -InstallDir $inst -DesktopUser $script:user
        foreach ($n in @('update.ps1', 'launch.ps1', 'hostnet.ps1')) {
            [IO.File]::ReadAllText((Join-Path $inst $n)) | Should -Be ([IO.File]::ReadAllText((Join-Path $PSScriptRoot "../$n")))
            Should -Invoke Set-KioskFileAcl -ParameterFilter { $Path -like "*$n" }
        }
    }
    It 'makes update.log and update-state.json (only those) writable by the signed-in user' {
        Install-LoginItems -InstallDir $inst -DesktopUser $script:user
        Test-Path (Join-Path $inst 'update.log') | Should -BeTrue
        Test-Path (Join-Path $inst 'update-state.json') | Should -BeTrue
        Should -Invoke Set-KioskUserWritableFileAcl -Times 2 -Exactly
        Should -Invoke Set-KioskUserWritableFileAcl -ParameterFilter { $Path -like '*update.log' -and $UserSid -eq 'S-1-5-21-1-2-3-1001' }
        Should -Invoke Set-KioskUserWritableFileAcl -ParameterFilter { $Path -like '*update-state.json' -and $UserSid -eq 'S-1-5-21-1-2-3-1001' }
    }
    It 'keeps an existing update-state.json and update.log' {
        [IO.File]::WriteAllText((Join-Path $inst 'update-state.json'), '{"rejected_image": "sha256:bad"}')
        [IO.File]::WriteAllText((Join-Path $inst 'update.log'), 'old lines')
        Install-LoginItems -InstallDir $inst -DesktopUser $script:user
        [IO.File]::ReadAllText((Join-Path $inst 'update-state.json')) | Should -BeLike '*sha256:bad*'
        [IO.File]::ReadAllText((Join-Path $inst 'update.log')) | Should -Be 'old lines'
    }
    It 'registers the nightly task at 03:00 for the signed-in user, interactive, start when available' {
        Install-LoginItems -InstallDir $inst -DesktopUser $script:user
        Should -Invoke New-ScheduledTaskAction -ParameterFilter { $Execute -eq 'powershell.exe' -and $Argument -eq "-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File `"$inst\update.ps1`"" }
        Should -Invoke New-ScheduledTaskTrigger -ParameterFilter { $Daily -and "$At" -like '*03:00*' }
        Should -Invoke New-ScheduledTaskPrincipal -ParameterFilter { $UserId -eq 'PC\tech' -and $LogonType -eq 'Interactive' }
        Should -Invoke New-ScheduledTaskSettingsSet -ParameterFilter { $StartWhenAvailable -and $AllowStartIfOnBatteries -and $DontStopIfGoingOnBatteries }
        Should -Invoke Register-ScheduledTask -Times 1 -Exactly -ParameterFilter { $TaskName -eq 'ServerSherpa Kiosk Update' -and $Force }
    }
    It 'creates the three shortcuts' {
        Install-LoginItems -InstallDir $inst -DesktopUser $script:user
        Should -Invoke New-KioskShortcut -Times 3 -Exactly
        Should -Invoke New-KioskShortcut -ParameterFilter { $Path -like '*StartUp\ServerSherpa Kiosk.lnk' -and $Spec.Arguments -like '*launch.ps1*' }
    }
    It 'without a signed-in user: warns, skips the nightly task, still registers the host network task and makes the shortcuts' {
        Mock Write-Warn {}
        Install-LoginItems -InstallDir $inst -DesktopUser $null
        Should -Invoke Register-ScheduledTask -Times 0 -ParameterFilter { $TaskName -eq 'ServerSherpa Kiosk Update' }
        Should -Invoke Register-ScheduledTask -Times 1 -Exactly -ParameterFilter { $TaskName -eq 'ServerSherpa Kiosk Host Network' }
        Should -Invoke Set-KioskUserWritableFileAcl -Times 0
        Should -Invoke New-KioskShortcut -Times 3 -Exactly
        Should -Invoke Write-Warn -ParameterFilter { $Message -like '*nightly update*' }
    }
    It 'registers the host network task as SYSTEM: at startup plus every minute, on battery, one at a time' {
        Install-LoginItems -InstallDir $inst -DesktopUser $script:user
        Should -Invoke New-ScheduledTaskAction -ParameterFilter { $Execute -eq 'powershell.exe' -and $Argument -eq "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$inst\hostnet.ps1`"" }
        Should -Invoke New-ScheduledTaskTrigger -Times 1 -Exactly -ParameterFilter { $AtStartup }
        Should -Invoke New-ScheduledTaskTrigger -Times 1 -Exactly -ParameterFilter { $Once -and $RepetitionInterval -eq (New-TimeSpan -Minutes 1) -and $At -is [datetime] }
        Should -Invoke New-ScheduledTaskPrincipal -Times 1 -Exactly -ParameterFilter { $UserId -eq 'NT AUTHORITY\SYSTEM' -and $LogonType -eq 'ServiceAccount' -and $RunLevel -eq 'Highest' }
        Should -Invoke New-ScheduledTaskSettingsSet -ParameterFilter {
            $StartWhenAvailable -and $AllowStartIfOnBatteries -and $DontStopIfGoingOnBatteries -and "$MultipleInstances" -eq 'IgnoreNew' -and $ExecutionTimeLimit -eq (New-TimeSpan -Minutes 2)
        }
        Should -Invoke Register-ScheduledTask -Times 1 -Exactly -ParameterFilter {
            $TaskName -eq 'ServerSherpa Kiosk Host Network' -and $Force -and (@($Trigger) -join ',') -eq 'startup,every-minute' -and $Principal -eq 'principal:NT AUTHORITY\SYSTEM'
        }
        Should -Invoke Start-ScheduledTask -Times 1 -Exactly -ParameterFilter { $TaskName -eq 'ServerSherpa Kiosk Host Network' }
    }
    It 'warns but finishes when the host network task cannot be registered' {
        Mock Register-ScheduledTask { throw 'access denied' } -ParameterFilter { $TaskName -eq 'ServerSherpa Kiosk Host Network' }
        Mock Write-Warn {}
        { Install-LoginItems -InstallDir $inst -DesktopUser $script:user } | Should -Not -Throw
        Should -Invoke Write-Warn -ParameterFilter { $Message -like '*host network*' }
        Should -Invoke Register-ScheduledTask -ParameterFilter { $TaskName -eq 'ServerSherpa Kiosk Update' }
    }
    It 'confirms the first run by a fresh host-network.json in the data folder' {
        $data = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        New-Item -ItemType Directory $data | Out-Null
        Mock Start-ScheduledTask { [IO.File]::WriteAllText((Join-Path $data 'host-network.json'), '{}') }
        Mock Start-Sleep {}
        Mock Write-Warn {}
        Install-LoginItems -InstallDir $inst -DesktopUser $script:user -DataDir $data
        Should -Invoke Write-Warn -Times 0
        Should -Invoke Start-Sleep -Times 0
    }
    It 'warns when no fresh file appears within about 30 seconds (a stale one does not count)' {
        $data = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        New-Item -ItemType Directory $data | Out-Null
        $old = Join-Path $data 'host-network.json'
        [IO.File]::WriteAllText($old, '{}')
        [IO.File]::SetLastWriteTimeUtc($old, [datetime]::UtcNow.AddHours(-1))
        Mock Start-Sleep {}
        Mock Write-Warn {}
        Install-LoginItems -InstallDir $inst -DesktopUser $script:user -DataDir $data
        Should -Invoke Start-Sleep -Times 30 -Exactly
        Should -Invoke Write-Warn -Times 1 -Exactly -ParameterFilter { $Message -eq "Couldn't confirm the network helper is running (it retries every minute) $([char]0x2014) RFID setup may not find readers." }
    }
    It 'warns (and does not throw) when the first run cannot be started' {
        $data = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        New-Item -ItemType Directory $data | Out-Null
        Mock Start-ScheduledTask { throw 'task disabled' }
        Mock Start-Sleep {}
        Mock Write-Warn {}
        { Install-LoginItems -InstallDir $inst -DesktopUser $script:user -DataDir $data } | Should -Not -Throw
        Should -Invoke Write-Warn -ParameterFilter { $Message -like "Couldn't confirm the network helper*" }
    }
    It 'Wait-HostNetworkFile returns as soon as the file is fresh' {
        $data = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        New-Item -ItemType Directory $data | Out-Null
        $script:sleeps = 0
        Mock Start-Sleep { $script:sleeps++; if ($script:sleeps -eq 3) { [IO.File]::WriteAllText((Join-Path $data 'host-network.json'), '{}') } }
        Wait-HostNetworkFile -DataDir $data -Since ([datetime]::UtcNow) | Should -BeTrue
        $script:sleeps | Should -Be 3
    }
    It 'warns but finishes when the task cannot be registered' {
        Mock Register-ScheduledTask { throw 'access denied' }
        Mock Write-Warn {}
        { Install-LoginItems -InstallDir $inst -DesktopUser $script:user } | Should -Not -Throw
        Should -Invoke Write-Warn -ParameterFilter { $Message -like '*nightly update*' }
        Should -Invoke New-KioskShortcut -Times 3 -Exactly
    }
}

Describe 'Remove-LoginItems' {
    It 'stops a running update, removes both tasks and all three shortcuts' {
        $dir = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        New-Item -ItemType Directory $dir | Out-Null
        $paths = @('a.lnk', 'b.lnk', 'c.lnk') | ForEach-Object { Join-Path $dir $_ }
        foreach ($p in $paths) { 'x' | Set-Content $p }
        Mock Get-ShortcutPaths { $paths }
        Mock Get-ScheduledTask { [pscustomobject]@{ TaskName = $TaskName; State = 'Running' } }
        $script:order = @()
        Mock Stop-ScheduledTask { $script:order += "stop $TaskName" }
        Mock Unregister-ScheduledTask { $script:order += "unregister $TaskName" }
        Remove-LoginItems -InstallDir 'C:\K'
        ($script:order -join ',') | Should -Be ('stop ServerSherpa Kiosk Update,unregister ServerSherpa Kiosk Update,' +
            'stop ServerSherpa Kiosk Host Network,unregister ServerSherpa Kiosk Host Network')
        foreach ($p in $paths) { Test-Path $p | Should -BeFalse }
    }
    It 'is fine when nothing is there' {
        Mock Get-ShortcutPaths { @((Join-Path $TestDrive 'none1.lnk'), (Join-Path $TestDrive 'none2.lnk')) }
        Mock Get-ScheduledTask { $null }
        Mock Stop-ScheduledTask {}
        Mock Unregister-ScheduledTask {}
        { Remove-LoginItems -InstallDir 'C:\K' } | Should -Not -Throw
        Should -Invoke Unregister-ScheduledTask -Times 0
    }
}

# -- Task 5 review leftovers -------------------------------------------------------

Describe 'Closing pause' {
    BeforeEach {
        $inst = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        New-Item -ItemType Directory $inst | Out-Null
        # Set-Variable: the installer functions read $SelfPath through dynamic scoping.
        Set-Variable -Name SelfPath -Value (Join-Path $inst 'install.ps1')
        $env:KIOSK_DIR = $inst
        foreach ($f in @('Assert-64BitProcess', 'Assert-Admin', 'Assert-WindowsSupported', 'Set-KioskDirAcl', 'Test-ApiReachable',
                'Add-DockerToPath', 'Install-DockerDesktop', 'Confirm-DockerUsersMember', 'Enable-DockerAutostart', 'Wait-DockerEngine',
                'Assert-Compose', 'New-KioskDataDir', 'Write-KioskConfig', 'Set-KioskFileAcl', 'Copy-LegacyKioskData', 'Invoke-LegacyMigration', 'Start-Kiosk',
                'Install-LoginItems', 'Remove-ResumeRegistration', 'Write-Summary')) {
            Mock $f {}
        }
        Mock Read-KioskSettings { $Options }
        Mock Get-DesktopUser { @{ Name = 'PC\tech'; Sid = 'S-1-5-21-1'; Profile = 'C:\Users\tech' } }
        Mock Find-Browser { 'C:\chrome.exe' }
        Mock Start-InstallLog { $false }
        Mock Test-ConsoleAvailable { $true }
        Mock Read-Answer {}
        Save-ResumeState -Path (Join-Path $inst 'install-state.json') -Step 'engine' -Arguments @{ Yes = $true; "env:KIOSK_DIR" = $inst }
    }
    AfterEach { $env:KIOSK_DIR = $null; $env:KIOSK_NONINTERACTIVE = $null; $env:KIOSK_ELEVATED_CHILD = $null }
    It 'a resume after -Yes still pauses so the technician sees the result' {
        Invoke-KioskInstaller -Parameters @{ Resume = $true; Yes = $true } | Should -Be 0
        Should -Invoke Read-Answer -Times 1 -Exactly -ParameterFilter { $Prompt -like '*Press Enter*' }
    }
    It 'the elevated child run with -Yes pauses too' {
        $env:KIOSK_ELEVATED_CHILD = '1'
        Invoke-KioskInstaller -Parameters @{ Yes = $true } | Should -Be 0
        Should -Invoke Read-Answer -Times 1 -Exactly -ParameterFilter { $Prompt -like '*Press Enter*' }
    }
    It 'KIOSK_NONINTERACTIVE=1 never pauses' {
        $env:KIOSK_NONINTERACTIVE = '1'
        Invoke-KioskInstaller -Parameters @{ Resume = $true } | Should -Be 0
        Should -Invoke Read-Answer -Times 0
    }
    It 'no console: no pause' {
        Mock Test-ConsoleAvailable { $false }
        Invoke-KioskInstaller -Parameters @{ Resume = $true } | Should -Be 0
        Should -Invoke Read-Answer -Times 0
    }
    It '-Yes still means no questions' {
        Test-Interactive | Should -BeTrue
        $script:AssumeYes = $true; $AssumeYes = $true
        try { Test-Interactive | Should -BeFalse } finally { $script:AssumeYes = $false; $AssumeYes = $false }
    }
}

Describe 'docker-users add failure for an administrator' {
    BeforeEach {
        $script:user = @{ Name = 'PC\admin'; Sid = 'S-1-5-21-1-2-3-500'; Profile = 'C:\Users\admin' }
        Mock Test-DockerUsersMember { $false }
        Mock Add-DockerUsersMember { throw "Couldn't add the signed-in user to the docker-users group (Access denied)." }
        Mock Stop-ForRestart {}
        Mock Write-Warn {}
    }
    It 'an administrator: warns and continues (admins can run Docker Desktop anyway)' {
        Mock Test-UserIsAdmin { $true }
        { Confirm-DockerUsersMember -InstallDir 'C:\K' -DesktopUser $script:user } | Should -Not -Throw
        Should -Invoke Write-Warn -Times 1 -ParameterFilter { $Message -like '*docker-users*' }
        Should -Invoke Stop-ForRestart -Times 0
    }
    It 'a standard user: still stops with the error' {
        Mock Test-UserIsAdmin { $false }
        { Confirm-DockerUsersMember -InstallDir 'C:\K' -DesktopUser $script:user } | Should -Throw '*docker-users*'
    }
}

Describe 'docker-users before the Docker Desktop restart (3010)' {
    BeforeEach {
        $script:user = @{ Name = 'PC\tech'; Sid = 'S-1-5-21-1-2-3-1001'; Profile = 'C:\Users\tech' }
        Mock Test-DockerInstalled { $false }
        Mock Test-DockerEngine { $false }
        Mock Assert-Virtualization {}
        Mock Enable-Wsl { $false }
        Mock Get-WindowsArch { 'amd64' }
        Mock Invoke-WebRequest {}
        Mock Get-AuthenticodeSignature { [pscustomobject]@{ Status = 'Valid'; SignerCertificate = [pscustomobject]@{ Subject = 'CN=Docker Inc, O=Docker Inc' } } }
        Mock Start-Process { [pscustomobject]@{ ExitCode = 3010 } }
        $script:order = @()
        Mock Add-DockerUsersMember { $script:order += 'add'; $true }
        Mock Stop-ForRestart { $script:order += "stop:$Action"; throw 'KIOSK_RESTART_PENDING test' }
    }
    It 'adds the user, then the one restart covers the membership too' {
        Mock Test-DockerUsersMember { $false }
        { Install-DockerDesktop -InstallDir 'C:\K' -DesktopUser $script:user } | Should -Throw '*KIOSK_RESTART_PENDING*'
        ($script:order -join ',') | Should -Be 'add,stop:restart'
        Should -Invoke Add-DockerUsersMember -ParameterFilter { $Sid -eq 'S-1-5-21-1-2-3-1001' }
    }
    It 'skips the add for a member' {
        Mock Test-DockerUsersMember { $true }
        { Install-DockerDesktop -InstallDir 'C:\K' -DesktopUser $script:user } | Should -Throw '*KIOSK_RESTART_PENDING*'
        ($script:order -join ',') | Should -Be 'stop:restart'
    }
    It 'a failed add still restarts (the check after the restart deals with it)' {
        Mock Test-DockerUsersMember { $false }
        Mock Add-DockerUsersMember { throw 'Access denied' }
        Mock Write-Warn {}
        { Install-DockerDesktop -InstallDir 'C:\K' -DesktopUser $script:user } | Should -Throw '*KIOSK_RESTART_PENDING*'
        ($script:order -join ',') | Should -Be 'stop:restart'
    }
}

Describe 'Install folder characters' {
    It 'rejects % (it would break the RunOnce cmd /c start command)' {
        { Test-KioskInstallDir -Path 'C:\Kiosk%TEMP%' } | Should -Throw '*%*'
        { Test-KioskInstallDir -Path 'C:\ProgramData\ServerSherpaKiosk' } | Should -Not -Throw
        { Test-KioskInstallDir -Path 'D:\Kiosk Install' } | Should -Not -Throw
    }
    It 'the installer stops before touching anything' {
        $env:KIOSK_DIR = Join-Path $TestDrive 'a%b'
        Mock Assert-64BitProcess {}
        Mock Assert-Admin {}
        Mock Get-DesktopUser { $null }
        Mock Assert-WindowsSupported {}
        Mock Set-KioskDirAcl {}
        Mock Install-DockerDesktop {}
        Mock Test-ApiReachable {}
        Mock Start-InstallLog { $false }
        try {
            Invoke-KioskInstaller -Parameters @{ Yes = $true } | Should -Be 1
        } finally { $env:KIOSK_DIR = $null }
        Should -Invoke Set-KioskDirAcl -Times 0
        Should -Invoke Install-DockerDesktop -Times 0
    }
}

# -- Task 6 fix round 2 -------------------------------------------------------------

Describe 'Per-user ACE on the update files' {
    It 'Admins and SYSTEM full control, Users read, the user Write + ReadAndExecute (no delete)' {
        $rules = @(Get-KioskUserWritableAclRules -UserSid 'S-1-5-21-1-2-3-1001')
        ($rules | ForEach-Object { "$($_[0])=$($_[1])" }) -join ';' |
            Should -Be 'S-1-5-32-544=FullControl;S-1-5-18=FullControl;S-1-5-32-545=ReadAndExecute;S-1-5-21-1-2-3-1001=Write, ReadAndExecute'
        ($rules | ForEach-Object { $_[1] }) | Should -Not -Contain 'Modify'
    }
}

Describe 'Shortcut removal failures' {
    It 'warns instead of swallowing the error' {
        $p = Join-Path $TestDrive 'stuck.lnk'
        'x' | Set-Content $p
        Mock Get-ShortcutPaths { @($p) }
        Mock Get-ScheduledTask { $null }
        Mock Remove-Item { throw 'in use' } -ParameterFilter { $LiteralPath -eq $p }
        Mock Write-Warn {}
        { Remove-LoginItems -InstallDir 'C:\K' } | Should -Not -Throw
        Should -Invoke Write-Warn -Times 1 -ParameterFilter { $Message -like "*stuck.lnk*in use*" }
    }
}

Describe 'Uninstall message' {
    It 'says install.log and update.log were kept' {
        $inst = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        $data = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        New-Item -ItemType Directory $inst, $data | Out-Null
        Mock Remove-LoginItems {}
        # Never the real HKLM RunOnce key or docker on a Windows runner.
        Mock Remove-ResumeRegistration {}
        Mock Stop-KioskForUninstall {}
        Mock Write-Info {}
        Uninstall-Kiosk -InstallDir $inst -DataDir $data
        Should -Invoke Write-Info -Times 1 -ParameterFilter { $Message -like '*install.log and update.log were kept*' }
    }
}

# The real Invoke-Docker against a fake docker.cmd first on PATH: stdout and
# stderr both come back (merged), and a non-zero exit throws with the output.
# A .cmd only runs on Windows; $IsWindows is $null on Windows PowerShell 5.1.
Describe 'Invoke-Docker with a fake docker.cmd' -Skip:($IsWindows -eq $false) {
    BeforeAll {
        $script:fakeBin = Join-Path $TestDrive 'fakebin'
        New-Item -ItemType Directory $script:fakeBin | Out-Null
        Set-Content -Path (Join-Path $script:fakeBin 'docker.cmd') -Encoding Ascii -Value @(
            '@echo off'
            'echo fake-out %*'
            'echo fake-err %* 1>&2'
            'exit /b %FAKE_DOCKER_EXIT%'
        )
        $script:savedPath = $env:Path
        $script:savedExit = $env:FAKE_DOCKER_EXIT
        $env:Path = "$script:fakeBin;$env:Path"
    }
    AfterAll {
        $env:Path = $script:savedPath
        $env:FAKE_DOCKER_EXIT = $script:savedExit
    }

    It 'returns stdout and stderr when docker exits 0' {
        $env:FAKE_DOCKER_EXIT = '0'
        $out = @(Invoke-Docker -Arguments @('compose', 'version'))
        ($out -join "`n") | Should -BeLike '*fake-out compose version*'
        ($out -join "`n") | Should -BeLike '*fake-err compose version*'
    }

    It 'throws with the exit code and output when docker exits 1' {
        $env:FAKE_DOCKER_EXIT = '1'
        { Invoke-Docker -Arguments @('compose', 'pull') } |
            Should -Throw -ExpectedMessage '*docker compose pull failed (exit 1)*fake-err compose pull*'
    }

    It '-Stream shows the output and still puts it in the error when docker exits 1' {
        $env:FAKE_DOCKER_EXIT = '1'
        { Invoke-Docker -Arguments @('compose', 'pull') -Stream } |
            Should -Throw -ExpectedMessage '*docker compose pull failed (exit 1)*fake-err compose pull*'
    }
}

# -- final fix round ------------------------------------------------------------------

Describe 'URL schemes and portal derivation' {
    It 'rejects an API or portal URL without http:// or https://' {
        { Merge-KioskConfig -Saved @{} -Options @{ ApiUrl = 'api.serversherpa.com' } } | Should -Throw '*must start with http:// or https://*'
        { Merge-KioskConfig -Saved @{} -Options @{ ApiUrl = 'ftp://api.x.com' } } | Should -Throw '*must start with http:// or https://*'
        { Merge-KioskConfig -Saved @{} -Options @{ PortalUrl = 'portal.x.com' } } | Should -Throw '*must start with http:// or https://*'
    }
    It 'accepts http and https' {
        $c = Merge-KioskConfig -Saved @{} -Options @{ ApiUrl = 'http://10.0.0.5:8000'; PortalUrl = 'https://p.x.com' }
        $c.EDGE_CLOUD_API_URL | Should -Be 'http://10.0.0.5:8000'
        $c.EDGE_PORTAL_URL | Should -Be 'https://p.x.com'
    }
    It 'derives the portal case-sensitively, like install.sh' {
        Get-PortalUrl -ApiUrl 'https://API.serversherpa.com' | Should -Be ''
        Get-PortalUrl -ApiUrl 'HTTPS://api.serversherpa.com' | Should -Be ''
    }
}

Describe 'Start-Kiosk and update-state.json' {
    BeforeAll {
        # Fake docker for Start-Kiosk: records each call; health answers in turn (the last repeats).
        function Invoke-FakeInstallDocker {
            param([string[]]$Arguments)
            $line = $Arguments -join ' '
            $script:icalls.Add($line)
            foreach ($p in $script:fk.Fail) { if ($line -like $p) { throw "docker $line failed (exit 1). $($script:fk.FailText)" } }
            if ($line -like 'ps -a -q --filter *') { return $script:fk.Ps }
            if ($line -like 'inspect -f {{range*') { return $script:fk.Mount }
            if ($line -like 'inspect -f {{.Image}} *') {
                if (-not $script:fk.Running) { throw "docker $line failed (exit 1). No such object" }
                return $script:fk.Running
            }
            if ($line -eq 'image inspect -f {{.Id}} serversherpa-kiosk-laptop:previous') {
                if (-not $script:fk.PreviousTag) { throw "docker $line failed (exit 1). No such image" }
                return $script:fk.PreviousTag
            }
            if ($line -like 'image inspect -f {{.Id}} *') { return $script:fk.Pulled }
            if ($line -like 'inspect -f {{.State.Health.Status}} *') {
                $i = [Math]::Min($script:fk.HealthIndex, $script:fk.Health.Count - 1)
                $script:fk.HealthIndex++
                return $script:fk.Health[$i]
            }
        }
        function Write-InstallStateFixture {
            param([hashtable]$Values)
            $st = @{ previous_image = ''; image = ''; rejected_image = ''; phase = 'done' }
            foreach ($k in $Values.Keys) { $st[$k] = $Values[$k] }
            [IO.File]::WriteAllText((Join-Path $script:inst 'update-state.json'), ($st | ConvertTo-Json))
        }
        function Get-InstallStateFile { [IO.File]::ReadAllText((Join-Path $script:inst 'update-state.json')) | ConvertFrom-Json }
        $script:Ref = 'ghcr.io/encondata/serversherpa-kiosk-laptop:stable'
    }
    BeforeEach {
        $script:inst = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        New-Item -ItemType Directory $script:inst | Out-Null
        $script:icalls = New-Object System.Collections.Generic.List[string]
        $script:fk = @{ Ps = @(); Mount = ''; Running = 'sha256:old'; Pulled = 'sha256:new'; PreviousTag = ''; Health = @('healthy'); HealthIndex = 0; Fail = @(); FailText = '' }
        Mock Invoke-Docker { Invoke-FakeInstallDocker -Arguments $Arguments }
        Mock Get-KioskJson { [pscustomobject]@{ serial = 'K1' } }
        Mock Start-Sleep {}
        Mock Write-Warn {}
    }
    It 'stops the phase-1 kiosk by its compose label, never compose -p' {
        $script:fk.Ps = @('abc123', 'def456')
        Start-Kiosk -InstallDir $script:inst -ImageRef $script:Ref -Channel stable -TimeoutSeconds 0 -PollSeconds 0 | Out-Null
        $script:icalls[0] | Should -Be 'ps -a -q --filter label=com.docker.compose.project=serversherpa-kiosk-laptop'
        $script:icalls[1] | Should -Be 'stop abc123 def456'
        @($script:icalls | Where-Object { $_ -like 'compose -p*' }) | Should -BeNullOrEmpty
    }
    It 'keeps the current version when the pulled image failed its health check before' {
        Write-InstallStateFixture @{ previous_image = 'sha256:older'; rejected_image = 'sha256:bad' }
        $script:fk.Pulled = 'sha256:bad'
        Start-Kiosk -InstallDir $script:inst -ImageRef $script:Ref -Channel stable -TimeoutSeconds 0 -PollSeconds 0 | Out-Null
        Should -Invoke Write-Warn -ParameterFilter { $Message -eq 'The newest version failed its health check on this laptop before; keeping the current one.' }
        $calls = @($script:icalls)
        $iTag = [array]::IndexOf($calls, "tag sha256:old $script:Ref")
        $iTag | Should -BeGreaterOrEqual 0
        $iUp = [array]::IndexOf($calls, ($calls | Where-Object { $_ -like 'compose -f * up -d' } | Select-Object -First 1))
        $iTag | Should -BeLessThan $iUp
        $st = Get-InstallStateFile
        "$($st.phase) $($st.rejected_image) $($st.previous_image)" | Should -Be 'done sha256:bad sha256:older'
    }
    It 'rolls back to the previous version when the new one never turns healthy' {
        $script:fk.Health = @('unhealthy', 'healthy')
        { Start-Kiosk -InstallDir $script:inst -ImageRef $script:Ref -Channel stable -TimeoutSeconds 0 -PollSeconds 0 } |
            Should -Throw '*rolled back to the previous version*'
        $calls = @($script:icalls)
        $iTag = [array]::IndexOf($calls, "tag sha256:old $script:Ref")
        $iTag | Should -BeGreaterOrEqual 0
        @($calls[$iTag..($calls.Count - 1)] | Where-Object { $_ -like 'compose -f * up -d' }).Count | Should -Be 1
        $st = Get-InstallStateFile
        $st.rejected_image | Should -Be 'sha256:new'
        $st.phase | Should -Be 'done'
    }
    It 'says so when the rollback is not healthy either' {
        $script:fk.Health = @('unhealthy')
        { Start-Kiosk -InstallDir $script:inst -ImageRef $script:Ref -Channel stable -TimeoutSeconds 0 -PollSeconds 0 } |
            Should -Throw "*isn't healthy either*"
    }
    It 'does not roll back without an earlier image' {
        $script:fk.Running = ''; $script:fk.Health = @('unhealthy')
        { Start-Kiosk -InstallDir $script:inst -ImageRef $script:Ref -Channel stable -TimeoutSeconds 0 -PollSeconds 0 } |
            Should -Throw "*didn't become healthy in time*"
        @($script:icalls | Where-Object { $_ -like 'tag *' }) | Should -BeNullOrEmpty
    }
    It 'resets a stale updating phase to done, keeping rejected_image and previous_image, written in place' {
        Write-InstallStateFixture @{ previous_image = 'sha256:older'; rejected_image = 'sha256:x'; phase = 'updating' }
        $p = Join-Path $script:inst 'update-state.json'
        $created = (Get-Item $p).CreationTimeUtc
        [Threading.Thread]::Sleep(20)
        Start-Kiosk -InstallDir $script:inst -ImageRef $script:Ref -Channel stable -TimeoutSeconds 0 -PollSeconds 0 | Out-Null
        $st = Get-InstallStateFile
        "$($st.phase) $($st.rejected_image) $($st.previous_image)" | Should -Be 'done sha256:x sha256:older'
        (Get-Item $p).CreationTimeUtc | Should -Be $created
    }
    It 'says the image is not published when the registry refuses it (<_>)' -ForEach @('manifest unknown', 'denied: requested access to the resource is denied', 'unauthorized: authentication required', 'not found') {
        $script:fk.Fail = @('compose -f * pull'); $script:fk.FailText = "Error response from daemon: $_"
        { Start-Kiosk -InstallDir $script:inst -ImageRef $script:Ref -Channel stable -TimeoutSeconds 0 -PollSeconds 0 } |
            Should -Throw "*the stable image isn't published yet, or its package isn't public*try -Channel edge, or ask your administrator*"
    }
    It 'a rollback without a pulled image ID keeps the earlier rejected image' {
        Write-InstallStateFixture @{ rejected_image = 'sha256:bad' }
        $script:fk.Pulled = ''; $script:fk.Health = @('unhealthy', 'healthy')
        { Start-Kiosk -InstallDir $script:inst -ImageRef $script:Ref -Channel stable -TimeoutSeconds 0 -PollSeconds 0 } |
            Should -Throw '*rolled back to the previous version*'
        (Get-InstallStateFile).rejected_image | Should -Be 'sha256:bad'
    }
    It 'with no container, a rejected image gives way to the kept :previous image' {
        Write-InstallStateFixture @{ rejected_image = 'sha256:bad' }
        $script:fk.Running = ''; $script:fk.Pulled = 'sha256:bad'; $script:fk.PreviousTag = 'sha256:prev'
        Start-Kiosk -InstallDir $script:inst -ImageRef $script:Ref -Channel stable -TimeoutSeconds 0 -PollSeconds 0 | Out-Null
        Should -Invoke Write-Warn -ParameterFilter { $Message -like '*starting the kept previous version*' }
        $calls = @($script:icalls)
        $iTag = [array]::IndexOf($calls, "tag serversherpa-kiosk-laptop:previous $script:Ref")
        $iTag | Should -BeGreaterOrEqual 0
        $iUp = [array]::IndexOf($calls, ($calls | Where-Object { $_ -like 'compose -f * up -d' } | Select-Object -First 1))
        $iTag | Should -BeLessThan $iUp
        (Get-InstallStateFile).rejected_image | Should -Be 'sha256:bad'
    }
    It 'with no container and no kept image, the rejected image starts anyway' {
        Write-InstallStateFixture @{ rejected_image = 'sha256:bad' }
        $script:fk.Running = ''; $script:fk.Pulled = 'sha256:bad'
        Start-Kiosk -InstallDir $script:inst -ImageRef $script:Ref -Channel stable -TimeoutSeconds 0 -PollSeconds 0 | Out-Null
        Should -Invoke Write-Warn -ParameterFilter { $Message -like '*no earlier version is kept, so starting it anyway*' }
        @($script:icalls | Where-Object { $_ -like 'tag *' }) | Should -BeNullOrEmpty
    }
    It 'keeps the network message for other pull failures' {
        $script:fk.Fail = @('compose -f * pull'); $script:fk.FailText = 'dial tcp: lookup ghcr.io: no such host'
        { Start-Kiosk -InstallDir $script:inst -ImageRef $script:Ref -Channel stable -TimeoutSeconds 0 -PollSeconds 0 } |
            Should -Throw '*Check the network*'
    }
}

Describe 'Phase-1 data through the old container mount' {
    BeforeEach {
        $script:icalls = New-Object System.Collections.Generic.List[string]
        $script:fk = @{ Ps = @('abc123'); Mount = ''; Running = ''; Pulled = ''; Health = @('healthy'); HealthIndex = 0; Fail = @(); FailText = '' }
        Mock Invoke-Docker {
            $line = $Arguments -join ' '
            $script:icalls.Add($line)
            if ($line -like 'ps -a -q --filter *') { return $script:fk.Ps }
            if ($line -like 'inspect -f {{range*') { return $script:fk.Mount }
        }
        $script:legacy = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        New-Item -ItemType Directory $script:legacy | Out-Null
        '{"serial":"from-mount"}' | Set-Content (Join-Path $script:legacy 'identity.json')
        $script:data = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        New-Item -ItemType Directory $script:data | Out-Null
        $env:EDGE_DATA_HOST_DIR = $null
        Mock Write-Warn {}
    }
    It 'copies from the folder the old container mounts at /data, asking docker by label' {
        $script:fk.Mount = $script:legacy
        Mock ConvertFrom-DockerMountSource { $Source }
        $home1 = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        Mock Get-LegacyDataDir { $home1 }
        Invoke-LegacyMigration -UserProfile 'C:\Users\tech' -DataDir $script:data | Should -BeTrue
        (Get-Content (Join-Path $script:data 'identity.json')) | Should -BeLike '*from-mount*'
        $script:icalls | Should -Contain 'ps -a -q --filter label=com.docker.compose.project=serversherpa-kiosk-laptop'
        $script:icalls | Should -Contain 'inspect -f {{range .Mounts}}{{if eq .Destination `/data`}}{{.Source}}{{end}}{{end}} abc123'
        $script:icalls | Should -Contain 'stop abc123'
    }
    It 'stops before the new kiosk when the mount is a WSL folder, with the \\wsl$ path to copy from' {
        $script:fk.Mount = '/home/tech/ServerSherpaKiosk'
        { Invoke-LegacyMigration -UserProfile 'C:\Users\tech' -DataDir $script:data } |
            Should -Throw '*/home/tech/ServerSherpaKiosk*\\wsl$\<distro>\home\tech\ServerSherpaKiosk*-StartFresh*'
        @(Get-ChildItem $script:data).Count | Should -Be 0
    }
    It '-StartFresh skips an unreadable mount knowingly' {
        $script:fk.Mount = '/home/tech/ServerSherpaKiosk'
        Invoke-LegacyMigration -UserProfile 'C:\Users\tech' -DataDir $script:data -StartFresh | Should -BeFalse
        Should -Invoke Write-Warn -ParameterFilter { $Message -like '*-StartFresh*/home/tech/ServerSherpaKiosk*' }
        @(Get-ChildItem $script:data).Count | Should -Be 0
    }
    It '-StartFresh skips a readable phase-1 folder too' {
        $script:fk.Mount = $script:legacy
        Mock ConvertFrom-DockerMountSource { $Source }
        Invoke-LegacyMigration -UserProfile 'C:\Users\tech' -DataDir $script:data -StartFresh | Should -BeFalse
        Should -Invoke Write-Warn -ParameterFilter { $Message -eq "Starting fresh (-StartFresh): the earlier kiosk's data in $script:legacy was not copied." }
        @(Get-ChildItem $script:data).Count | Should -Be 0
    }
    It 'a mount inside a WSL distribution says so in the hint' {
        $script:fk.Mount = '/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu/abc123'
        { Invoke-LegacyMigration -UserProfile 'C:\Users\tech' -DataDir $script:data } |
            Should -Throw '*inside the WSL distribution, usually \\wsl$\<distro>\home\<you>\ServerSherpaKiosk*-StartFresh*'
    }
    It 'an unreadable mount is fine when the data folder already holds data' {
        $script:fk.Mount = '/home/tech/ServerSherpaKiosk'
        'mine' | Set-Content (Join-Path $script:data 'edge.db')
        Invoke-LegacyMigration -UserProfile 'C:\Users\tech' -DataDir $script:data | Should -BeFalse
    }
    It 'without an old container, falls back to the home folder' {
        $script:fk.Ps = @()
        Mock Get-LegacyDataDir { $script:legacy }
        Invoke-LegacyMigration -UserProfile 'C:\Users\tech' -DataDir $script:data | Should -BeTrue
        (Get-Content (Join-Path $script:data 'identity.json')) | Should -BeLike '*from-mount*'
    }
    It 'maps Docker Desktop mount sources to Windows folders; WSL paths map to nothing' {
        ConvertFrom-DockerMountSource -Source 'C:\Users\tech\ServerSherpaKiosk' | Should -Be 'C:\Users\tech\ServerSherpaKiosk'
        ConvertFrom-DockerMountSource -Source '/run/desktop/mnt/host/c/Users/tech/ServerSherpaKiosk' | Should -Be 'C:\Users\tech\ServerSherpaKiosk'
        ConvertFrom-DockerMountSource -Source '/host_mnt/d/kiosk' | Should -Be 'D:\kiosk'
        ConvertFrom-DockerMountSource -Source '/home/tech/ServerSherpaKiosk' | Should -Be ''
    }
}

Describe 'ACL owner' {
    BeforeEach {
        # A stand-in for FileSecurity/DirectorySecurity (ACL types need Windows).
        $script:sec = [pscustomobject]@{ Owner = $null; Rules = (New-Object System.Collections.ArrayList); Protected = $null; Kind = '' }
        $script:sec | Add-Member ScriptMethod SetOwner { param($o) $this.Owner = $o }
        $script:sec | Add-Member ScriptMethod AddAccessRule { param($r) [void]$this.Rules.Add($r) }
        $script:sec | Add-Member ScriptMethod SetAccessRuleProtection { param($a, $b) $this.Protected = $a; $null = $b }
        Mock New-KioskSecurity { $script:sec.Kind = $(if ($Directory) { 'dir' } else { 'file' }); $script:sec }
        Mock ConvertTo-SecurityIdentifier { "sid:$Sid" }
        Mock New-KioskAccessRule { "$Sid=$Rights" + $(if ($Inherit) { '+inherit' } else { '' }) }
        Mock Set-Acl {}
    }
    It 'Set-KioskFileAcl makes BUILTIN\Administrators the owner' {
        Set-KioskFileAcl -Path 'C:\K\config.env'
        $script:sec.Kind | Should -Be 'file'
        $script:sec.Owner | Should -Be 'sid:S-1-5-32-544'
        $script:sec.Protected | Should -BeTrue
        ($script:sec.Rules -join ';') | Should -Be 'sid:S-1-5-32-544=FullControl;sid:S-1-5-18=FullControl;sid:S-1-5-32-545=ReadAndExecute'
        Should -Invoke Set-Acl -Times 1 -ParameterFilter { $LiteralPath -eq 'C:\K\config.env' }
    }
    It 'Set-KioskDirAcl makes BUILTIN\Administrators the owner' {
        Set-KioskDirAcl -Path 'C:\K\data' -UserSid 'S-1-5-21-9'
        $script:sec.Kind | Should -Be 'dir'
        $script:sec.Owner | Should -Be 'sid:S-1-5-32-544'
        ($script:sec.Rules -join ';') | Should -Be 'sid:S-1-5-32-544=FullControl+inherit;sid:S-1-5-18=FullControl+inherit;sid:S-1-5-21-9=FullControl+inherit'
    }
    It 'the per-user writable update files get the same owner' {
        Set-KioskUserWritableFileAcl -Path 'C:\K\update.log' -UserSid 'S-1-5-21-9'
        $script:sec.Owner | Should -Be 'sid:S-1-5-32-544'
        ($script:sec.Rules -join ';') | Should -BeLike '*sid:S-1-5-21-9=Write, ReadAndExecute'
    }
}

Describe 'Pre-created data folder' {
    BeforeEach {
        $script:user = @{ Name = 'PC\tech'; Sid = 'S-1-5-21-1-2-3-1001'; Profile = 'C:\Users\tech' }
        $script:data = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        Mock Set-KioskDirAcl {}
    }
    It 'creates a missing folder with the data ACL' {
        New-KioskDataDir -DataDir $script:data -DesktopUser $script:user
        Test-Path $script:data | Should -BeTrue
        Should -Invoke Set-KioskDirAcl -Times 1 -ParameterFilter { $Path -eq $script:data -and $UserSid -eq 'S-1-5-21-1-2-3-1001' -and -not $UsersRead }
    }
    It 'accepts an existing folder owned by <_>, leaving it alone when it holds data' -ForEach @('S-1-5-32-544', 'S-1-5-18', 'S-1-5-21-1-2-3-1001') {
        New-Item -ItemType Directory $script:data | Out-Null
        'db' | Set-Content (Join-Path $script:data 'edge.db')
        $owner = $_
        Mock Get-KioskPathOwnerSid { $owner }
        New-KioskDataDir -DataDir $script:data -DesktopUser $script:user
        Should -Invoke Set-KioskDirAcl -Times 0
    }
    It 'finishes an empty folder an earlier run made (the data ACL again)' {
        New-Item -ItemType Directory $script:data | Out-Null
        Mock Get-KioskPathOwnerSid { 'S-1-5-32-544' }
        New-KioskDataDir -DataDir $script:data -DesktopUser $script:user
        Should -Invoke Set-KioskDirAcl -Times 1 -ParameterFilter { $Path -eq $script:data }
    }
    It 'stops, without changing it, when someone else owns the folder' {
        New-Item -ItemType Directory $script:data | Out-Null
        Mock Get-KioskPathOwnerSid { 'S-1-5-21-6-6-6-1234' }
        { New-KioskDataDir -DataDir $script:data -DesktopUser $script:user } | Should -Throw '*S-1-5-21-6-6-6-1234*'
        Should -Invoke Set-KioskDirAcl -Times 0
    }
    It 'stops when the owner cannot be read' {
        New-Item -ItemType Directory $script:data | Out-Null
        Mock Get-KioskPathOwnerSid { throw 'access denied' }
        { New-KioskDataDir -DataDir $script:data -DesktopUser $script:user } | Should -Throw "*Couldn't check who owns*"
        Should -Invoke Set-KioskDirAcl -Times 0
    }
}

Describe 'Data folder placement' {
    It 'refuses the install folder itself' {
        { Assert-KioskDataDirPlacement -InstallDir 'C:\ProgramData\ServerSherpaKiosk' -DataDir 'C:\ProgramData\ServerSherpaKiosk' } | Should -Throw '*install folder*'
        { Assert-KioskDataDirPlacement -InstallDir 'C:\ProgramData\ServerSherpaKiosk' -DataDir 'c:/programdata/serversherpakiosk/' } | Should -Throw '*install folder*'
    }
    It 'refuses a folder inside the install folder other than its data subfolder' {
        { Assert-KioskDataDirPlacement -InstallDir 'C:\K' -DataDir 'C:\K\other' } | Should -Throw '*inside the install folder*'
        { Assert-KioskDataDirPlacement -InstallDir 'C:\K' -DataDir 'C:\K\data\deeper' } | Should -Throw '*inside the install folder*'
    }
    It 'allows the default data subfolder and folders elsewhere' {
        { Assert-KioskDataDirPlacement -InstallDir 'C:\ProgramData\ServerSherpaKiosk' -DataDir 'C:\ProgramData\ServerSherpaKiosk\data' } | Should -Not -Throw
        { Assert-KioskDataDirPlacement -InstallDir 'C:\K' -DataDir 'C:\K2\data' } | Should -Not -Throw
        { Assert-KioskDataDirPlacement -InstallDir 'C:\K' -DataDir 'D:\KioskData' } | Should -Not -Throw
    }
    It 'the installer checks it before the install folder ACL is applied' {
        $inst = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        $env:KIOSK_DIR = $inst; $env:KIOSK_DATA_DIR = $inst
        foreach ($f in @('Assert-64BitProcess', 'Assert-Admin', 'Assert-WindowsSupported', 'Set-KioskDirAcl', 'Start-InstallLog')) { Mock $f {} }
        Mock Get-DesktopUser { $null }
        Mock Find-Browser { '' }
        try {
            Invoke-KioskInstaller -Parameters @{ Yes = $true } | Should -Be 1
        } finally { $env:KIOSK_DIR = $null; $env:KIOSK_DATA_DIR = $null }
        Should -Invoke Set-KioskDirAcl -Times 0
    }
}

Describe 'Install summary' {
    It 'names the account the kiosk was set up for' {
        Mock Get-KioskJson { $null }
        Mock Write-Host {}
        Write-Summary -Identity $null -Config @{ KIOSK_CHANNEL = 'stable' } -InstallDir 'C:\K' -DesktopUser @{ Name = 'PC\tech'; Sid = 'S-1-5-21-1' }
        Should -Invoke Write-Host -ParameterFilter { "$Object" -eq '  Set up for: PC\tech (the kiosk opens when this account signs in)' }
    }
}

Describe 'Resume files are rewritten with the install ACL' {
    BeforeEach {
        $script:inst = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        New-Item -ItemType Directory $script:inst | Out-Null
        Mock Set-KioskFileAcl {}
    }
    It 'install-state.json: a planted file is removed first, the new one gets Set-KioskFileAcl' {
        $p = Join-Path $script:inst 'install-state.json'
        'planted' | Set-Content $p
        $script:order = New-Object System.Collections.Generic.List[string]
        Mock Remove-Item { $script:order.Add("remove $LiteralPath"); [IO.File]::Delete($LiteralPath) } -ParameterFilter { $LiteralPath -eq $p }
        Mock Set-KioskFileAcl { $script:order.Add("acl $Path") }
        Save-ResumeState -Path $p -Step 'engine' -Arguments @{ Yes = $true }
        ($script:order -join ';') | Should -Be "remove $p;acl $p"
        (Read-ResumeState -Path $p).step | Should -Be 'engine'
    }
    It 'install.ps1: a planted copy is removed first, the new one gets Set-KioskFileAcl' {
        $dest = Join-Path $script:inst 'install.ps1'
        'planted' | Set-Content $dest
        $SelfPath = $null
        $script:order = New-Object System.Collections.Generic.List[string]
        Mock Remove-Item { $script:order.Add("remove $LiteralPath"); [IO.File]::Delete($LiteralPath) } -ParameterFilter { $LiteralPath -eq $dest }
        Mock Set-KioskFileAcl { $script:order.Add("acl $Path") }
        Save-InstallerCopy -InstallDir $script:inst
        ($script:order -join ';') | Should -Be "remove $dest;acl $dest"
        [IO.File]::ReadAllText($dest) | Should -Be ([IO.File]::ReadAllText((Join-Path $PSScriptRoot '../install.ps1')))
    }
    It 'install.ps1 copied from the running script also gets the ACL' {
        $dest = Join-Path $script:inst 'install.ps1'
        $SelfPath = (Resolve-Path (Join-Path $PSScriptRoot '../install.ps1')).Path
        Save-InstallerCopy -InstallDir $script:inst
        Should -Invoke Set-KioskFileAcl -Times 1 -ParameterFilter { $Path -eq $dest }
        Test-Path $dest | Should -BeTrue
    }
}

Describe 'Start-Kiosk on the containerd image store' {
    BeforeAll {

# A stateful fake docker modeling the image store (fix round 3). Mode
# 'containerd' (Docker Desktop's containerd store): an image with no name
# left can't be found by its ID, even while a container runs it. Mode
# 'classic': it can (dangling). compose pull moves Ref to Pulled; compose
# up -d runs what Ref names; images in Bad are unhealthy.
function Initialize-StoreDocker {
    param([string]$Mode, [string]$Ref, [hashtable]$Tags, [string]$Running = '', [string]$Pulled = '', [string[]]$Bad = @())
    $known = New-Object System.Collections.Generic.HashSet[string]
    foreach ($v in $Tags.Values) { [void]$known.Add($v) }
    if ($Running) { [void]$known.Add($Running) }
    $script:store = @{ Mode = $Mode; Ref = $Ref; Tags = $Tags.Clone(); Running = $Running; Pulled = $Pulled; Bad = $Bad; Known = $known
        Calls = (New-Object System.Collections.Generic.List[string]) }
}
function Resolve-StoreImage {
    param([string]$Name)
    if ($Name -like 'sha256:*') {
        if ($script:store.Tags.Values -contains $Name) { return $Name }
        if ($script:store.Mode -eq 'classic' -and $script:store.Known.Contains($Name)) { return $Name }
        return $null
    }
    $script:store.Tags[$Name]
}
function Invoke-StoreDocker {
    param([string[]]$Arguments)
    $line = $Arguments -join ' '
    $script:store.Calls.Add($line)
    $a = $Arguments
    if ($a[0] -eq 'inspect') {
        if (-not $script:store.Running) { throw "docker $line failed (exit 1). No such object" }
        if ($line -like '*State.Health*') { if ($script:store.Bad -contains $script:store.Running) { return 'unhealthy' } else { return 'healthy' } }
        if ($line -like '*{{.Image}}*') { return $script:store.Running }
        return
    }
    if ($a[0] -eq 'image' -and $a[1] -eq 'inspect') {
        $id = Resolve-StoreImage -Name $a[-1]
        if (-not $id) { throw "docker $line failed (exit 1). No such image: $($a[-1])" }
        return $id
    }
    if ($a[0] -eq 'tag') {
        $id = Resolve-StoreImage -Name $a[1]
        if (-not $id) { throw "docker $line failed (exit 1). Error response from daemon: No such image: $($a[1])" }
        $script:store.Tags[$a[2]] = $id
        return
    }
    if ($a[0] -eq 'compose') {
        if ($a[-1] -eq 'pull') { $script:store.Tags[$script:store.Ref] = $script:store.Pulled; [void]$script:store.Known.Add($script:store.Pulled) }
        if ($a[-1] -eq '-d') {
            $id = Resolve-StoreImage -Name $script:store.Ref
            if (-not $id) { throw "docker $line failed (exit 1)." }
            $script:store.Running = $id
        }
    }
}

        function Get-InstallStateFile2 { [IO.File]::ReadAllText((Join-Path $script:inst 'update-state.json')) | ConvertFrom-Json }
    }
    BeforeEach {
        $script:inst = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        New-Item -ItemType Directory $script:inst | Out-Null
        $script:Ref = 'ghcr.io/encondata/serversherpa-kiosk-laptop:stable'
        $script:Prev = 'serversherpa-kiosk-laptop:previous'
        Mock Invoke-Docker { Invoke-StoreDocker -Arguments $Arguments }
        Mock Get-KioskJson { [pscustomobject]@{ serial = 'K1' } }
        Mock Start-Sleep {}
        Mock Write-Warn {}
    }
    It 'tags :previous by name before the pull (<_>)' -ForEach @('containerd', 'classic') {
        Initialize-StoreDocker -Mode $_ -Ref $script:Ref -Tags @{ $script:Ref = 'sha256:old' } -Running 'sha256:old' -Pulled 'sha256:new'
        Start-Kiosk -InstallDir $script:inst -ImageRef $script:Ref -TimeoutSeconds 0 -PollSeconds 0 | Out-Null
        $calls = @($script:store.Calls)
        $iPrev = [array]::IndexOf($calls, "tag $script:Ref $script:Prev")
        $iPrev | Should -BeGreaterOrEqual 0
        $iPrev | Should -BeLessThan ([array]::IndexOf($calls, ($calls | Where-Object { $_ -like 'compose * pull' } | Select-Object -First 1)))
        $script:store.Tags[$script:Prev] | Should -Be 'sha256:old'
    }
    It 'a rollback tags the channel from :previous (<_>)' -ForEach @('containerd', 'classic') {
        Initialize-StoreDocker -Mode $_ -Ref $script:Ref -Tags @{ $script:Ref = 'sha256:old' } -Running 'sha256:old' -Pulled 'sha256:new' -Bad @('sha256:new')
        { Start-Kiosk -InstallDir $script:inst -ImageRef $script:Ref -TimeoutSeconds 0 -PollSeconds 0 } | Should -Throw '*rolled back to the previous version*'
        $script:store.Running | Should -Be 'sha256:old'
        (Get-InstallStateFile2).rejected_image | Should -Be 'sha256:new'
    }
    It 'the rejected skip re-points the channel from :previous (<_>)' -ForEach @('containerd', 'classic') {
        $st = @{ previous_image = ''; image = ''; rejected_image = 'sha256:bad'; phase = 'done' }
        [IO.File]::WriteAllText((Join-Path $script:inst 'update-state.json'), ($st | ConvertTo-Json))
        Initialize-StoreDocker -Mode $_ -Ref $script:Ref -Tags @{ $script:Ref = 'sha256:old' } -Running 'sha256:old' -Pulled 'sha256:bad'
        Start-Kiosk -InstallDir $script:inst -ImageRef $script:Ref -TimeoutSeconds 0 -PollSeconds 0 | Out-Null
        $script:store.Calls | Should -Contain "tag $script:Prev $script:Ref"
        $script:store.Tags[$script:Ref] | Should -Be 'sha256:old'
        $script:store.Running | Should -Be 'sha256:old'
    }
}
