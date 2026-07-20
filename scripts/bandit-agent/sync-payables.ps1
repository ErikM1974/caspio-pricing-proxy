# sync-payables.ps1 — ShopWorks OnSite accounts-payable -> Caspio ShopWorks_Payables sync agent.
#
# Runs ON BANDIT via Task Scheduler every 15 min. Pulls SanMar vendor-bill (payable)
# rows changed since the last run via the FileMaker ODBC driver and POSTs them to the
# caspio-pricing-proxy, which upserts them into Caspio ShopWorks_Payables (see
# src/routes/shopworks-odbc-sync.js -> /shopworks-odbc/sync-payables).
#
# WHY: the SanMar Payables page (/dashboards/sanmar-payables.html) cross-references
# SanMar invoices against this table to show Imported?/Paid? per invoice AND to filter
# the "to import" worklist — replacing the manual "upload your ShopWorks export" step.
# InvoiceNumber is the match key; date_Paid is the reliable paid signal.
#
# ┌─────────────────────────────────────────────────────────────────────────────┐
# │ ⚠ BEFORE THIS WORKS: the ShopWorks AP table must be exposed in the bandit     │
# │   ODBC DSN. It is NOT in the current mapping (see memory schema catalog).     │
# │   1. Run  probe-payables.ps1  → it prints which table + columns are           │
# │      SELECT-able (or confirms you must expose it in ShopWorks OnSite           │
# │      "Manage ODBC", or email support@shopworx.com).                            │
# │   2. Set the two values below from the probe result:                          │
# │         $cfg.PayablesTable      (the AP table name, e.g. 'Payables')           │
# │         $cfg.PayablesDeltaField (its modification-timestamp column)            │
# │      in C:\NWCA\odbc-sync\config.json (or the defaults below are used).        │
# │   3. Test:  powershell -File sync-payables.ps1 -DryRun   (0 writes)            │
# │   4. Schedule the 15-min Task, and add a Heroku Scheduler payables-health job. │
# └─────────────────────────────────────────────────────────────────────────────┘
#
# Files (C:\NWCA\odbc-sync\ — master copies in the caspio-pricing-proxy repo at
# scripts/bandit-agent/; edit THERE, recopy to bandit):
#   sync-payables.ps1   this script      config.json  { ProxyBase, CrmApiSecret, Dsn,
#   last-sync-payables.txt  last run start   OverlapMinutes, MaxRows, PayablesTable, PayablesDeltaField }
#   sync-payables.log   append-only run log (auto-trimmed at ~1 MB)

param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root       = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $Root 'config.json'
$StatePath  = Join-Path $Root 'last-sync-payables.txt'
$LogPath    = Join-Path $Root 'sync-payables.log'

