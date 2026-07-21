# sync-thumbnail-metadata.ps1 -- ShopWorks Thumbnails (ODBC) -> proxy -> Caspio.
#
# Runs ON BANDIT (Task Scheduler \NWCA\Thumbnail Metadata Sync, every 30 min,
# SYSTEM). Pulls thumbnail metadata DIRECTLY from the OnSite FileMaker "Thumbnails"
# table via ODBC and upserts it into Caspio Shopworks_Thumbnail_Report through
# POST /api/thumbnails/metadata-sync (see src/routes/thumbnails.js).
#
# 2026-07-21 CUTOVER: replaces the old xlsx path (read Erik's manual
# "Thumbnails Report*.xlsx" from C:\SWF via ImportExcel). ShopWorks ticket 386060
# (Ryan Gaul) exposed the Thumbnails + DesignLocations tables in Data_ODBCMapping,
# so the whole report is now derivable by direct query -- no manual export, no
# \\BANDIT\SWF drop, no ImportExcel dependency.
#
# WHAT IT SENDS (identical row shape to the retired xlsx path, so the proxy
# endpoint is UNCHANGED -- it upserts by ID_Serial, writes metadata columns only,
# and never touches the image-side columns owned by upload-with-stub):
#   ID_Serial, FileName, FileWidth, FileHeight, FileSizeDisplay, timestamp_Added,
#   Thumb_DesLocid_Design, Thumb_DesLoc_DesDesignName, Thumb_ProdPartNumber,
#   Thumb_ProdDescription
#
# SCOPE FILTER = FileName IS NOT NULL. The ODBC Thumbnails table has ~105k rows;
# only ~27.3k carry an actual image file (the other ~78k are metadata-only shells).
# FileName IS NOT NULL reproduces the old xlsx report's row set (~27.3k) and keeps
# junk shells out of Caspio.
#
# id_Design + DesignName are resolved in-SQL via LEFT JOINs (FileMaker matches the
# decimal keys internally -- the driver returns them as Double, so an app-side
# IN-list literal would be float-fragile). PartNumber/Description apply only to the
# ~30 product thumbnails (id_Design NULL); enriched from Prod on integer keys, only
# when such rows appear in a delta -- so their cosmetic values are never blanked.
#
# DELTA on timestamp_Modification (the only reliably-populated stamp; timestamp_Added
# and timestamp_Creation are frequently NULL). Bounded query, one connection,
# explicit column list -- per the vendor rules in the pricing-index repo memory
# (SHOPWORKS_ODBC_INTEGRATION.md).
#
# Files (on bandit):
#   C:\NWCA\thumb-sync\sync-thumbnail-metadata.ps1   this script
#   C:\NWCA\odbc-sync\config.json                    { ProxyBase, CrmApiSecret, Dsn, OverlapMinutes }
#   C:\NWCA\thumb-sync\last-sync-thumb-meta.txt      local wall-clock of last successful run start
#   C:\NWCA\thumb-sync\sync-thumbnail-metadata.log   append-only run log (auto-trimmed)
#
# -DryRun    : pull + build rows, log a sample, POST nothing.
# -SeedState : write the state file to NOW without syncing (adopt-current baseline).
#
# Master copy: caspio-pricing-proxy/scripts/bandit-agent/ -- edit HERE, recopy to bandit.

param([switch]$DryRun, [switch]$SeedState)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root       = 'C:\NWCA\thumb-sync'
$ConfigPath = 'C:\NWCA\odbc-sync\config.json'
$StatePath  = Join-Path $Root 'last-sync-thumb-meta.txt'
$LogPath    = Join-Path $Root 'sync-thumbnail-metadata.log'
$MaxRows    = 1500     # safety backstop; the delta is tiny in steady state
$ChunkSize  = 50       # endpoint caps at 500/call and throttles internally
New-Item -ItemType Directory -Force -Path $Root | Out-Null

