# sync-orders.ps1 — ShopWorks OnSite -> Caspio ORDER_ODBC direct sync agent.
#
# Runs ON BANDIT (the shop ODBC workstation) via Windows Task Scheduler every
# 15 minutes. Pulls Orders rows modified since the last successful run via the
# FileMaker ODBC driver and POSTs them to the caspio-pricing-proxy, which
# upserts them into Caspio ORDER_ODBC (see src/routes/shopworks-odbc-sync.js).
#
# Replaces the legacy CSV export -> OneDrive -> Caspio DataHub import chain.
#
# Files (all in C:\NWCA\odbc-sync\ on bandit):
#   sync-orders.ps1   this script (master copy lives in the caspio-pricing-proxy
#                     repo at scripts/bandit-agent/ — edit THERE, recopy to bandit)
#   config.json       { ProxyBase, CrmApiSecret, Dsn, OverlapMinutes, MaxRows }
#   last-sync.txt     local wall-clock timestamp of last successful run start
#   sync-orders.log   append-only run log (auto-trimmed at ~1 MB)
#
# Design rules (pricing-index repo memory/SHOPWORKS_ODBC_INTEGRATION.md):
#  - Bounded query ONLY: WHERE timestamp_Modification >= last-sync minus overlap.
#    Timestamps are FileMaker-naive LOCAL wall-clock; bandit shares the server's
#    timezone so local Get-Date is the correct clock to compare with.
#  - Explicit column list (never SELECT *); one connection; sequential.
#  - Empty result still POSTs rows:[] — that stamps the watchdog heartbeat, so
#    "agent alive but quiet" never looks like "agent dead".
#  - Exit 0 = success, 1 = failure (Task Scheduler history shows red).

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root      = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $Root 'config.json'
$StatePath  = Join-Path $Root 'last-sync.txt'
$LogPath    = Join-Path $Root 'sync-orders.log'

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

    # Run start is captured BEFORE the query: anything modified while we run
    # falls after this stamp and is picked up next cycle. Never lost.
    $runStart = Get-Date

    if (Test-Path $StatePath) {
        $since = ([datetime](Get-Content $StatePath -Raw).Trim()).AddMinutes(-$overlap)
    } else {
        # First run ever: look back 24h. History is already in ORDER_ODBC via
        # the legacy CSV import, so no deep backfill is needed.
        $since = $runStart.AddHours(-24)
        Log "no state file - first run, since = $since"
    }
    $sinceLit = $since.ToString('yyyy-MM-dd HH:mm:ss')

    # 33 whitelisted columns. id_Contact aliased to Caspio's ID_Contact casing.
    # Calc fields (ct_/cnCur_) are in the SELECT list only - never in WHERE -
    # and the delta keeps row counts small, so per-row evaluation is cheap.
    # NOTE: the chosen ship METHOD is NOT on the Orders table - ShopWorks keeps
    # it on the address row (Addr.ShipMethod). It is pulled by a second bounded
    # query below and attached as a synthetic ShipMethod column per order.
    $sql = @"
SELECT ID_Order, id_Contact AS ID_Contact, id_Customer, id_OrderType, id_EmpCreatedBy,
       date_OrderPlaced, date_OrderRequestedToShip, date_OrderDropDead,
       date_OrderInvoiced, date_Stamp_Invoiced,
       CompanyName, ct_ContactNameFull, ContactEmail, ContactLast,
       ContactFirst, ContactPhone, ContactTitle,
       Invoice_AddressBlock_Billing, Invoice_AddressBlock_Shipping,
       CustomerServiceRep, CustomerType, CustomerPurchaseOrder, TermsName,
       NotesOnOrder, NotesToProduction, NotesToAccounting,
       sts_Invoiced, sts_Shipped,
       cur_Subtotal, cur_Taxable01, cur_Shipping,
       cnCur_TotalInvoice, cnCur_SalesTaxTotal
FROM Orders
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
    $rd.Close()

    # Ship method lives on Addr, not Orders. Pull it for just the orders we
    # changed (bounded IN-list, chunked at 200, same connection - sequential per
    # the vendor rule) and attach it as a synthetic ShipMethod column. id_Order
    # is a plain stored/indexed field on Addr, so the IN filter is cheap; the
    # delta keeps the id list short. First non-blank method wins if an order has
    # more than one ship-to row. Powers the data-quality radar's
    # "method picked but no ship-to address" check.
    $shipByOrder = @{}
    $orderIds = @($rows | ForEach-Object { try { [long]$_['ID_Order'] } catch { $null } } |
        Where-Object { $_ } | Select-Object -Unique)
    for ($k = 0; $k -lt $orderIds.Count; $k += 200) {
        $idChunk = $orderIds[$k..([Math]::Min($k + 199, $orderIds.Count - 1))]
        $inList = ($idChunk -join ', ')
        $addrCmd = $conn.CreateCommand()
        $addrCmd.CommandTimeout = 120
        $addrCmd.CommandText = "SELECT id_Order, ShipMethod FROM Addr WHERE id_Order IN ($inList) AND ShipMethod IS NOT NULL"
        $ar = $addrCmd.ExecuteReader()
        while ($ar.Read()) {
            if ($ar.IsDBNull(0) -or $ar.IsDBNull(1)) { continue }
            $oid = [string][long]$ar.GetValue(0)
            $meth = ([string]$ar.GetValue(1)).Trim()
            if ($meth -ne '' -and -not $shipByOrder.ContainsKey($oid)) { $shipByOrder[$oid] = $meth }
        }
        $ar.Close()
    }
    $conn.Close()

    foreach ($r in $rows) {
        $oid = try { [string][long]$r['ID_Order'] } catch { '' }
        $r['ShipMethod'] = if ($oid -ne '' -and $shipByOrder.ContainsKey($oid)) { $shipByOrder[$oid] } else { $null }
    }
    Log "pulled $($rows.Count) changed order(s); attached ship method to $($shipByOrder.Count)"
    if ($rows.Count -ge $maxRows) {
        Log "WARNING: hit MaxRows cap ($maxRows) - state NOT advanced; next run re-pulls from same point"
    }

    # POST in chunks (rows:[] when nothing changed - heartbeat ping).
    # Chunk size is bounded by Heroku's HARD 30s router timeout: each row costs
    # ~1-2 Caspio calls (~250ms), so 75 rows ~= 19s with margin. 400 rows 503'd
    # on the first live run (2026-07-16).
    $headers = @{ 'x-crm-api-secret' = $cfg.CrmApiSecret }
    $chunkSize = 75
    $sent = 0
    do {
        $chunk = @($rows | Select-Object -Skip $sent -First $chunkSize)
        $body = ConvertTo-Json @{ rows = $chunk } -Depth 5 -Compress
        $resp = Invoke-RestMethod -Method Post `
            -Uri "$($cfg.ProxyBase)/api/shopworks-odbc/sync-orders" `
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

    # Advance state only after every chunk succeeded - and only when we did
    # NOT hit the cap (capped run = there may be more rows in the window).
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
