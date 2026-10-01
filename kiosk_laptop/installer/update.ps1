<#
.SYNOPSIS
ServerSherpa kiosk nightly updater (laptop edition), Windows.

.DESCRIPTION
Installed by install.ps1 next to docker-compose.yml and run at 03:00 local by
the scheduled task "ServerSherpa Kiosk Update", as the signed-in user (Docker
Desktop only runs while someone is signed in). The Windows port of update.sh:
the same steps, exit codes and log.

Each run: finish off an update a crash or reboot interrupted; skip while
scans are uploading; pull the channel image; if it changed (and isn't one
that already failed), restart on it and wait for healthy; if it doesn't get
healthy, put the previous image back and remember the bad one.
Logged to update.log (last 1 MB kept).

Exit codes: 0 updated, unchanged or skipped; 1 rolled back; 2 other failure.

Testing hooks: -LibraryOnly or KIOSK_UPDATE_LIB=1 defines the functions
without running. Written for Windows PowerShell 5.1 and kept plain ASCII.

.PARAMETER HealthTimeoutSeconds
How long the new image gets to turn healthy (default 120).
.PARAMETER HealthPollSeconds
How often health is checked (default 5).
.PARAMETER LibraryOnly
Define the functions and return without running (for Pester).
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseShouldProcessForStateChangingFunctions', '', Justification = 'Unattended updater steps, not reusable cmdlets.')]
[CmdletBinding()]
param(
    [int]$HealthTimeoutSeconds = 120,
    [int]$HealthPollSeconds = 5,
    [switch]$LibraryOnly
)

# -- Constants --------------------------------------------------------------
$UpdateScriptDir = $PSScriptRoot
$KioskContainer = 'serversherpa-kiosk-edge-1'     # project "serversherpa-kiosk", service "edge"
$PreviousTag = 'serversherpa-kiosk-laptop:previous'
$StatusUrl = 'http://127.0.0.1:8090/edge/status'
$LogMaxBytes = 1048576
$ImageSourceLabel = 'org.opencontainers.image.source=https://github.com/encondata/BaseCampV3'
$DockerBinDir = "$env:ProgramFiles\Docker\Docker\resources\bin"
$Dash = [string][char]0x2014                       # an em dash, kept out of the source as plain ASCII

# One run's state (a hashtable, so every function shares and changes the same one).
#   PrevImage  running before this update      NewImage  pulled by this update
#   Previous   the image to go back to          Rejected  failed its health check; not tried again
#   Phase      updating while an update is under way, else done
$Upd = @{}

# Reset-UpdateContext: paths and empty state for a run.
function Reset-UpdateContext {
    param([int]$HealthTimeoutSeconds = 120, [int]$HealthPollSeconds = 5)
    $dir = $env:KIOSK_DIR
    if (-not $dir) { $dir = $UpdateScriptDir }
    $Upd.Dir = $dir
    $Upd.Log = Join-KioskPath $dir 'update.log'
    $Upd.StatePath = Join-KioskPath $dir 'update-state.json'
    $Upd.HealthTimeout = $HealthTimeoutSeconds
    $Upd.HealthPoll = $HealthPollSeconds
    $Upd.PrevImage = ''
    $Upd.NewImage = ''
    $Upd.Previous = ''
    $Upd.Rejected = ''
    $Upd.Phase = ''
}

# Join-KioskPath PATH CHILD: like Join-Path, without checking that the drive exists.
function Join-KioskPath {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$ChildPath)
    [IO.Path]::Combine($Path, $ChildPath)
}

# -- Log ----------------------------------------------------------------------
$Utf8 = New-Object Text.UTF8Encoding $false

function Write-UpdateLog {
    param([AllowEmptyString()][string]$Message)
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message`r`n"
    try { [IO.File]::AppendAllText($Upd.Log, $line, $Utf8) } catch { Write-Verbose $line }
}

# Add-LogOutput LINES: a command's own output, as is.
function Add-LogOutput {
    param([AllowEmptyCollection()][string[]]$Lines)
    if (-not $Lines) { return }
    try { [IO.File]::AppendAllText($Upd.Log, (($Lines -join "`r`n") + "`r`n"), $Utf8) } catch { Write-Verbose ($Lines -join "`n") }
}

