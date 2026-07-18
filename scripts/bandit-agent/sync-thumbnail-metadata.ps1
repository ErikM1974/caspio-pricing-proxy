# sync-thumbnail-metadata.ps1 — ShopWorks "Thumbnails Report" xlsx -> proxy -> Caspio.
#
# Runs ON BANDIT (Task Scheduler, every 30 min, SYSTEM). Reads the newest
# "Thumbnails Report*.xlsx" that Erik exports into C:\SWF and upserts the
# metadata into Caspio Shopworks_Thumbnail_Report via
# POST /api/thumbnails/metadata-sync.
#
# Replaces the old desktop chain (build_caspio_import_csv.py 3-way join ->
# OneDrive Thumb.csv -> Caspio Thumbnail_Import file-import). Writes ONLY the
# metadata columns; the image columns (ExternalKey/FileUrl) are owned by the
# image sync (upload-with-stub).
#
# RATE-LIMIT SAFE + RESUMABLE (Caspio 429s on big bursts, 2026-07-17):
#  - MAX_ROWS_PER_RUN caps each run; the 30-min schedule drains a big backlog
#    (e.g. the 27k first load) over several runs. Steady-state = seconds.
#  - Snapshot (ID_Serial -> content hash) saved AFTER EVERY CHUNK, so an
#    interrupted/aborted run never loses progress and never re-does confirmed rows.
#  - Errored rows are left OUT of the snapshot so they retry next run.
#  - 429 -> back off 90s and retry the chunk (3x) before yielding to next run.
#
# Master copy: caspio-pricing-proxy/scripts/bandit-agent/ — edit here, recopy to bandit.
# Deps on bandit: ImportExcel module. Reuses odbc-sync config.json (ProxyBase + CrmApiSecret).

# -CsvOut <path> : write the transformed metadata rows to a CSV for a one-time bulk
#   Caspio import (Add+Update on ID_Serial) instead of POSTing. Uses the Data
#   import/export quota, NOT the Integrations API budget — works even when capped.
param([string]$CsvOut)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Import-Module ImportExcel

$Root            = 'C:\NWCA\thumb-sync'
$ConfigPath      = 'C:\NWCA\odbc-sync\config.json'
$SwfFolder       = 'C:\SWF'
$SnapshotPath    = Join-Path $Root 'last-snapshot.json'
$LogPath         = Join-Path $Root 'sync-thumbnail-metadata.log'
$ChunkSize       = 50
$MaxRowsPerRun   = 3000     # bound each run; big backlogs drain across scheduled runs
New-Item -ItemType Directory -Force -Path $Root | Out-Null

