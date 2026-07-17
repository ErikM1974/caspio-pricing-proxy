# sync-designs.ps1 — ShopWorks Des -> Caspio Designs2026 direct sync agent.
#
# Runs ON BANDIT via Task Scheduler (SYSTEM — ODBC only, no file share).
# Replaces NWCA_Designs_Export.ps1 -> OneDrive CSV -> Caspio import. Scans Des
# (date_Creation >= 2022, matching the table floor), maps 18 columns, and POSTs
# changed rows to the proxy, which upserts Designs2026 by ID_Design (a NUMBER that
# may carry a fractional variant id like 35439.03 — never rounded).
#
# DELTA = snapshot hash (full scan, not a timestamp). Snapshot saved after every
# chunk (resumable). First run (no snapshot) backfills, capped + rate-limit-safe.
#
# Files (C:\NWCA\odbc-sync\ on bandit; reuses the orders/PO config.json):
#   config.json                  { ProxyBase, CrmApiSecret, Dsn }
#   last-snapshot-designs.json   ID_Design -> row hash
#   sync-designs.log             append-only run log
#
# -DryRun : read + clean + delta, POST a sample to ?dryRun=true (0 writes).
# -SeedSnapshot : adopt current cleaned state as the delta baseline (0 writes).
# -CsvOut <path> : write cleaned rows to CSV for a one-time bulk Caspio import.
#
# Master copy: caspio-pricing-proxy/scripts/bandit-agent/ — edit HERE, recopy to bandit.

param([switch]$DryRun, [switch]$SeedSnapshot, [string]$CsvOut)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root         = 'C:\NWCA\odbc-sync'
$ConfigPath   = Join-Path $Root 'config.json'
$SnapshotPath = Join-Path $Root 'last-snapshot-designs.json'
$LogPath      = Join-Path $Root 'sync-designs.log'
$ChunkSize    = 75
$MaxRowsPerRun = 800