function Get-FallbackLogPath { Join-KioskPath ([IO.Path]::GetTempPath()) 'serversherpa-kiosk-update.log' }

# Test-LogWritable PATH: can we append to it (creating it if it's missing)?
function Test-LogWritable {
    param([Parameter(Mandatory = $true)][string]$Path)
    try {
        $fs = New-Object IO.FileStream $Path, ([IO.FileMode]::Append), ([IO.FileAccess]::Write), ([IO.FileShare]::ReadWrite)
        $fs.Dispose()
        return $true
    } catch { return $false }
}

# Limit-Log PATH: keep the last 1 MB, rewriting the file in place (so the
# write permission the installer gave the user on this one file stays).
function Limit-Log {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    try {
        $fs = New-Object IO.FileStream $Path, ([IO.FileMode]::Open), ([IO.FileAccess]::ReadWrite), ([IO.FileShare]::Read)
        try {
            if ($fs.Length -le $LogMaxBytes) { return }
            $buf = New-Object byte[] $LogMaxBytes
            [void]$fs.Seek(-$LogMaxBytes, [IO.SeekOrigin]::End)
            $read = 0
            while ($read -lt $LogMaxBytes) {
                $n = $fs.Read($buf, $read, $LogMaxBytes - $read)
                if ($n -le 0) { break }
                $read += $n
            }
            [void]$fs.Seek(0, [IO.SeekOrigin]::Begin)
            $fs.Write($buf, 0, $read)
            $fs.SetLength($read)
        } finally { $fs.Dispose() }
    } catch { Write-Verbose "Couldn't trim $Path." }
}

# -- Docker -------------------------------------------------------------------
# Invoke-Docker -Arguments ARGS: every docker call goes through here (Pester
# mocks it). Returns stdout; throws when docker fails. -Log appends all of
# docker's output (pull progress included) to update.log.
function Invoke-Docker {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string[]]$Arguments, [switch]$Log)
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'The docker command was not found.' }
    $eap = $ErrorActionPreference
    # Windows PowerShell 5.1 turns native stderr lines into errors under Stop.
    $ErrorActionPreference = 'Continue'
    try {
        $all = @(& docker @Arguments 2>&1)
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $eap
    }
    $out = @($all | Where-Object { $_ -isnot [Management.Automation.ErrorRecord] } | ForEach-Object { "$_" })
    $err = @($all | Where-Object { $_ -is [Management.Automation.ErrorRecord] } | ForEach-Object { "$_" })
    if ($Log) { Add-LogOutput -Lines (@($all | ForEach-Object { "$_" })) }
    if ($code -ne 0) { throw "docker $($Arguments -join ' ') failed (exit $code). $($err -join ' ')" }
    $out
}

# Invoke-Compose ARGS: docker compose on the installed compose file.
function Invoke-Compose {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    Invoke-Docker -Arguments (@('compose', '-f', (Join-KioskPath $Upd.Dir 'docker-compose.yml')) + $Arguments) -Log
}

# Test-DockerCall ARGS: $true when the docker call worked (output dropped).
function Test-DockerCall {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    try { Invoke-Docker -Arguments $Arguments | Out-Null; return $true } catch { return $false }
}

# Get-DockerValue ARGS: trimmed stdout, '' when docker fails.
function Get-DockerValue {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    try { return ((@(Invoke-Docker -Arguments $Arguments) -join '').Trim()) } catch { return '' }
}

# Task Scheduler starts the job with the user's PATH, which may predate Docker Desktop.
function Add-DockerToPath {
    if ($DockerBinDir -and (Test-Path -LiteralPath $DockerBinDir) -and -not (($env:Path -split ';') -contains $DockerBinDir)) {
        $env:Path = "$env:Path;$DockerBinDir"
    }
}

