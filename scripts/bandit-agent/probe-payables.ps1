# probe-payables.ps1 — ONE-OFF discovery probe. Runs ON BANDIT.
#
# The SanMar Payables reconciliation wants ShopWorks' INVOICE-LEVEL accounts-payable
# data (date_Paid, ID_Payable, InvoiceNumber, cur_Payable, cnCur_PayableOutstanding).
# The current bandit ODBC DSN maps only PO-level payable calc fields — no bill/payable
# table (verified against memory/shopworks-odbc-schema-catalog.txt: tables are Addr,
# Contacts, Cust, Des, Event, InvLevel, LinesOE, Machines, OrdTyp, Orders, PO, Prod, …).
#
# This probe answers: can the AP/bill table be SELECTed via the DSN today (maybe the
# catalog is stale), or must it be EXPOSED in ShopWorks OnSite's "Manage ODBC" mapping
# (or requested from support@shopworx.com) first?
#
# It (1) lists every table the DSN advertises via GetSchema, and (2) tries a
# FETCH FIRST 1 ROW SELECT against likely AP table names, printing the columns of any
# that succeed. NO writes, NO network POST — read-only, safe to run anytime.
#
#   powershell -ExecutionPolicy Bypass -File C:\NWCA\odbc-sync\probe-payables.ps1
#
# Copy the output back to Erik / the repo. Once a table + columns are confirmed, build
# sync-payables.ps1 (clone sync-purchase-orders.ps1) against the real names.

$ErrorActionPreference = 'Stop'
$Root       = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $Root 'config.json'
$cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json

$conn = New-Object System.Data.Odbc.OdbcConnection
$conn.ConnectionString = "DSN=$($cfg.Dsn);UID=extro;PWD=extro"
$conn.ConnectionTimeout = 30
$conn.Open()

Write-Output "=== ALL TABLES advertised by the DSN (GetSchema) ==="
$tables = $conn.GetSchema('Tables')
$tableNames = @()
foreach ($r in $tables.Rows) {
    $tn = $r['TABLE_NAME']
    $tableNames += $tn
    Write-Output ("  {0}" -f $tn)
}

# Candidate ShopWorks AP / vendor-bill table names to try.
$candidates = @('Payables','Payable','Pay','Bills','Bill','VendorInvoice','VendorInvoices',
                'LinesPur','LinePur','APBills','AccountsPayable','PurchaseInvoice','PayHeader')

Write-Output ""
Write-Output "=== Probing candidate AP tables (FETCH FIRST 1 ROW) ==="
foreach ($t in $candidates) {
    try {
        $cmd = $conn.CreateCommand()
        $cmd.CommandTimeout = 30
        $cmd.CommandText = "SELECT * FROM $t FETCH FIRST 1 ROWS ONLY"
        $rd = $cmd.ExecuteReader()
        $cols = @()
        for ($i = 0; $i -lt $rd.FieldCount; $i++) { $cols += ($rd.GetName($i) + ':' + $rd.GetFieldType($i).Name) }
        $rd.Close()
        Write-Output ("  [OK] {0} — {1} columns:" -f $t, $cols.Count)
        # Flag the columns we care about for reconciliation.
        $wanted = @('ID_Payable','date_Paid','InvoiceNumber','id_PO','cur_Payable','cnCur_PayableOutstanding','id_Vendor','date_Payable','sts_ToPay')
        $found = $cols | Where-Object { $c = $_.Split(':')[0]; $wanted -contains $c }
        Write-Output ("        columns: " + ($cols -join ', '))
        if ($found) { Write-Output ("        >>> HAS wanted fields: " + (($found | ForEach-Object { $_.Split(':')[0] }) -join ', ')) }
    }
    catch {
        Write-Output ("  [--] {0} — not selectable ({1})" -f $t, $_.Exception.Message.Split([Environment]::NewLine)[0])
    }
}

$conn.Close()
Write-Output ""
Write-Output "Done. If an AP table shows [OK] with wanted fields -> build sync-payables.ps1 against it."
Write-Output "If none work -> expose the Payables table in ShopWorks OnSite 'Manage ODBC', or ask support@shopworx.com."
