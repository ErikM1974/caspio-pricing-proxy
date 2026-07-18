# sync-thumbnails-to-box.ps1 — ShopWorks thumbnail IMAGES -> proxy -> Box.com.
#
# Runs ON BANDIT (Task Scheduler, every 15-30 min). Reads the FileMaker external
# container store (\\NCA-FS01\Thumbnails, READ-ONLY, ~28k {ID_Serial}_*.jpg/png),
# and POSTs each NEW / size-changed image to the proxy at
#   POST /api/thumbnails/upload-with-stub?target=box
# which stores the bytes in Box (BOX_THUMBNAIL_ARCHIVE_FOLDER_ID) and points the
# Shopworks_Thumbnail_Report row's FileUrl at /api/box/thumbnail/{id} (ExternalKey='').
# Result: thumbnail images live on Box, referenced from Caspio — serving costs ZERO
# Caspio API/storage budget.
#
# This REPLACES the old desktop image sync (dist\sync_thumbnails.py, which uploaded
# to Caspio Files with a hardcoded Gmail password). Do NOT run both at once — they
# would upload the same images to two different backends.
#
# INCREMENTAL + RESUMABLE (no local snapshot needed — server is the source of truth):
#  - GET /api/thumbnails/uploaded-ids returns every row that already has an image on
#    ANY backend (Caspio OR Box), with its size. We skip those, and re-upload only when
#    the on-disk size differs. So already-on-Caspio images are left alone (the separate
#    archive-to-box sweep migrates those); this task only fills images that have NO
#    backend copy yet -> Box.
#  - MAX_FILES_PER_RUN caps each run; the schedule drains a big backlog over many runs.
#  - A 404 (RECORD_NOT_FOUND) just means the metadata sync hasn't created that row yet;
#    it is counted as "skipped" and retried automatically on a later run.
#
# AUTH: the file share needs a Windows identity — run this task as a DOMAIN USER with
# read on \\NCA-FS01\Thumbnails (NOT SYSTEM; a service account with a non-expiring
# password is best). Reuses C:\NWCA\odbc-sync\config.json (ProxyBase + CrmApiSecret).
#
# Master copy: caspio-pricing-proxy/scripts/bandit-agent/ — edit HERE, recopy to bandit.

