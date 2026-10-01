BeforeAll {
    $env:KIOSK_INSTALL_LIB = '1'
    $env:KIOSK_TEMPLATE_DIR = (Resolve-Path "$PSScriptRoot/..").Path
    . "$PSScriptRoot/../install.ps1" -LibraryOnly
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
    It 'renders image, loopback port and a forward-slash data path' {
        $t = Get-ComposeText -ImageRef 'ghcr.io/encondata/serversherpa-kiosk-laptop:stable' -DataDir 'C:\ProgramData\ServerSherpaKiosk\data'
        $t | Should -Match 'image: ghcr.io/encondata/serversherpa-kiosk-laptop:stable'
        $t | Should -Match '"C:/ProgramData/ServerSherpaKiosk/data:/data"'
        $t | Should -Match '"127.0.0.1:8090:8090"'
    }
    It 'uses KIOSK_IMAGE when set' {
        $env:KIOSK_IMAGE = 'local/kiosk:test'
        Get-ImageRef -Channel stable | Should -Be 'local/kiosk:test'
        $env:KIOSK_IMAGE = $null
        Get-ImageRef -Channel edge | Should -Be 'ghcr.io/encondata/serversherpa-kiosk-laptop:edge'
    }
}

Describe 'Resume after reboot' {
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
        Mock Invoke-Docker {}
        Mock Remove-LoginItems {}
        Uninstall-Kiosk -InstallDir $inst -DataDir $data
        Test-Path (Join-Path $data 'identity.json') | Should -BeTrue
        Test-Path (Join-Path $inst 'config.env') | Should -BeFalse
        { Uninstall-Kiosk -InstallDir $inst -DataDir $data -PurgeData } | Should -Throw
        $env:KIOSK_CONFIRM_PURGE = 'DELETE'
        Uninstall-Kiosk -InstallDir $inst -DataDir $data -PurgeData
        Test-Path $data | Should -BeFalse
        $env:KIOSK_CONFIRM_PURGE = $null
    }
}

# ── Beyond the brief: the lessons from the reviewed shell installer ─────

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
        (Merge-KioskConfig -Saved $saved -Options @{ DataDir = 'E:\Other' }).KIOSK_DATA_DIR | Should -Be 'E:\Other'
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
        Mock Invoke-Docker {}
    }
    It 'copies into an absent data folder and stops the phase-1 kiosk' {
        $data = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        Copy-LegacyKioskData -LegacyDir $legacy -DataDir $data | Should -BeTrue
        Test-Path (Join-Path $data 'identity.json') | Should -BeTrue
        Test-Path (Join-Path $legacy 'identity.json') | Should -BeTrue
        Should -Invoke Invoke-Docker -ParameterFilter { $Arguments -contains 'stop' }
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
        $env:KIOSK_IMAGE = "o'brien/kiosk:test"
        try {
            $cmd = Get-ElevationCommand -ScriptPath 'C:\Temp\serversherpa-kiosk-install.ps1' -Parameters @{ ApiUrl = 'https://api.a.com'; Yes = [switch]$true; Uninstall = [switch]$false }
        } finally { $env:KIOSK_IMAGE = $null }
        $cmd | Should -Match "\`$env:KIOSK_IMAGE = 'o''brien/kiosk:test'"
        $cmd | Should -Match "& 'C:\\Temp\\serversherpa-kiosk-install.ps1'"
        $cmd | Should -Match "-ApiUrl 'https://api.a.com'"
        $cmd | Should -Match '-Yes(\s|$)'
        $cmd | Should -Not -Match '-Uninstall'
    }
}

Describe 'Script hygiene' {
    It 'is plain ASCII, so Windows PowerShell 5.1 reads it correctly without a byte-order mark' {
        $bytes = [System.IO.File]::ReadAllBytes((Join-Path $PSScriptRoot '../install.ps1'))
        ($bytes | Where-Object { $_ -gt 127 }).Count | Should -Be 0
    }
}