function Log([string]$msg) {
    $line = ('{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $msg)
    Add-Content -Path $LogPath -Value $line -Encoding UTF8
    Write-Output $line
}

try {
    if ((Test-Path $LogPath) -and ((Get-Item $LogPath).Length -gt 1MB)) {
        Set-Content -Path $LogPath -Value (Get-Content $LogPath -Tail 200) -Encoding UTF8
    }

    $cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $overlap = if ($cfg.OverlapMinutes) { [int]$cfg.OverlapMinutes } else { 30 }
    $maxRows = if ($cfg.MaxRows) { [int]$cfg.MaxRows } else { 900 }
    # From the probe (adjust if the AP table/columns differ on your OnSite):
    $table   = if ($cfg.PayablesTable) { [string]$cfg.PayablesTable } else { 'Payables' }
    $deltaF  = if ($cfg.PayablesDeltaField) { [string]$cfg.PayablesDeltaField } else { 'timestamp_Modification' }

    $runStart = Get-Date
    if (Test-Path $StatePath) {
        $since = ([datetime](Get-Content $StatePath -Raw).Trim()).AddMinutes(-$overlap)
    } else {
        # First run: look back 1 year so the whole current AP book lands once, then delta.
        $since = $runStart.AddDays(-365)
        Log "no state file - first run, since = $since"
    }
    $sinceLit = $since.ToString('yyyy-MM-dd HH:mm:ss')

    # Explicit column list, aliased to the Caspio ShopWorks_Payables casing. Adjust the
    # source names to your OnSite AP table if the probe shows different ones. ct_VendorNameDisplay
    # → VendorName (SANMAR). $deltaF is the delta column (also aliased to date_Modification).
    $sql = @"
SELECT ID_Payable, InvoiceNumber, id_PO, id_Order, id_Vendor,
       ct_VendorNameDisplay AS VendorName,
       date_Payable, date_PayableDue, date_Creation, date_Paid,
       cur_Payable, cnCur_PayableOutstanding, sts_ToPay,
       $deltaF AS date_Modification
FROM $table
WHERE $deltaF >= {ts '$sinceLit'}
FETCH FIRST $maxRows ROWS ONLY
"@

    Log "query $table since $sinceLit (overlap ${overlap}m)$(if($DryRun){' [DRY RUN]'})"

    $conn = New-Object System.Data.Odbc.OdbcConnection
    $conn.ConnectionString = "DSN=$($cfg.Dsn);UID=extro;PWD=extro"
    $conn.ConnectionTimeout = 30
    $conn.Open()
    $cmd = $conn.CreateCommand(); $cmd.CommandTimeout = 120; $cmd.CommandText = $sql
    $rd = $cmd.ExecuteReader()

    $rows = New-Object System.Collections.ArrayList
    while ($rd.Read()) {
        $row = @{}
        for ($i = 0; $i -lt $rd.FieldCount; $i++) {
            $name = $rd.GetName($i); $val = $rd.GetValue($i)
            if ($val -is [System.DBNull]) { $row[$name] = $null }
            elseif ($val -is [datetime])  { $row[$name] = $val.ToString('yyyy-MM-ddTHH:mm:ss') }
            elseif ($val -is [decimal] -or $val -is [double]) { $row[$name] = [double]$val }
            else { $row[$name] = [string]$val }
        }
        [void]$rows.Add($row)
    }
    $rd.Close(); $conn.Close()
    Log "pulled $($rows.Count) changed payable(s)"
    if ($rows.Count -ge $maxRows) { Log "WARNING: hit MaxRows cap ($maxRows) - state NOT advanced; next run re-pulls" }

    $uri = "$($cfg.ProxyBase)/api/shopworks-odbc/sync-payables$(if($DryRun){'?dryRun=true'})"
    $headers = @{ 'x-crm-api-secret' = $cfg.CrmApiSecret }
    $chunkSize = 75; $sent = 0
    do {
        $chunk = @($rows | Select-Object -Skip $sent -First $chunkSize)
        $body = ConvertTo-Json @{ rows = $chunk } -Depth 5 -Compress
        $resp = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -ContentType 'application/json; charset=utf-8' -TimeoutSec 120
        if ($DryRun) { Log "DRY RUN - would upsert $($resp.wouldUpsert); sample: $((ConvertTo-Json $resp.sampleSanitized -Compress))" }
        else {
            $s = $resp.summary
            Log "posted $($chunk.Count): $($s.inserted) inserted, $($s.updated) updated, $($s.errored) errored"
            if ($s.errored -gt 0) { $resp.errors | Select-Object -First 5 | ForEach-Object { Log ("  row-error: " + (ConvertTo-Json $_ -Compress)) }; throw "proxy reported $($s.errored) row error(s)" }
        }
        $sent += $chunk.Count
    } while ($sent -lt $rows.Count -and -not $DryRun)

    if (-not $DryRun -and $rows.Count -lt $maxRows) {
        Set-Content -Path $StatePath -Value $runStart.ToString('yyyy-MM-dd HH:mm:ss') -Encoding UTF8
        Log "OK - state advanced to $($runStart.ToString('yyyy-MM-dd HH:mm:ss'))"
    } else { Log "OK$(if($DryRun){' (dry run, state unchanged)'}else{' - capped run, state held'})" }
    exit 0
}
catch { Log ("FAILED: " + $_.Exception.Message); exit 1 }