function Log([string]$msg) {
    $line = ('{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $msg)
    Add-Content -Path $LogPath -Value $line -Encoding UTF8
    Write-Output $line
}

# Faithfully render a numeric design id (Double) as text: whole -> "38548",
# fractional variant -> "39845.02" (trim float noise to 4 dp, no trailing zeros).
function FmtId($v) {
    if ($null -eq $v -or $v -is [System.DBNull]) { return $null }
    $d = [double]$v
    if ([math]::Floor($d) -eq $d) { return ([long]$d).ToString([Globalization.CultureInfo]::InvariantCulture) }
    return $d.ToString('0.####', [Globalization.CultureInfo]::InvariantCulture)
}

try {
    if ((Test-Path $LogPath) -and ((Get-Item $LogPath).Length -gt 1MB)) {
        Set-Content -Path $LogPath -Value (Get-Content $LogPath -Tail 200) -Encoding UTF8
    }

    $cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $overlap = if ($cfg.OverlapMinutes) { [int]$cfg.OverlapMinutes } else { 30 }
    $headers = @{ 'x-crm-api-secret' = $cfg.CrmApiSecret }
    $uri = "$($cfg.ProxyBase)/api/thumbnails/metadata-sync"

    # Captured BEFORE the query: anything modified while we run falls after this
    # stamp and is picked up next cycle. Never lost.
    $runStart = Get-Date

    if ($SeedState) {
        Set-Content -Path $StatePath -Value $runStart.ToString('yyyy-MM-dd HH:mm:ss') -Encoding UTF8
        Log "SEEDED state to $($runStart.ToString('yyyy-MM-dd HH:mm:ss')) (no sync; only future changes will pull)"
        exit 0
    }

    if (Test-Path $StatePath) {
        $since = ([datetime](Get-Content $StatePath -Raw).Trim()).AddMinutes(-$overlap)
    } else {
        # No state: look back 24h (safe default). Full history is already in
        # Shopworks_Thumbnail_Report from the completed backfill, so no deep re-pull.
        $since = $runStart.AddHours(-24)
        Log "no state file - first run, since = $since"
    }
    $sinceLit = $since.ToString('yyyy-MM-dd HH:mm:ss')

    # Query 1: delta on Thumbnails (image-bearing only), JOIN-resolving id_Design
    # + DesignName. Calc fields are never referenced; timestamp_Modification is a
    # plain stored/indexed field.
    $sql = @"
SELECT T.ID_Serial, T.id_DesignLoc, T.id_ProductSerial, T.FileName, T.FileWidth,
       T.FileHeight, T.FileSizeDisplay, T.timestamp_Added, DL.id_Design, D.DesignName
FROM Thumbnails T
LEFT JOIN DesignLocations DL ON T.id_DesignLoc = DL.ID_DesignLoc
LEFT JOIN Des D ON DL.id_Design = D.ID_Design
WHERE T.timestamp_Modification >= {ts '$sinceLit'} AND T.FileName IS NOT NULL
FETCH FIRST $MaxRows ROWS ONLY
"@

    Log "query since $sinceLit (overlap ${overlap}m)"

    $conn = New-Object System.Data.Odbc.OdbcConnection
    $conn.ConnectionString = "DSN=$($cfg.Dsn);UID=extro;PWD=extro"
    $conn.ConnectionTimeout = 30
    $conn.Open()
    $cmd = $conn.CreateCommand()
    $cmd.CommandTimeout = 180
    $cmd.CommandText = $sql
    $rd = $cmd.ExecuteReader()

    $rows = New-Object System.Collections.ArrayList
    $prodSerials = New-Object System.Collections.Generic.HashSet[long]
    while ($rd.Read()) {
        $idSerial = [long]$rd.GetValue(0)
        $idDesign = FmtId $rd.GetValue(8)
        $prodSer = $null
        if (-not $rd.IsDBNull(2)) { try { $prodSer = [long]$rd.GetValue(2) } catch { $prodSer = $null } }
        $tsAdded = $null
        if (-not $rd.IsDBNull(7)) { $v = $rd.GetValue(7); if ($v -is [datetime]) { $tsAdded = $v.ToString('yyyy-MM-ddTHH:mm:ss') } }

        $row = [ordered]@{
            ID_Serial                  = $idSerial
            FileName                   = $(if ($rd.IsDBNull(3)) { $null } else { [string]$rd.GetValue(3) })
            FileWidth                  = $(if ($rd.IsDBNull(4)) { $null } else { [int][double]$rd.GetValue(4) })
            FileHeight                 = $(if ($rd.IsDBNull(5)) { $null } else { [int][double]$rd.GetValue(5) })
            FileSizeDisplay            = $(if ($rd.IsDBNull(6)) { $null } else { [string]$rd.GetValue(6) })
            timestamp_Added            = $tsAdded
            Thumb_DesLocid_Design      = $idDesign
            Thumb_DesLoc_DesDesignName = $(if ($rd.IsDBNull(9)) { $null } else { [string]$rd.GetValue(9) })
            Thumb_ProdPartNumber       = $null
            Thumb_ProdDescription      = $null
            _prodSerial                = $prodSer   # internal; removed before POST
        }
        [void]$rows.Add($row)
        if ($null -ne $prodSer -and $null -eq $idDesign) { [void]$prodSerials.Add($prodSer) }
    }
    $rd.Close()

    # Query 2 (conditional): PartNumber/Description for product thumbnails only.
    # Integer keys -> clean IN-list; same connection, sequential; chunked at 200.
    if ($prodSerials.Count -gt 0) {
        $prodMap = @{}
        $serialArr = @($prodSerials)
        for ($k = 0; $k -lt $serialArr.Count; $k += 200) {
            $idChunk = $serialArr[$k..([Math]::Min($k + 199, $serialArr.Count - 1))]
            $inList = ($idChunk -join ', ')
            $pcmd = $conn.CreateCommand()
            $pcmd.CommandTimeout = 120
            $pcmd.CommandText = "SELECT ID_ProductSerial, PartNumber, Description FROM Prod WHERE ID_ProductSerial IN ($inList)"
            $pr = $pcmd.ExecuteReader()
            while ($pr.Read()) {
                $ps = [long]$pr.GetValue(0)
                $prodMap[$ps] = @{
                    Part = $(if ($pr.IsDBNull(1)) { $null } else { [string]$pr.GetValue(1) })
                    Desc = $(if ($pr.IsDBNull(2)) { $null } else { [string]$pr.GetValue(2) })
                }
            }
            $pr.Close()
        }
        foreach ($row in $rows) {
            $ps = $row['_prodSerial']
            if ($null -ne $ps -and $prodMap.ContainsKey($ps)) {
                $row['Thumb_ProdPartNumber']  = $prodMap[$ps].Part
                $row['Thumb_ProdDescription'] = $prodMap[$ps].Desc
            }
        }
        Log "enriched $($prodMap.Count) product thumbnail(s) with PartNumber/Description"
    }
    $conn.Close()

    foreach ($row in $rows) { $row.Remove('_prodSerial') }

    Log "pulled $($rows.Count) changed thumbnail(s) with a file"
    if ($rows.Count -ge $MaxRows) {
        Log "WARNING: hit MaxRows cap ($MaxRows) - state NOT advanced; next run re-pulls from same point"
    }

    if ($DryRun) {
        Log "DRY-RUN: would upsert $($rows.Count) row(s); sample:"
        $rows | Select-Object -First 5 | ForEach-Object { Log ('  ' + (ConvertTo-Json $_ -Compress)) }
        exit 0
    }

    # POST in chunks (rows:[] when nothing changed = heartbeat ping).
    $ins = 0; $upd = 0; $err = 0; $sent = 0
    if ($rows.Count -eq 0) {
        Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body (ConvertTo-Json @{ rows = @() } -Compress) -ContentType 'application/json' -TimeoutSec 60 | Out-Null
        Log 'nothing changed - heartbeat sent'
    } else {
        do {
            $chunk = @($rows | Select-Object -Skip $sent -First $ChunkSize)
            $body = ConvertTo-Json @{ rows = $chunk } -Depth 5 -Compress
            $resp = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers `
                -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) `
                -ContentType 'application/json; charset=utf-8' -TimeoutSec 180
            $s = $resp.summary
            $ins += $s.inserted; $upd += $s.updated; $err += $s.errored
            Log "posted $($chunk.Count): $($s.inserted) ins, $($s.updated) upd, $($s.errored) err"
            if ($s.errored -gt 0) {
                $resp.errors | Select-Object -First 5 | ForEach-Object { Log ('  row-error: ' + (ConvertTo-Json $_ -Compress)) }
                throw "proxy reported $($s.errored) row error(s) - state not advanced"
            }
            $sent += $chunk.Count
            Start-Sleep -Milliseconds 500
        } while ($sent -lt $rows.Count)
    }

    # Advance state only when we did NOT hit the cap.
    if ($rows.Count -lt $MaxRows) {
        Set-Content -Path $StatePath -Value $runStart.ToString('yyyy-MM-dd HH:mm:ss') -Encoding UTF8
        Log "OK - state advanced to $($runStart.ToString('yyyy-MM-dd HH:mm:ss')); $ins inserted, $upd updated this run"
    } else {
        Log "OK - capped run, state held for re-pull"
    }
    exit 0
}
catch {
    Log ('FAILED: ' + $_.Exception.Message)
    exit 1
}
