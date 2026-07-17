# sync-purchase-orders.ps1 — ShopWorks OnSite PO -> Caspio PurchaseOrders direct sync agent.
#
# Runs ON BANDIT (the shop ODBC workstation) via Windows Task Scheduler every
# 15 minutes. Pulls PO rows modified since the last successful run via the
# FileMaker ODBC driver and POSTs them to the caspio-pricing-proxy, which upserts
# them into Caspio PurchaseOrders (see src/routes/shopworks-odbc-sync.js →
# /shopworks-odbc/sync-purchase-orders).
#
# WHY: the SanMar Inbound "✓ Received" filter reads PurchaseOrders.date_Received /
# sts_Received (set when receiving counts a PO in). This agent gets that receipt
# into Caspio in ~15 min instead of the legacy daily "Purchase Orders Export" CSV
# chain. Runs in PARALLEL with that CSV chain (both upsert by ID_PO) until it's
# retired.
#
# Files (all in C:\NWCA\odbc-sync\ on bandit — reuses the ORDER sync's config.json):
#   sync-purchase-orders.ps1   this script (master copy lives in the caspio-pricing-proxy
#                              repo at scripts/bandit-agent/ — edit THERE, recopy to bandit)
#   config.json                { ProxyBase, CrmApiSecret, Dsn, OverlapMinutes, MaxRows }  (SHARED with sync-orders)
#   last-sync-po.txt           local wall-clock timestamp of last successful run start (SEPARATE from orders)
#   sync-purchase-orders.log   append-only run log (auto-trimmed at ~1 MB)
#
# Design rules (pricing-index repo memory/SHOPWORKS_ODBC_INTEGRATION.md):
#  - Bounded query ONLY: WHERE timestamp_Modification >= last-sync minus overlap.
#    Timestamps are FileMaker-naive LOCAL wall-clock; bandit shares the server's tz.
#  - Explicit column list (never SELECT *); one connection; sequential.
#  - Empty result still POSTs rows:[] — stamps the watchdog heartbeat.
#  - Exit 0 = success, 1 = failure (Task Scheduler history shows red).

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root       = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $Root 'config.json'
$StatePath  = Join-Path $Root 'last-sync-po.txt'
$LogPath    = Join-Path $Root 'sync-purchase-orders.log'

