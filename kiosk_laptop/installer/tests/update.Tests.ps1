# update.ps1 (nightly updater) and launch.ps1 (at-sign-in launcher): the
# Windows ports of update.sh / launch.sh. Mirrors tests/test_update_sh.py case
# by case; Docker is a fake (Invoke-Docker mock) that records each call as one
# line, like the shell tests' fake docker script.

BeforeAll {
    $script:SavedEnv = @{}
    foreach ($n in @('KIOSK_UPDATE_LIB', 'KIOSK_LAUNCH_LIB', 'KIOSK_DIR', 'KIOSK_LAUNCH_TIMEOUT_S', 'KIOSK_LAUNCH_POLL_S')) {
        $script:SavedEnv[$n] = [Environment]::GetEnvironmentVariable($n)
    }
    $env:KIOSK_UPDATE_LIB = '1'
    $env:KIOSK_LAUNCH_LIB = '1'
    . "$PSScriptRoot/../update.ps1" -LibraryOnly
    . "$PSScriptRoot/../launch.ps1" -LibraryOnly

    $script:Idle = '{"outbox": {"queued": 0, "sending": 0, "needs_sign_in": 4, "failed": 1}}'
    $script:Stable = 'ghcr.io/encondata/serversherpa-kiosk-laptop:stable'

    # The fake docker: records "a b c" per call, answers like the shell tests'
    # fake script, and fails (exit 1, so Invoke-Docker throws) on any pattern in Fail.
    function Invoke-FakeDocker {
        param([string[]]$Arguments)
        $line = $Arguments -join ' '
        $script:calls.Add($line)
        foreach ($p in $script:dk.Fail) { if ($line -like $p) { throw "docker $line failed (exit 1)." } }
        if ($line -like 'inspect --format {{.Image}} *') { return $script:dk.Running }
        if ($line -eq 'image inspect --format {{.Id}} serversherpa-kiosk-laptop:previous' -and $null -ne $script:dk.PreviousTag) { return $script:dk.PreviousTag }
        if ($line -like 'image inspect --format {{.Id}} *') { return $script:dk.Pulled }
        if ($line -like 'inspect --format {{.State.Health.Status}} *') { return $script:dk.Health }
    }

    function Get-DockerCallLine { $script:calls.ToArray() }
    function Get-UpdateLogText {
        $p = Join-Path $script:dir 'update.log'
        if (Test-Path $p) { return [IO.File]::ReadAllText($p) }
        ''
    }
    function Write-StateFixture {
        param([hashtable]$Values)
        $s = @{ previous_image = ''; image = ''; rejected_image = ''; phase = 'done' }
        foreach ($k in $Values.Keys) { $s[$k] = $Values[$k] }
        [IO.File]::WriteAllText((Join-Path $script:dir 'update-state.json'), ($s | ConvertTo-Json))
    }
    function Get-UpdateStateFile { [IO.File]::ReadAllText((Join-Path $script:dir 'update-state.json')) | ConvertFrom-Json }
    function Test-UpAfter {
        param([int]$Index)
        $lines = @(Get-DockerCallLine)
        for ($i = $Index; $i -lt $lines.Count; $i++) { if ($lines[$i] -like '* up -d') { return $true } }
        $false
    }
}

AfterAll {
    foreach ($n in $script:SavedEnv.Keys) { [Environment]::SetEnvironmentVariable($n, $script:SavedEnv[$n]) }
}