# Get-UpdateImageRef: the image the compose file runs, else the channel's tag.
function Get-UpdateImageRef {
    $compose = Join-KioskPath $Upd.Dir 'docker-compose.yml'
    if (Test-Path -LiteralPath $compose -PathType Leaf) {
        foreach ($line in [IO.File]::ReadAllLines($compose)) {
            if ($line -match '^\s*image:(.*)$') {
                $v = $Matches[1].Trim()
                if ($v) { return $v }
                break
            }
        }
    }
    $channel = ''
    $config = Join-KioskPath $Upd.Dir 'config.env'
    if (Test-Path -LiteralPath $config -PathType Leaf) {
        foreach ($line in [IO.File]::ReadAllLines($config)) {
            if ($line -match '^KIOSK_CHANNEL=(.*)$') { $channel = $Matches[1].Trim(); break }
        }
    }
    if (-not $channel) { $channel = 'stable' }
    "ghcr.io/encondata/serversherpa-kiosk-laptop:$channel"
}

function Get-CurrentImageId { Get-DockerValue -Arguments @('inspect', '--format', '{{.Image}}', $KioskContainer) }

function Get-PulledImageId {
    param([Parameter(Mandatory = $true)][string]$Ref)
    Get-DockerValue -Arguments @('image', 'inspect', '--format', '{{.Id}}', $Ref)
}

function Get-KioskHealth { Get-DockerValue -Arguments @('inspect', '--format', '{{.State.Health.Status}}', $KioskContainer) }

function Test-DockerUp { Test-DockerCall -Arguments @('info') }

# -- Outbox -------------------------------------------------------------------
function Get-EdgeStatusJson {
    $r = Invoke-WebRequest -Uri $StatusUrl -UseBasicParsing -TimeoutSec 10
    $c = $r.Content
    if ($c -is [byte[]]) { $c = [Text.Encoding]::UTF8.GetString($c) }
    [string]$c
}

# Test-Uploading: $true when scans are queued or being sent. When the status
# call or its JSON fails, the kiosk counts as idle, so a dead kiosk can be repaired.
function Test-Uploading {
    try {
        $o = (Get-EdgeStatusJson) | ConvertFrom-Json
        if (-not $o -or -not $o.outbox) { return $false }
        $q = 0; $s = 0
        if ($o.outbox.queued) { $q = [int]$o.outbox.queued }
        if ($o.outbox.sending) { $s = [int]$o.outbox.sending }
        return ($q + $s) -gt 0
    } catch { return $false }
}

# -- State (update-state.json) ----------------------------------------------------
function Read-UpdateState {
    $Upd.Previous = ''; $Upd.Rejected = ''; $Upd.Phase = ''
    if (-not (Test-Path -LiteralPath $Upd.StatePath -PathType Leaf)) { return }
    try {
        $raw = [IO.File]::ReadAllText($Upd.StatePath)
        if (-not $raw.Trim()) { return }
        $o = $raw | ConvertFrom-Json
        if ($o.previous_image) { $Upd.Previous = [string]$o.previous_image }
        if ($o.rejected_image) { $Upd.Rejected = [string]$o.rejected_image }
        if ($o.phase) { $Upd.Phase = [string]$o.phase }
    } catch { Write-UpdateLog "Couldn't read $($Upd.StatePath); starting from no state." }
}