param(
    [string]$ThumbShare     = '\\NCA-FS01\Thumbnails',
    [int]   $MaxFilesPerRun = 200,
    [int]   $PaceMs         = 300,
    [string]$CsvOut         = ''
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Net.Http

$Root       = 'C:\NWCA\thumb-image-sync'
$ConfigPath = 'C:\NWCA\odbc-sync\config.json'
$LogPath    = Join-Path $Root 'sync-thumbnails-to-box.log'
$AllowedExt = @('.jpg', '.jpeg', '.png')
New-Item -ItemType Directory -Force -Path $Root | Out-Null

function Log($m) { $line = '{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $m; Add-Content -Path $LogPath -Value $line -Encoding UTF8; Write-Output $line }

function Get-Mime($name) {
    switch ([System.IO.Path]::GetExtension($name).ToLower()) {
        '.png'  { 'image/png' }
        default { 'image/jpeg' }
    }
}

# One reusable HttpClient for the whole run.
function Send-Image($client, $uri, $secret, $filePath, $fileName) {
    $content = New-Object System.Net.Http.MultipartFormDataContent
    try {
        $bytes = [System.IO.File]::ReadAllBytes($filePath)
        $fileContent = New-Object System.Net.Http.ByteArrayContent(, $bytes)
        $fileContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse((Get-Mime $fileName))
        $content.Add($fileContent, 'file', $fileName)

        $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, $uri)
        $req.Headers.Add('x-crm-api-secret', $secret)
        $req.Content = $content
        $resp = $client.SendAsync($req).GetAwaiter().GetResult()
        $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        return @{ status = [int]$resp.StatusCode; body = $body }
    } finally {
        $content.Dispose()
    }
}

try {
    if ((Test-Path $LogPath) -and ((Get-Item $LogPath).Length -gt 1MB)) {
        Set-Content -Path $LogPath -Value (Get-Content $LogPath -Tail 250) -Encoding UTF8
    }
    $cfg    = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $proxy  = $cfg.ProxyBase
    $secret = $cfg.CrmApiSecret
    $headers = @{ 'x-crm-api-secret' = $secret }
    $postUri = "$proxy/api/thumbnails/upload-with-stub?target=box"

    if (-not (Test-Path -LiteralPath $ThumbShare)) { Log "image share not reachable: $ThumbShare (check the task's identity has read access)"; exit 1 }

    # 1) Server truth: which rows already have an image (any backend), and its size.
    $up = Invoke-RestMethod -Method Get -Uri "$proxy/api/thumbnails/uploaded-ids" -Headers $headers -TimeoutSec 300
    $uploaded = @{}   # ID_Serial -> stored size (0 when unknown; many legacy rows have no FileSizeNumber)
    foreach ($u in $up.uploaded) {
        if ($null -eq $u.id) { continue }
        $sz = 0L; if ($null -ne $u.size) { [void][int64]::TryParse([string]$u.size, [ref]$sz) }
        $uploaded[[string]$u.id] = $sz
    }
    Log ("already have an image: {0} rows" -f $up.count)

    # 1b) Which serials have a metadata ROW at all. We must NOT POST an image for a
    # serial with no row — upload-with-stub 404s it (rows are created by the metadata
    # sync). Without this, ~15k share images with no row 404-churn every run.
    $ai = Invoke-RestMethod -Method Get -Uri "$proxy/api/thumbnails/all-ids" -Headers $headers -TimeoutSec 300
    $existing = @{}
    foreach ($id in $ai.ids) { $existing[[string]$id] = $true }
    Log ("metadata rows that exist: {0}" -f $ai.count)

    # 2) Enumerate valid image files on the share ({ID_Serial}_*.jpg/png), newest first.
    $files = Get-ChildItem -LiteralPath $ThumbShare -File -ErrorAction Stop |
             Where-Object { ($AllowedExt -contains $_.Extension.ToLower()) -and ($_.Name -match '^\d+_') } |
             Sort-Object LastWriteTime -Descending
    Log ("image files on share: {0}" -f $files.Count)

    # 3) Pending = not-yet-uploaded, or on-disk size differs from the stored size.
    $pending = New-Object System.Collections.ArrayList
    foreach ($f in $files) {
        $id = ([regex]::Match($f.Name, '^(\d+)_')).Groups[1].Value
        if ((-not $CsvOut) -and (-not $existing.ContainsKey($id))) { continue }   # API mode skips no-row files (404); CSV mode includes all (import matches by ID_Serial)
        if ($uploaded.ContainsKey($id)) {
            $storedSize = $uploaded[$id]
            # Already has an image. Only re-upload when we have a DEFINITE stored size that
            # differs from the file on disk; an unknown (0) stored size means "leave it alone"
            # (legacy rows have no FileSizeNumber — churning them would re-upload ~12k images).
            if ($storedSize -le 0 -or $storedSize -eq [int64]$f.Length) { continue }
        }
        [void]$pending.Add($f)
    }
    Log ("pending (new/changed): {0}" -f $pending.Count)

    if ($CsvOut) {
        # Upload each pending image to Box (0 Caspio calls via ?csv=1) and emit an
        # ID_Serial -> FileUrl CSV for a bulk Caspio import (Update on ID_Serial).
        # Checkpoints the CSV every 200 so a long/interrupted run isn't lost.
        $boxUri = "$proxy/api/thumbnails/upload-with-stub?target=box&csv=1"
        $client = New-Object System.Net.Http.HttpClient; $client.Timeout = [TimeSpan]::FromSeconds(120)
        $rows = New-Object System.Collections.ArrayList
        $done = @{}
        # Resume: rows already in the checkpoint CSV are done (each was uploaded to Box) — skip them.
        if (Test-Path $CsvOut) { try { Import-Csv $CsvOut | ForEach-Object { [void]$rows.Add($_); $done[[string]$_.ID_Serial] = $true } } catch {} }
        Log ("CSV mode: {0} pending, {1} already done (resuming)" -f $pending.Count, $done.Count)
        $ok = 0; $err = 0; $i = 0
        try {
            foreach ($f in $pending) {
                $sid = ([regex]::Match($f.Name, '^(\d+)_')).Groups[1].Value
                if ($done.ContainsKey($sid)) { continue }
                $i++
                try {
                    $r = Send-Image $client $boxUri $secret $f.FullName $f.Name
                    if ($r.status -ge 200 -and $r.status -lt 300) {
                        $j = $r.body | ConvertFrom-Json
                        [void]$rows.Add([pscustomobject]@{ ID_Serial = $j.thumbnailId; FileUrl = $j.fileUrl; ExternalKey = ''; FileSizeNumber = [int64]$f.Length })
                        $done[$sid] = $true
                        $ok++
                    } else { $err++; if ($err -le 5) { Log ("  {0} -> HTTP {1}: {2}" -f $f.Name, $r.status, $r.body.Substring(0, [Math]::Min(160, $r.body.Length))) } }
                } catch { $err++; if ($err -le 5) { Log ("  {0} EX: {1}" -f $f.Name, $_.Exception.Message) } }
                if ($i % 200 -eq 0) { Log ("  progress {0}/{1}: {2} ok, {3} err" -f $i, $pending.Count, $ok, $err); ($rows | Export-Csv -Path $CsvOut -NoTypeInformation -Encoding UTF8) }
                Start-Sleep -Milliseconds $PaceMs
            }
        } finally { $client.Dispose() }
        ($rows | Export-Csv -Path $CsvOut -NoTypeInformation -Encoding UTF8)
        Log ("CSV DONE: {0} uploaded to Box + in CSV, {1} errored -> {2}" -f $ok, $err, $CsvOut)
        exit 0
    }

    if ($pending.Count -eq 0) { Log 'nothing to upload'; exit 0 }

    $batch = @($pending | Select-Object -First $MaxFilesPerRun)
    Log ("processing this run: {0} of {1} (cap {2})" -f $batch.Count, $pending.Count, $MaxFilesPerRun)

    # 4) Upload loop.
    $client = New-Object System.Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromSeconds(120)
    $ok = 0; $skip = 0; $err = 0; $i = 0
    try {
        foreach ($f in $batch) {
            $i++
            $attempt = 0
            while ($true) {
                try {
                    $r = Send-Image $client $postUri $secret $f.FullName $f.Name
                    # 429 safety net (the proxy now exempts secret-holders, but back off anyway).
                    if ($r.status -eq 429 -and $attempt -lt 5) { $attempt++; Log ("  429 rate-limited - backing off 60s (attempt {0})" -f $attempt); Start-Sleep -Seconds 60; continue }
                    if ($r.status -ge 200 -and $r.status -lt 300) { $ok++ }
                    elseif ($r.status -eq 404) { $skip++ }
                    else { $err++; if ($err -le 5) { Log ("  {0} -> HTTP {1}: {2}" -f $f.Name, $r.status, $r.body.Substring(0, [Math]::Min(180, $r.body.Length))) } }
                    break
                } catch {
                    $err++
                    if ($err -le 5) { Log ("  {0} EX: {1}" -f $f.Name, $_.Exception.Message) }
                    break
                }
            }
            if ($i % 50 -eq 0) { Log ("  progress {0}/{1}: {2} ok, {3} skipped(no row), {4} err" -f $i, $batch.Count, $ok, $skip, $err) }
            Start-Sleep -Milliseconds $PaceMs
        }
    } finally {
        $client.Dispose()
    }

    $remaining = $pending.Count - $batch.Count
    Log ("DONE: {0} uploaded to Box, {1} skipped(no metadata row yet), {2} errored this run; {3} still pending" -f $ok, $skip, $err, $remaining)
    exit 0
}
catch {
    Log ('FAILED: ' + $_.Exception.Message)
    exit 1
}