Describe 'update.ps1' {
    BeforeEach {
        $script:dir = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        New-Item -ItemType Directory $script:dir | Out-Null
        $env:KIOSK_DIR = $script:dir
        $script:calls = New-Object System.Collections.Generic.List[string]
        $script:dk = @{ Running = 'sha256:old'; Pulled = 'sha256:new'; Health = 'healthy'; PreviousTag = $null; Fail = @() }
        $script:status = $script:Idle
        Mock Invoke-Docker { Invoke-FakeDocker -Arguments $Arguments }
        Mock Get-EdgeStatusJson { $script:status }
        Mock Start-Sleep {}
    }
    AfterEach { $env:KIOSK_DIR = $null }

    # -- the brief's cases --------------------------------------------------
    It 'skips while scans are uploading' {
        $script:status = '{"outbox": {"queued": 2, "sending": 0}}'
        Invoke-KioskUpdate | Should -Be 0
        Get-UpdateLogText | Should -BeLike '*skipped*'
        @(Get-DockerCallLine) -like '*pull*' | Should -BeNullOrEmpty
    }
    It 'does nothing when the pulled image is the running one' {
        $script:dk.Running = 'sha256:same'; $script:dk.Pulled = 'sha256:same'
        Invoke-KioskUpdate | Should -Be 0
        @(Get-DockerCallLine) -like '*pull' | Should -Not -BeNullOrEmpty
        @(Get-DockerCallLine) -like '* up *' | Should -BeNullOrEmpty
    }
    It 'rolls back (exit 1) when the new image never turns healthy, re-tagging and then starting again' {
        $script:dk.Health = 'unhealthy'
        Invoke-KioskUpdate -HealthTimeoutSeconds 0 | Should -Be 1
        Get-UpdateLogText | Should -BeLike '*rolled back*'
        $lines = @(Get-DockerCallLine)
        $tag = -1
        for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -eq "tag sha256:old $script:Stable") { $tag = $i } }
        $tag | Should -BeGreaterOrEqual 0
        Test-UpAfter -Index $tag | Should -BeTrue
    }
    It 'trims update.log to the last 1 MB' {
        $p = Join-Path $script:dir 'update.log'
        [IO.File]::WriteAllText($p, ('x' * (2 * 1024 * 1024)) + 'TAIL')
        Limit-Log -Path $p
        $text = [IO.File]::ReadAllText($p)
        [Text.Encoding]::UTF8.GetByteCount($text) | Should -BeLessOrEqual (1024 * 1024)
        $text.EndsWith('TAIL') | Should -BeTrue
    }

    # -- beyond the brief (test_update_sh.py) ---------------------------------
    It 'applies a new image: tags :previous, starts, then prunes only kiosk images' {
        Invoke-KioskUpdate | Should -Be 0
        $lines = @(Get-DockerCallLine)
        $iKeep = [array]::IndexOf($lines, 'tag sha256:old serversherpa-kiosk-laptop:previous')
        $iUp = -1
        for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -like '* up -d') { $iUp = $i; break } }
        $iPrune = [array]::IndexOf($lines, 'image prune -f --filter label=org.opencontainers.image.source=https://github.com/encondata/BaseCampV3')
        $iKeep | Should -BeGreaterOrEqual 0
        $iUp | Should -BeGreaterThan $iKeep
        $iPrune | Should -BeGreaterThan $iUp
        [IO.File]::ReadAllText((Join-Path $script:dir 'update-state.json')) | Should -BeLike '*sha256:old*'
        Get-UpdateLogText | Should -BeLike '*updated*'
    }
    It 'uses the image from the compose file' {
        [IO.File]::WriteAllText((Join-Path $script:dir 'docker-compose.yml'), "services:`n  edge:`n    image: local/kiosk:test`n")
        Invoke-KioskUpdate | Out-Null
        Get-DockerCallLine | Should -Contain 'image inspect --format {{.Id}} local/kiosk:test'
    }
    It 'takes the channel from config.env when there is no compose file' {
        [IO.File]::WriteAllText((Join-Path $script:dir 'config.env'), "KIOSK_CHANNEL=edge`n")
        Invoke-KioskUpdate | Out-Null
        ((Get-DockerCallLine) -join "`n") | Should -BeLike '*ghcr.io/encondata/serversherpa-kiosk-laptop:edge*'
    }
    It 'runs when the status call fails (a dead kiosk must be repairable)' {
        Mock Get-EdgeStatusJson { throw 'connection refused' }
        Invoke-KioskUpdate | Should -Be 0
        @(Get-DockerCallLine) -like '*pull' | Should -Not -BeNullOrEmpty
    }
    It 'exits 2 when the pull fails, without starting anything' {
        $script:dk.Fail = @('compose * pull')
        Invoke-KioskUpdate | Should -Be 2
        @(Get-DockerCallLine) -like '* up *' | Should -BeNullOrEmpty
    }
    It 'reads the outbox: queued or sending is busy; zero, bad JSON or no answer is idle' {
        Mock Get-EdgeStatusJson { '{"outbox":{"queued":0,"sending":3}}' }
        Test-Uploading | Should -BeTrue
        Mock Get-EdgeStatusJson { '{"outbox":{"queued":1,"sending":0}}' }
        Test-Uploading | Should -BeTrue
        Mock Get-EdgeStatusJson { '{"outbox": {"queued": 0, "sending": 0}}' }
        Test-Uploading | Should -BeFalse
        Mock Get-EdgeStatusJson { 'not json' }
        Test-Uploading | Should -BeFalse
        Mock Get-EdgeStatusJson { '{}' }
        Test-Uploading | Should -BeFalse
        Mock Get-EdgeStatusJson { throw 'refused' }
        Test-Uploading | Should -BeFalse
    }
    It 'logs to a temp file when update.log in the install folder is not writable' {
        New-Item -ItemType Directory (Join-Path $script:dir 'update.log') | Out-Null   # can't be opened as a file
        $fallback = Join-Path $script:dir 'fallback.log'
        Mock Get-FallbackLogPath { $fallback }
        Invoke-KioskUpdate | Should -Be 0
        [IO.File]::ReadAllText($fallback) | Should -BeLike '*updated*'
    }

    # -- fix round 1: interrupted updates, rejected images -----------------
    It 'recovers from an interrupted update: rolls back without pulling, rejects the bad image' {
        Write-StateFixture @{ previous_image = 'sha256:old'; phase = 'updating' }
        $script:dk.Running = 'sha256:new'; $script:dk.Pulled = 'sha256:new'; $script:dk.Health = 'unhealthy'
        Invoke-KioskUpdate -HealthTimeoutSeconds 0 | Should -Be 1
        Get-DockerCallLine | Should -Contain "tag sha256:old $script:Stable"
        @(Get-DockerCallLine) -like '*pull*' | Should -BeNullOrEmpty
        Get-UpdateLogText | Should -BeLike '*recovered from an interrupted update*'
        $st = Get-UpdateStateFile
        $st.rejected_image | Should -Be 'sha256:new'
        $st.phase | Should -Be 'done'
    }
    It 'does not roll back an interrupted update that came up healthy' {
        Write-StateFixture @{ previous_image = 'sha256:old'; phase = 'updating' }
        $script:dk.Running = 'sha256:new'; $script:dk.Pulled = 'sha256:new'
        Invoke-KioskUpdate -HealthTimeoutSeconds 0 | Should -Be 0
        @(Get-DockerCallLine) -like 'tag sha256:old*' | Should -BeNullOrEmpty
        (Get-UpdateStateFile).phase | Should -Be 'done'
    }
    It 'never rolls back a finished update that later turned unhealthy' {
        Write-StateFixture @{ previous_image = 'sha256:old'; phase = 'done' }
        $script:dk.Running = 'sha256:new'; $script:dk.Pulled = 'sha256:new'; $script:dk.Health = 'unhealthy'
        Invoke-KioskUpdate -HealthTimeoutSeconds 0 | Out-Null
        Get-UpdateLogText | Should -Not -BeLike '*recovered*'
        @(Get-DockerCallLine) -like 'tag sha256:old*' | Should -BeNullOrEmpty
    }
    It 'records the image a rollback rejected' {
        $script:dk.Health = 'unhealthy'
        Invoke-KioskUpdate -HealthTimeoutSeconds 0 | Out-Null
        (Get-UpdateStateFile).rejected_image | Should -Be 'sha256:new'
    }
    It 'skips an image that failed before and points the channel tag back at the running image' {
        Write-StateFixture @{ previous_image = 'sha256:old'; rejected_image = 'sha256:bad' }
        $script:dk.Pulled = 'sha256:bad'
        Invoke-KioskUpdate | Should -Be 0
        Get-UpdateLogText | Should -BeLike "*skipping sha256:bad $([char]0x2014) it failed its health check before*"
        Get-DockerCallLine | Should -Contain "tag sha256:old $script:Stable"
        @(Get-DockerCallLine) -like '* up *' | Should -BeNullOrEmpty
        (Get-UpdateStateFile).rejected_image | Should -Be 'sha256:bad'
    }
    It 'forgets the rejected image when a newer one arrives' {
        Write-StateFixture @{ previous_image = 'sha256:older'; rejected_image = 'sha256:bad' }
        $script:dk.Pulled = 'sha256:newer'
        Invoke-KioskUpdate | Should -Be 0
        $st = Get-UpdateStateFile
        $st.rejected_image | Should -Be ''
        $st.previous_image | Should -Be 'sha256:old'
    }

    # -- fix round 2 --------------------------------------------------------
    It 'a failed rollback exits 2 and keeps phase=updating, so the next run tries again' {
        $script:dk.Health = 'unhealthy'
        $script:dk.Fail = @('tag *')
        Invoke-KioskUpdate -HealthTimeoutSeconds 0 | Should -Be 2
        $st = Get-UpdateStateFile
        $st.phase | Should -Be 'updating'
        $st.previous_image | Should -Be 'sha256:old'
        Get-UpdateLogText | Should -BeLike '*failed*'
        # docker's own reason is in the log, not just "failed"
        Get-UpdateLogText | Should -BeLike "*docker tag sha256:old $script:Stable failed (exit 1)*"
    }
    It 'a failed recovery exits 2 and keeps phase=updating' {
        Write-StateFixture @{ previous_image = 'sha256:old'; phase = 'updating' }
        $script:dk.Running = 'sha256:new'; $script:dk.Health = 'unhealthy'
        $script:dk.Fail = @('tag *')
        Invoke-KioskUpdate -HealthTimeoutSeconds 0 | Should -Be 2
        (Get-UpdateStateFile).phase | Should -Be 'updating'
    }
    It 'with Docker down, an unfinished update is left alone (exit 2, state untouched, no tag or pull)' {
        Write-StateFixture @{ previous_image = 'sha256:old'; phase = 'updating' }
        $before = [IO.File]::ReadAllText((Join-Path $script:dir 'update-state.json'))
        $script:dk.Fail = @('*')
        Invoke-KioskUpdate -HealthTimeoutSeconds 0 | Should -Be 2
        [IO.File]::ReadAllText((Join-Path $script:dir 'update-state.json')) | Should -Be $before
        @(Get-DockerCallLine) -like 'tag*' | Should -BeNullOrEmpty
        @(Get-DockerCallLine) -like '*pull*' | Should -BeNullOrEmpty
    }
    It 'marks an interrupted update done when the previous image is the one running' {
        Write-StateFixture @{ previous_image = 'sha256:old'; phase = 'updating' }
        $script:dk.Pulled = 'sha256:old'
        Invoke-KioskUpdate | Should -Be 0
        (Get-UpdateStateFile).phase | Should -Be 'done'
    }
    It 'a rejected image with no container still starts the kiosk' {
        Write-StateFixture @{ rejected_image = 'sha256:bad' }
        $script:dk.Running = ''; $script:dk.Pulled = 'sha256:bad'
        Invoke-KioskUpdate | Should -Be 0
        Test-UpAfter -Index 0 | Should -BeTrue
        Get-UpdateLogText | Should -BeLike '*starting it anyway*'
    }
    It 'a rejected image with no container prefers the kept :previous image' {
        Write-StateFixture @{ rejected_image = 'sha256:bad' }
        $script:dk.Fail = @('inspect --format {{.Image}} *')
        $script:dk.Pulled = 'sha256:bad'; $script:dk.PreviousTag = 'sha256:prev'
        Invoke-KioskUpdate | Should -Be 0
        $iTag = [array]::IndexOf(@(Get-DockerCallLine), "tag sha256:prev $script:Stable")
        $iTag | Should -BeGreaterOrEqual 0
        Test-UpAfter -Index $iTag | Should -BeTrue
        Get-UpdateLogText | Should -BeLike '*sha256:prev*'
    }

    # -- Windows specifics ------------------------------------------------------
    It 'keeps going when update-state.json cannot be written' {
        New-Item -ItemType Directory (Join-Path $script:dir 'update-state.json') | Out-Null
        Invoke-KioskUpdate | Should -Be 0
        Get-UpdateLogText | Should -BeLike "*Couldn't write*update-state.json*"
    }
    It 'writes update-state.json in place (the installer gave the user write access to that file only)' {
        $p = Join-Path $script:dir 'update-state.json'
        [IO.File]::WriteAllText($p, '')
        $created = (Get-Item $p).CreationTimeUtc
        [Threading.Thread]::Sleep(20)   # a renamed-in file would get a later creation time
        Invoke-KioskUpdate | Should -Be 0
        (Get-Item $p).CreationTimeUtc | Should -Be $created
        (Get-UpdateStateFile).phase | Should -Be 'done'
    }
    It 'reads an empty state file (made by the installer) as no state' {
        [IO.File]::WriteAllText((Join-Path $script:dir 'update-state.json'), '')
        Invoke-KioskUpdate | Should -Be 0
        (Get-UpdateStateFile).previous_image | Should -Be 'sha256:old'
    }
    It 'returns 2 and logs when something unexpected throws' {
        Mock Read-UpdateState { throw 'boom' }
        Invoke-KioskUpdate | Should -Be 2
        Get-UpdateLogText | Should -BeLike '*boom*'
    }
    It 'Get-CurrentImageId and Get-PulledImageId go through Invoke-Docker and are empty on failure' {
        Get-CurrentImageId | Should -Be 'sha256:old'
        Get-PulledImageId -Ref 'x/y:z' | Should -Be 'sha256:new'
        $script:dk.Fail = @('*')
        Get-CurrentImageId | Should -Be ''
        Get-PulledImageId -Ref 'x/y:z' | Should -Be ''
    }
    It 'Invoke-Rollback without an image keeps phase=updating and exits 2' {
        Write-StateFixture @{ previous_image = ''; phase = 'updating' }
        Read-UpdateState
        Invoke-Rollback -ImageId '' | Should -Be 2
        (Get-UpdateStateFile).phase | Should -Be 'updating'
    }
}