function Log([string]$m) { $line = '{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $m; Add-Content -Path $LogPath -Value $line -Encoding UTF8; Write-Output $line }
function GF($row, [string]$f) { $v = $row[$f]; if ($v -is [System.DBNull] -or $null -eq $v) { return '' }; return "$v".Trim() }
function FmtDate([string]$d) { if ([string]::IsNullOrWhiteSpace($d)) { return '' }; try { return ([DateTime]::Parse($d)).ToString('M/d/yyyy') } catch { return $d } }

try {
    if ((Test-Path $LogPath) -and ((Get-Item $LogPath).Length -gt 1MB)) { Set-Content -Path $LogPath -Value (Get-Content $LogPath -Tail 200) -Encoding UTF8 }

    $cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $headers = @{ 'x-crm-api-secret' = $cfg.CrmApiSecret }
    $uri = "$($cfg.ProxyBase)/api/shopworks-odbc/sync-designs"

    $sql = @"
SELECT ID_Design, DesignName, id_Customer, sts_Active, id_DesignType, id_Employee_Artist,
       cn_TotalLogHours, sts_DesignDone, date_Designed, date_Creation, SepType, SepTime,
       NotesToProduction, sts_Thumbnails, sts_Attachments, cn_LocationCount, sts_Variation, id_DesignParent
FROM Des
WHERE date_Creation >= '01/01/2022'
"@

    $conn = New-Object System.Data.Odbc.OdbcConnection
    $conn.ConnectionString = "DSN=$($cfg.Dsn);UID=extro;PWD=extro"
    $conn.ConnectionTimeout = 30
    $conn.Open()
    $cmd = $conn.CreateCommand(); $cmd.CommandTimeout = 300; $cmd.CommandText = $sql
    $rd = $cmd.ExecuteReader()
    $raw = New-Object System.Collections.ArrayList
    while ($rd.Read()) {
        $h = @{}
        for ($i = 0; $i -lt $rd.FieldCount; $i++) { $h[$rd.GetName($i)] = $rd.GetValue($i) }
        [void]$raw.Add($h)
    }
    $rd.Close(); $conn.Close()
    Log "pulled $($raw.Count) Des rows"

    $all = New-Object System.Collections.ArrayList
    $newHash = @{}
    foreach ($r in $raw) {
        $idDesign = GF $r 'ID_Design'
        if ($idDesign -eq '') { continue }
        $ht = GF $r 'sts_Thumbnails'; if ($ht -eq '') { $ht = '0' }
        $ha = GF $r 'sts_Attachments'; if ($ha -eq '') { $ha = '0' }
        $iv = GF $r 'sts_Variation'; if ($iv -eq '') { $iv = '0' }
        $row = [ordered]@{
            ID_Design         = $idDesign
            DesignName        = GF $r 'DesignName'
            ID_Customer       = GF $r 'id_Customer'
            Active            = GF $r 'sts_Active'
            DesignType        = GF $r 'id_DesignType'
            Artist            = GF $r 'id_Employee_Artist'
            TotalArtHours     = GF $r 'cn_TotalLogHours'
            DesignComplete    = GF $r 'sts_DesignDone'
            DateDesigned      = FmtDate (GF $r 'date_Designed')
            DateCreated       = FmtDate (GF $r 'date_Creation')
            SepType           = GF $r 'SepType'
            SepTime           = GF $r 'SepTime'
            NotesToProduction = GF $r 'NotesToProduction'
            HasThumbnails     = $ht
            HasAttachments    = $ha
            LocationCount     = GF $r 'cn_LocationCount'
            IsVariation       = $iv
            ParentDesign      = GF $r 'id_DesignParent'
        }
        [void]$all.Add($row)
        $newHash[[string]$idDesign] = (($row.Values | ForEach-Object { "$_" }) -join '|')
    }
    Log "built $($all.Count) design rows"

    if ($CsvOut) {
        ($all | ForEach-Object { [pscustomobject]$_ }) | Export-Csv -Path $CsvOut -NoTypeInformation -Encoding UTF8
        Log "CSV written: $CsvOut ($($all.Count) rows)"
        exit 0
    }

    $confirmed = @{}
    if (Test-Path $SnapshotPath) {
        try { (Get-Content $SnapshotPath -Raw -Encoding UTF8 | ConvertFrom-Json).psobject.Properties | ForEach-Object { $confirmed[$_.Name] = $_.Value } } catch { Log 'snapshot unreadable - treating as first run' }
    }
    $pending = @($all | Where-Object { $k = [string]$_.ID_Design; -not $confirmed.ContainsKey($k) -or $confirmed[$k] -ne $newHash[$k] })
    Log "pending (new/changed): $($pending.Count)"

    if ($DryRun) {
        $sample = @($pending | Select-Object -First $ChunkSize)
        $body = ConvertTo-Json @{ rows = $sample } -Depth 5 -Compress
        $resp = Invoke-RestMethod -Method Post -Uri "$uri`?dryRun=true" -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 120
        Log "DRY-RUN: pending=$($pending.Count); posted $($sample.Count) rows to ?dryRun=true; wouldUpsert=$($resp.wouldUpsert)"
        Log ('  sample: ' + (ConvertTo-Json $resp.sampleSanitized -Compress))
        exit 0
    }

    if ($SeedSnapshot) {
        $seed = @{}
        foreach ($row in $all) { $seed[[string]$row.ID_Design] = $newHash[[string]$row.ID_Design] }
        ($seed | ConvertTo-Json -Compress) | Set-Content -Path $SnapshotPath -Encoding UTF8
        Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body (ConvertTo-Json @{ rows = @() } -Compress) -ContentType 'application/json' -TimeoutSec 60 | Out-Null
        Log "SEEDED snapshot with $($seed.Count) rows (no backfill; only future changes will sync)"
        exit 0
    }

    if ($pending.Count -eq 0) {
        Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body (ConvertTo-Json @{ rows = @() } -Compress) -ContentType 'application/json' -TimeoutSec 60 | Out-Null
        Log 'nothing pending - heartbeat sent'
        exit 0
    }

    $batch = @($pending | Select-Object -First $MaxRowsPerRun)
    Log "processing this run: $($batch.Count) of $($pending.Count) (cap $MaxRowsPerRun)"

    $ins = 0; $upd = 0; $err = 0; $sent = 0
    while ($sent -lt $batch.Count) {
        $chunk = @($batch | Select-Object -Skip $sent -First $ChunkSize)
        $body = ConvertTo-Json @{ rows = $chunk } -Depth 5 -Compress
        $resp = $null; $attempt = 0
        while ($true) {
            try {
                $resp = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 120
                break
            } catch {
                $msg = $_.Exception.Message
                $is429 = ($msg -match '429|Too Many|rate') -or ($_.Exception.Response -and $_.Exception.Response.StatusCode.value__ -eq 429)
                $attempt++
                if ($is429 -and $attempt -le 3) { Log "  rate limited - backing off 90s (attempt $attempt/3)"; Start-Sleep -Seconds 90; continue }
                Log "  chunk POST failed ($msg) - stopping run, will resume next run"
                exit 0
            }
        }
        $s = $resp.summary; $ins += $s.inserted; $upd += $s.updated; $err += $s.errored
        $erroredIds = @{}
        if ($resp.errors) { foreach ($e in $resp.errors) { $erroredIds[[string]$e.key] = $true } }
        foreach ($row in $chunk) { $k = [string]$row.ID_Design; if (-not $erroredIds.ContainsKey($k)) { $confirmed[$k] = $newHash[$k] } }
        ($confirmed | ConvertTo-Json -Compress) | Set-Content -Path $SnapshotPath -Encoding UTF8
        $sent += $chunk.Count
        Log ('  {0}/{1}: {2} ins, {3} upd, {4} err' -f $sent, $batch.Count, $s.inserted, $s.updated, $s.errored)
        if ($s.errored -gt 0 -and $resp.errors) { $resp.errors | Select-Object -First 3 | ForEach-Object { Log ('    err: ' + (ConvertTo-Json $_ -Compress)) } }
        Start-Sleep -Milliseconds 500
    }
    Log "DONE: $ins inserted, $upd updated, $err errored this run; $($pending.Count - $sent) still pending"
    exit 0
}
catch {
    Log ('FAILED: ' + $_.Exception.Message)
    exit 1
}