function Log($m){ $line = '{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $m; Add-Content -Path $LogPath -Value $line -Encoding UTF8; Write-Output $line }

function Convert-Row($r){
    $tsStr = $null; $d = 0.0
    if ($null -ne $r.timestamp_Added -and [double]::TryParse([string]$r.timestamp_Added, [ref]$d)) {
        $tsStr = ([DateTime]::FromOADate($d)).ToString('MM/dd/yyyy hh:mm:ss tt')
    }
    [ordered]@{
        ID_Serial                  = $r.ID_Serial
        FileName                   = $r.FileName
        FileWidth                  = $r.FileWidth
        FileHeight                 = $r.FileHeight
        FileSizeDisplay            = $r.FileSizeDisplay
        timestamp_Added            = $tsStr
        Thumb_DesLocid_Design      = $r.'Thumb_DesLoc::id_Design'
        Thumb_DesLoc_DesDesignName = $r.'Thumb_DesLoc_Des::DesignName'
        Thumb_ProdPartNumber       = $r.'Thumb_Prod::PartNumber'
        Thumb_ProdDescription      = $r.'Thumb_Prod::Description'
    }
}

try {
    if ((Test-Path $LogPath) -and ((Get-Item $LogPath).Length -gt 1MB)) {
        Set-Content -Path $LogPath -Value (Get-Content $LogPath -Tail 250) -Encoding UTF8
    }
    $cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $proxy = $cfg.ProxyBase; $secret = $cfg.CrmApiSecret
    $headers = @{ 'x-crm-api-secret' = $secret }
    $uri = "$proxy/api/thumbnails/metadata-sync"

    $f = Get-ChildItem (Join-Path $SwfFolder 'Thumbnails Report*.xlsx') -File -ErrorAction SilentlyContinue |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $f) { Log 'no "Thumbnails Report*.xlsx" in C:\SWF - nothing to do'; exit 0 }
    Log ('reading ' + $f.Name)
    $data = Import-Excel -Path $f.FullName

    $all = New-Object System.Collections.ArrayList
    $newHash = @{}
    foreach ($r in $data) {
        if ($null -eq $r.ID_Serial -or $r.ID_Serial -eq '') { continue }
        $row = Convert-Row $r
        [void]$all.Add($row)
        $newHash[[string]$row.ID_Serial] = ($row.Values -join '|')
    }
    Log ('rows in export: ' + $all.Count)

    if ($CsvOut) {
        # Serial-prefix FileName ({id}_{orig}) to match the endpoint's insert + keep it
        # UNIQUE; the image sync overwrites FileName later when it attaches the image.
        ($all | ForEach-Object {
            $o = [ordered]@{}
            foreach ($k in $_.Keys) { $o[$k] = $_[$k] }
            $o['FileName'] = "$($_.ID_Serial)_$($_.FileName)"
            [pscustomobject]$o
        }) | Export-Csv -Path $CsvOut -NoTypeInformation -Encoding UTF8
        Log "CSV written: $CsvOut ($($all.Count) rows)"
        exit 0
    }

    # confirmed snapshot (what Caspio already has, by our record)
    $confirmed = @{}
    if (Test-Path $SnapshotPath) {
        try { (Get-Content $SnapshotPath -Raw -Encoding UTF8 | ConvertFrom-Json).psobject.Properties | ForEach-Object { $confirmed[$_.Name] = $_.Value } } catch { Log 'snapshot unreadable - treating as first run' }
    }
    $pending = @($all | Where-Object { $k = [string]$_.ID_Serial; -not $confirmed.ContainsKey($k) -or $confirmed[$k] -ne $newHash[$k] })
    Log ('pending (new/changed): ' + $pending.Count)

    if ($pending.Count -eq 0) {
        Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body (ConvertTo-Json @{ rows = @() } -Compress) -ContentType 'application/json' -TimeoutSec 60 | Out-Null
        Log 'nothing pending - heartbeat sent'
        exit 0
    }

    $batch = @($pending | Select-Object -First $MaxRowsPerRun)
    Log ('processing this run: ' + $batch.Count + ' of ' + $pending.Count + ' pending (cap ' + $MaxRowsPerRun + ')')

    $ins = 0; $upd = 0; $err = 0; $sent = 0
    while ($sent -lt $batch.Count) {
        $chunk = @($batch | Select-Object -Skip $sent -First $ChunkSize)
        $body = ConvertTo-Json @{ rows = $chunk } -Depth 5 -Compress

        # POST with 429 backoff
        $resp = $null; $attempt = 0
        while ($true) {
            try {
                $resp = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 180
                break
            } catch {
                $msg = $_.Exception.Message
                $is429 = ($msg -match '429|Too Many|rate') -or ($_.Exception.Response -and $_.Exception.Response.StatusCode.value__ -eq 429)
                $attempt++
                if ($is429 -and $attempt -le 3) { Log "  rate limited - backing off 90s (attempt $attempt/3)"; Start-Sleep -Seconds 90; continue }
                Log "  chunk POST failed ($msg) - stopping run, will resume next run"
                Log ("DONE(partial): $ins inserted, $upd updated, $err errored; " + ($pending.Count - $sent) + " still pending")
                exit 0   # snapshot already persisted per-chunk; resume next run
            }
        }

        $s = $resp.summary; $ins += $s.inserted; $upd += $s.updated; $err += $s.errored
        # mark confirmed for rows that did NOT error
        $erroredIds = @{}
        if ($resp.errors) { foreach ($e in $resp.errors) { $erroredIds[[string]$e.ID_Serial] = $true } }
        foreach ($row in $chunk) { $k = [string]$row.ID_Serial; if (-not $erroredIds.ContainsKey($k)) { $confirmed[$k] = $newHash[$k] } }
        ($confirmed | ConvertTo-Json -Compress) | Set-Content -Path $SnapshotPath -Encoding UTF8   # persist progress EVERY chunk

        $sent += $chunk.Count
        Log ('  {0}/{1}: {2} ins, {3} upd, {4} err' -f $sent, $batch.Count, $s.inserted, $s.updated, $s.errored)
        if ($s.errored -gt 0 -and $resp.errors) { $resp.errors | Select-Object -First 2 | ForEach-Object { Log ('    err: ' + (ConvertTo-Json $_ -Compress)) } }
        Start-Sleep -Milliseconds 800
    }

    $remaining = $pending.Count - $sent
    Log ("DONE: $ins inserted, $upd updated, $err errored this run; $remaining still pending (next run continues)")
    exit 0
}
catch {
    Log ('FAILED: ' + $_.Exception.Message)
    exit 1
}