Describe 'launch.ps1' {
    BeforeEach {
        $script:dir = Join-Path $TestDrive ([guid]::NewGuid().ToString())
        New-Item -ItemType Directory $script:dir | Out-Null
        $env:KIOSK_DIR = $script:dir
        [IO.File]::WriteAllText((Join-Path $script:dir 'config.env'), "KIOSK_CHANNEL=stable`nKIOSK_BROWSER=C:\Program Files\Google\Chrome\Application\chrome.exe`n")
        Mock Start-Sleep {}
        Mock Start-Process {}
    }
    AfterEach { $env:KIOSK_DIR = $null }
    It 'waits for /edge/identity, then opens the browser from config.env in app mode' {
        $script:tries = 0
        Mock Test-KioskResponding { $script:tries++; $script:tries -ge 3 }
        Invoke-KioskLaunch
        $script:tries | Should -Be 3
        Should -Invoke Start-Process -Times 1 -Exactly -ParameterFilter {
            $FilePath -eq 'C:\Program Files\Google\Chrome\Application\chrome.exe' -and "$ArgumentList" -eq '--app=http://localhost:8090'
        }
    }
    It 'waits at most the timeout, then opens anyway' {
        Mock Test-KioskResponding { $false }
        $env:KIOSK_LAUNCH_TIMEOUT_S = '0'
        try { Invoke-KioskLaunch } finally { $env:KIOSK_LAUNCH_TIMEOUT_S = $null }
        Should -Invoke Start-Process -Times 1 -Exactly
    }
    It 'waits 300 seconds by default and polls /edge/identity on 127.0.0.1:8090 (the app URL stays localhost)' {
        Get-LaunchTimeout | Should -Be 300
        $KioskIdentityUrl | Should -Be 'http://127.0.0.1:8090/edge/identity'
        $KioskUrl | Should -Be 'http://localhost:8090'
    }
    It 'opens the default browser when none is configured' {
        [IO.File]::WriteAllText((Join-Path $script:dir 'config.env'), "KIOSK_BROWSER=`n")
        Mock Test-KioskResponding { $true }
        Invoke-KioskLaunch
        Should -Invoke Start-Process -Times 1 -Exactly -ParameterFilter { $FilePath -eq 'http://localhost:8090' }
    }
    It 'falls back to the default browser when the configured one fails to start' {
        Mock Test-KioskResponding { $true }
        Mock Start-Process { throw 'not found' } -ParameterFilter { $FilePath -like '*chrome.exe' }
        Invoke-KioskLaunch
        Should -Invoke Start-Process -Times 1 -Exactly -ParameterFilter { $FilePath -eq 'http://localhost:8090' }
    }
    It 'reads KIOSK_BROWSER without running config.env' {
        Get-KioskBrowser | Should -Be 'C:\Program Files\Google\Chrome\Application\chrome.exe'
    }
}

Describe 'Script hygiene' {
    It '<_> is plain ASCII, so Windows PowerShell 5.1 reads it correctly without a byte-order mark' -ForEach @('update.ps1', 'launch.ps1') {
        $bytes = [System.IO.File]::ReadAllBytes((Join-Path $PSScriptRoot "../$_"))
        ($bytes | Where-Object { $_ -gt 127 }).Count | Should -Be 0
    }
}