function Log([string]$msg) {
    $line = ('{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $msg)
    Add-Content -Path $LogPath -Value $line -Encoding UTF8
    Write-Output $line
}

try {
    if ((Test-Path $LogPath) -and ((Get-Item $LogPath).Length -gt 1MB)) {
        $tail = Get-Content $LogPath -Tail 200
        Set-Content -Path $LogPath -Value $tail -Encoding UTF8
    }

    $cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $overlap = if ($cfg.OverlapMinutes) { [int]$cfg.OverlapMinutes } else { 30 }
    $maxRows = if ($cfg.MaxRows) { [int]$cfg.MaxRows } else { 900 }

    # Run start captured BEFORE the query: anything modified while we run falls
    # after this stamp and is picked up next cycle. Never lost.
    $runStart = Get-Date

    if (Test-Path $StatePath) {
        $since = ([datetime](Get-Content $StatePath -Raw).Trim()).AddMinutes(-$overlap)
    } else {
        # First run ever: look back 24h. PO history is already in PurchaseOrders via
        # the legacy CSV import, so no deep backfill is needed. (For a wider one-time
        # catch-up of older receipts, temporarily edit this to e.g. AddDays(-14).)
        $since = $runStart.AddHours(-24)
        Log "no state file - first run, since = $since"
    }
    $sinceLit = $since.ToString('yyyy-MM-dd HH:mm:ss')

    # 18 whitelisted columns, aliased to the Caspio PurchaseOrders casing. Calc
    # fields (ct_/cnCur_) are in the SELECT list only - never in WHERE - and the
    # delta keeps row counts small, so per-row evaluation is cheap.
    $sql = @"
SELECT ID_PO, id_Order, id_Vendor, ct_VendorName AS VendorName,
       ConfirmationNumber, date_POIssued, date_PORequestedToShip, date_PODropDead,
       date_Received, timestamp_Modification AS date_Modification,
       sts_Issued, sts_Received, sts_RelatedToOrder,
       cur_Subtotal AS Subtotal, cnCur_TotalInvoice AS TotalInvoice,
       cnCur_SalesTaxTotal AS SalesTax, cur_Shipping AS Shipping,
       cnCur_PayablesOutstanding AS PayablesOutstanding
FROM PO
WHERE timestamp_Modification >= {ts '$sinceLit'}
FETCH FIRST $maxRows ROWS ONLY
"@

    Log "query since $sinceLit (overlap ${overlap}m)"

    $conn = New-Object System.Data.Odbc.OdbcConnection
    $conn.ConnectionString = "DSN=$($cfg.Dsn);UID=extro;PWD=extro"
    $conn.ConnectionTimeout = 30
    $conn.Open()
    $cmd = $conn.CreateCommand()
    $cmd.CommandTimeout = 120
    $cmd.CommandText = $sql
    $rd = $cmd.ExecuteReader()

    $rows = New-Object System.Collections.ArrayList
    while ($rd.Read()) {
        $row = @{}
        for ($i = 0; $i -lt $rd.FieldCount; $i++) {
            $name = $rd.GetName($i)
            $val = $rd.GetValue($i)
            if ($val -is [System.DBNull]) { $row[$name] = $null }
            elseif ($val -is [datetime])  { $row[$name] = $val.ToString('yyyy-MM-ddTHH:mm:ss') }
            elseif ($val -is [decimal] -or $val -is [double]) { $row[$name] = [double]$val }
            else { $row[$name] = [string]$val }
        }
        [void]$rows.Add($row)
    }
    $rd.Close(); $conn.Close()
    Log "pulled $($rows.Count) changed PO(s)"
    if ($rows.Count -ge $maxRows) {
        Log "WARNING: hit MaxRows cap ($maxRows) - state NOT advanced; next run re-pulls from same point"
    }

    # POST in chunks (rows:[] when nothing changed - heartbeat ping).
    $headers = @{ 'x-crm-api-secret' = $cfg.CrmApiSecret }
    $chunkSize = 75
    $sent = 0
    do {
        $chunk = @($rows | Select-Object -Skip $sent -First $chunkSize)
        $body = ConvertTo-Json @{ rows = $chunk } -Depth 5 -Compress
        $resp = Invoke-RestMethod -Method Post `
            -Uri "$($cfg.ProxyBase)/api/shopworks-odbc/sync-purchase-orders" `
            -Headers $headers `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) `
            -ContentType 'application/json; charset=utf-8' `
            -TimeoutSec 120
        $s = $resp.summary
        Log "posted $($chunk.Count): $($s.inserted) inserted, $($s.updated) updated, $($s.errored) errored"
        if ($s.errored -gt 0) {
            $resp.errors | Select-Object -First 5 | ForEach-Object { Log ("  row-error: " + (ConvertTo-Json $_ -Compress)) }
            throw "proxy reported $($s.errored) row error(s) - state not advanced"
        }
        $sent += $chunk.Count
    } while ($sent -lt $rows.Count)

    # Advance state only after every chunk succeeded - and only when we did NOT hit
    # the cap (capped run = there may be more rows in the window).
    if ($rows.Count -lt $maxRows) {
        Set-Content -Path $StatePath -Value $runStart.ToString('yyyy-MM-dd HH:mm:ss') -Encoding UTF8
        Log "OK - state advanced to $($runStart.ToString('yyyy-MM-dd HH:mm:ss'))"
    } else {
        Log "OK - capped run, state held for re-pull"
    }
    exit 0
}
catch {
    Log ("FAILED: " + $_.Exception.Message)
    exit 1
}
