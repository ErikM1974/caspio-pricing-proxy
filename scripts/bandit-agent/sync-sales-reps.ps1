# sync-sales-reps.ps1 — ShopWorks Cust -> Caspio Sales_Reps_2026 direct sync agent.
#
# Runs ON BANDIT via Task Scheduler (SYSTEM — needs only the ODBC DSN, no file share).
# Replaces NWCA_SalesReps_Export.ps1 -> OneDrive CSV -> Caspio import. Reads the
# Cust table, applies the same rep/tier cleaning, and POSTs changed rows to the
# proxy, which upserts Sales_Reps_2026 by ID_Customer (see shopworks-odbc-sync.js).
#
# DELTA = snapshot hash (NOT a timestamp): it's a full-table clean, so we hash each
# cleaned row and POST only new/changed ones. Snapshot saved AFTER EVERY CHUNK, so an
# interrupted run resumes without losing progress and never re-does confirmed rows.
# First run (no snapshot) backfills all active customers, capped per run.
#
# Files (C:\NWCA\odbc-sync\ on bandit; reuses the orders/PO config.json):
#   config.json                { ProxyBase, CrmApiSecret, Dsn }
#   last-snapshot-reps.json    ID_Customer -> row hash (resumable delta)
#   sync-sales-reps.log        append-only run log
#
# Master copy: caspio-pricing-proxy/scripts/bandit-agent/ — edit HERE, recopy to bandit.

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root         = 'C:\NWCA\odbc-sync'
$ConfigPath   = Join-Path $Root 'config.json'
$SnapshotPath = Join-Path $Root 'last-snapshot-reps.json'
$LogPath      = Join-Path $Root 'sync-sales-reps.log'
$ChunkSize    = 75
$MaxRowsPerRun = 800

function Log([string]$m) { $line = '{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $m; Add-Content -Path $LogPath -Value $line -Encoding UTF8; Write-Output $line }

# Legacy rep names that collapse to House-Legacy (from NWCA_SalesReps_Export.ps1).
$legacyReps = @(
    'Heather Mullane', 'Christy Peterson', 'Ken Bines', 'Dyonii Flores',
    'Dyonii Quitugua', 'Mike  Roberts', 'Scott Mickelson', 'Rich Gordon',
    'Kim Whitney', 'Jason Rheaume', 'Bronco', 'Holli Fadem',
    'Ken  Baker', 'Nancy Wolf', 'Alicia Wada', 'Adriyella Trujillo'
)

function Clean-Rep([string]$rep) {
    switch -Exact ($rep) {
        ''              { return 'House-Legacy' }
        'Ruth  Nhoung'  { return 'Ruthie Nhoung' }
        'Ruth Nhoung'   { return 'Ruthie Nhoung' }
        'Ruth Nhong'    { return 'Ruthie Nhoung' }
        'ruth'          { return 'Ruthie Nhoung' }
        'Front  Office' { return 'House-Legacy' }
        'Front Office'  { return 'House-Legacy' }
        'Taylar Hanson' { return 'Taylar-Legacy' }
        'Dead'          { return 'DEAD' }
        'dead'          { return 'DEAD' }
        'House House'   { return 'House-Legacy' }
        'jim'           { return 'House-Legacy' }
        'closed'        { return 'House-Legacy' }
        'not assigned'  { return 'House-Legacy' }
        default         { if ($legacyReps -contains $rep) { return 'House-Legacy' } else { return $rep } }
    }
}

function GF($row, [string]$f) { $v = $row[$f]; if ($v -is [System.DBNull] -or $null -eq $v) { return '' }; return "$v".Trim() }

try {
    if ((Test-Path $LogPath) -and ((Get-Item $LogPath).Length -gt 1MB)) { Set-Content -Path $LogPath -Value (Get-Content $LogPath -Tail 200) -Encoding UTF8 }

    $cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $headers = @{ 'x-crm-api-secret' = $cfg.CrmApiSecret }
    $uri = "$($cfg.ProxyBase)/api/shopworks-odbc/sync-sales-reps"

    # --- ODBC read ---
    $conn = New-Object System.Data.Odbc.OdbcConnection
    $conn.ConnectionString = "DSN=$($cfg.Dsn);UID=extro;PWD=extro"
    $conn.ConnectionTimeout = 30
    $conn.Open()
    $cmd = $conn.CreateCommand()
    $cmd.CommandTimeout = 120
    $cmd.CommandText = 'SELECT ID_Customer, CompanyName, CustomerServiceRep, sts_Active, CustomField01, CustomField02, date_LastOrdered FROM Cust'
    $rd = $cmd.ExecuteReader()
    $raw = New-Object System.Collections.ArrayList
    while ($rd.Read()) {
        $h = @{}
        for ($i = 0; $i -lt $rd.FieldCount; $i++) { $h[$rd.GetName($i)] = $rd.GetValue($i) }
        [void]$raw.Add($h)
    }
    $rd.Close(); $conn.Close()
    Log "pulled $($raw.Count) Cust rows"

    # --- clean + filter (mirror the CSV export) ---
    $all = New-Object System.Collections.ArrayList
    $newHash = @{}
    foreach ($r in $raw) {
        $company = GF $r 'CompanyName'
        if ($company -eq '') { continue }
        $active = GF $r 'sts_Active'
        if ($active -ne '1') { continue }
        $rep = Clean-Rep (GF $r 'CustomerServiceRep')
        if ($rep -eq 'DEAD') { continue }

        $tier = GF $r 'CustomField01'
        $tierUp = $tier.ToUpper()
        $isTier = ($tierUp -like '*GOLD*') -or ($tierUp -like '*SILVER*') -or ($tierUp -like '*BRONZE*') -or ($tier -like '*Win Back*')
        $cleanTier = if ($isTier) { $tier } else { 'House-2026' }

        $inksoft = if ((GF $r 'CustomField02') -eq '') { 0 } else { 1 }

        $lastOrd = GF $r 'date_LastOrdered'
        $fDate = ''
        if ($lastOrd -ne '') { try { $fDate = ([DateTime]::Parse($lastOrd)).ToString('M/d/yyyy') } catch { $fDate = $lastOrd } }

        $idc = GF $r 'ID_Customer'
        if ($idc -eq '') { continue }

        $row = [ordered]@{
            ID_Customer        = $idc
            CompanyName        = $company
            CustomerServiceRep = $rep
            Account_Tier       = $cleanTier
            Inksoft_Store      = $inksoft
            date_LastOrdered   = $fDate
        }
        [void]$all.Add($row)
        $newHash[[string]$idc] = (($row.Values | ForEach-Object { "$_" }) -join '|')
    }
    Log "cleaned/kept $($all.Count) active rep rows"

    # --- snapshot delta ---
    $confirmed = @{}
    if (Test-Path $SnapshotPath) {
        try { (Get-Content $SnapshotPath -Raw -Encoding UTF8 | ConvertFrom-Json).psobject.Properties | ForEach-Object { $confirmed[$_.Name] = $_.Value } } catch { Log 'snapshot unreadable - treating as first run' }
    }
    $pending = @($all | Where-Object { $k = [string]$_.ID_Customer; -not $confirmed.ContainsKey($k) -or $confirmed[$k] -ne $newHash[$k] })
    Log "pending (new/changed): $($pending.Count)"

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
        foreach ($row in $chunk) { $k = [string]$row.ID_Customer; if (-not $erroredIds.ContainsKey($k)) { $confirmed[$k] = $newHash[$k] } }
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