# Write-UpdateState: written in place (not renamed), so the write permission
# the installer gave the signed-in user on this one file stays.
function Write-UpdateState {
    $state = [ordered]@{
        previous_image = $Upd.Previous
        image          = (Get-UpdateImageRef)
        rejected_image = $Upd.Rejected
        phase          = $Upd.Phase
        updated_at     = (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz')
    }
    try {
        [IO.File]::WriteAllText($Upd.StatePath, (($state | ConvertTo-Json -Compress) + "`n"), $Utf8)
    } catch {
        Write-UpdateLog "Couldn't write $($Upd.StatePath) (continuing)."
    }
}

# -- Update steps -------------------------------------------------------------------
# Wait-KioskHealthy: checked at least once, then every HealthPoll seconds until the timeout.
function Wait-KioskHealthy {
    $deadline = (Get-Date).AddSeconds($Upd.HealthTimeout)
    while ($true) {
        $status = Get-KioskHealth
        if ($status -eq 'healthy') { return $true }
        if ((Get-Date) -ge $deadline) {
            $shown = $status
            if (-not $shown) { $shown = 'unknown' }
            Write-UpdateLog "Not healthy in time (status: $shown)."
            return $false
        }
        Start-Sleep -Seconds $Upd.HealthPoll
    }
}

# Start-WithoutContainer REF: no kiosk container is running and the channel
# image is the rejected one. Start the kept :previous image if there is one,
# else the rejected image anyway: a kiosk that might work beats no kiosk.
# $true when it started.
function Start-WithoutContainer {
    param([Parameter(Mandatory = $true)][string]$Ref)
    $prev = Get-PulledImageId -Ref $PreviousTag
    if ($prev -and $prev -ne $Upd.NewImage -and (Test-DockerCall -Arguments @('tag', $prev, $Ref))) {
        Write-UpdateLog "No kiosk container is running; starting the kept previous image $prev."
    } else {
        Write-UpdateLog "No kiosk container is running and no earlier image is kept; starting it anyway ($($Upd.NewImage))."
    }
    try { Invoke-Compose -Arguments @('up', '-d') | Out-Null; return $true }
    catch { Write-UpdateLog "The kiosk didn't start."; return $false }
}

# Invoke-Pull: 0 when the pulled channel image differs from the running one,
# 1 when it is the same or was rejected before, 2 when the pull fails.
# Sets PrevImage and NewImage.
function Invoke-Pull {
    $ref = Get-UpdateImageRef
    $Upd.PrevImage = Get-CurrentImageId
    $running = $Upd.PrevImage
    if (-not $running) { $running = 'nothing' }
    Write-UpdateLog "Pulling $ref (running $running)"
    try { Invoke-Compose -Arguments @('pull') | Out-Null }
    catch {
        Write-UpdateLog "Couldn't pull $ref; the kiosk keeps running the current image."
        return 2
    }
    $Upd.NewImage = Get-PulledImageId -Ref $ref
    if ($Upd.NewImage -and $Upd.NewImage -eq $Upd.PrevImage) {
        Write-UpdateLog "Already up to date ($($Upd.NewImage))."
        return 1
    }
    if ($Upd.NewImage -and $Upd.NewImage -eq $Upd.Rejected) {
        Write-UpdateLog "skipping $($Upd.NewImage) $Dash it failed its health check before"
        # Point the channel tag back at the running image, so nothing (compose
        # included) recreates the container on the rejected one.
        if ($Upd.PrevImage) {
            if (-not (Test-DockerCall -Arguments @('tag', $Upd.PrevImage, $ref))) { Write-UpdateLog "Couldn't re-tag $ref to $($Upd.PrevImage)." }
            return 1
        }
        if (-not (Start-WithoutContainer -Ref $ref)) { return 2 }
        return 1
    }
    0
}

# Invoke-Rollback IMAGEID: point the channel tag back at IMAGEID and restart.
# The caller sets Rejected to the image that failed. Only a rollback that
# worked ends the update (1); after a failure (2) the phase stays "updating",
# so the next run tries again.
function Invoke-Rollback {
    param([AllowEmptyString()][string]$ImageId)
    $ref = Get-UpdateImageRef
    $rc = 2
    if (-not $ImageId) {
        Write-UpdateLog 'No previous image to roll back to.'
    } else {
        $ok = Test-DockerCall -Arguments @('tag', $ImageId, $ref)
        if ($ok) {
            try { Invoke-Compose -Arguments @('up', '-d') | Out-Null } catch { $ok = $false }
        }
        if ($ok) {
            Write-UpdateLog "rolled back to $ImageId"
            $rc = 1
            $Upd.Phase = 'done'
        } else {
            Write-UpdateLog "Rollback to $ImageId failed; the next run tries again."
        }
    }
    Write-UpdateState
    $rc
}

# Invoke-InterruptedRecovery: an update that never finished (crash, reboot,
# power loss) left a container that isn't healthy: go back to the previous
# image. 0 = nothing to recover (or it came up after all); else the rollback's code.
function Invoke-InterruptedRecovery {
    if ($Upd.Phase -ne 'updating' -or -not $Upd.Previous) { return 0 }
    # Docker being down is not a missing container: leave everything for later.
    if (-not (Test-DockerUp)) {
        Write-UpdateLog "Docker isn't answering; an unfinished update is left for the next run."
        return 2
    }
    $cur = Get-CurrentImageId
    if ($cur -eq $Upd.Previous) {
        # Interrupted before the new image replaced the old one (or after a
        # rollback that worked): the previous image is running, so it's over.
        $Upd.Phase = 'done'
        Write-UpdateState
        return 0
    }
    if (Wait-KioskHealthy) {
        $Upd.Phase = 'done'
        Write-UpdateState
        return 0
    }
    Write-UpdateLog "The last update didn't finish and the kiosk isn't healthy."
    $Upd.Rejected = $cur
    $rc = Invoke-Rollback -ImageId $Upd.Previous
    if ($rc -eq 1) { Write-UpdateLog 'recovered from an interrupted update' }
    $rc
}

function Invoke-ApplyUpdate {
    $Upd.Previous = $Upd.PrevImage
    $Upd.Rejected = ''   # a different, newer image: forget the rejected one
    $Upd.Phase = 'updating'
    Write-UpdateState
    # Keep a tag on the previous image, so the prune below can't remove it.
    if ($Upd.PrevImage) {
        if (-not (Test-DockerCall -Arguments @('tag', $Upd.PrevImage, $PreviousTag))) { Write-UpdateLog "Couldn't tag the previous image (continuing)." }
    }
    Write-UpdateLog 'Starting the new image'
    $started = $true
    try { Invoke-Compose -Arguments @('up', '-d') | Out-Null } catch { $started = $false }
    if (-not $started) {
        Write-UpdateLog "The new image didn't start."
        $Upd.Rejected = $Upd.NewImage
        return (Invoke-Rollback -ImageId $Upd.PrevImage)
    }
    if (-not (Wait-KioskHealthy)) {
        $Upd.Rejected = $Upd.NewImage
        return (Invoke-Rollback -ImageId $Upd.PrevImage)
    }
    $Upd.Phase = 'done'
    Write-UpdateState
    $now = Get-CurrentImageId
    if (-not $now) { $now = 'unknown' }
    Write-UpdateLog "updated to $now"
    # Only the kiosk's own untagged images; :previous is tagged, so it stays.
    if (-not (Test-DockerCall -Arguments @('image', 'prune', '-f', '--filter', "label=$ImageSourceLabel"))) {
        Write-UpdateLog "Couldn't prune old images (continuing)."
    }
    0
}

function Invoke-UpdateRun {
    Write-UpdateLog '---- update.ps1 ----'
    Read-UpdateState
    $rc = Invoke-InterruptedRecovery
    if ($rc -ne 0) { return $rc }
    if (Test-Uploading) {
        Write-UpdateLog "Scans are uploading $Dash skipped; trying again tomorrow night."
        return 0
    }
    $rc = Invoke-Pull
    switch ($rc) {
        0 { return (Invoke-ApplyUpdate) }
        1 { return 0 }
        default { return 2 }
    }
}

# Invoke-KioskUpdate: one run; returns the exit code. Mirrors update.sh's main.
function Invoke-KioskUpdate {
    param([int]$HealthTimeoutSeconds = 120, [int]$HealthPollSeconds = 5)
    $ProgressPreference = 'SilentlyContinue'
    Reset-UpdateContext -HealthTimeoutSeconds $HealthTimeoutSeconds -HealthPollSeconds $HealthPollSeconds
    # The install folder only lets users read; the installer makes update.log
    # writable for the signed-in user. If it isn't, log to a temp file instead of failing.
    if (-not (Test-LogWritable -Path $Upd.Log)) { $Upd.Log = Get-FallbackLogPath }
    Limit-Log -Path $Upd.Log
    Add-DockerToPath
    try {
        return [int](Invoke-UpdateRun)
    } catch {
        Write-UpdateLog "Error: $($_.Exception.Message)"
        return 2
    }
}

# Run only as the last statement, so a partly downloaded script runs nothing.
if ($LibraryOnly -or $env:KIOSK_UPDATE_LIB -eq '1') { return }
exit (Invoke-KioskUpdate -HealthTimeoutSeconds $HealthTimeoutSeconds -HealthPollSeconds $HealthPollSeconds)
