# sync-contacts.ps1 — ShopWorks -> Caspio CompanyContactsMerge2026 direct sync agent.
#
# Runs ON BANDIT via Task Scheduler (SYSTEM — needs only the ODBC DSN, no file share).
# Replaces NWCA_Contacts_Export.ps1 -> OneDrive CSV -> Caspio import. Reads Contacts +
# Addr + ContactNumbers + Cust over ODBC, applies the SAME data-cleaning as the CSV
# export, and POSTs changed rows to the proxy, which upserts CompanyContactsMerge2026
# by ID_Contact (see shopworks-odbc-sync.js).
#
# The proxy WHITELISTS columns, so the enrichment columns (MO_Sync_*, Orders_*_24mo,
# Phone_Best, Phone_All_JSON, Preferred_Terms_FromOrders) are never touched, and the
# 3 fields the table lacks (Phone/Employee_Count/Hold_Message) are ignored server-side.
#
# DELTA = snapshot hash (full-table clean, not a timestamp): hash each cleaned row,
# POST only new/changed. Snapshot saved AFTER EVERY CHUNK (resumable). First run
# (no snapshot) backfills all contacts, capped per run + rate-limit-safe.
#
# Files (C:\NWCA\odbc-sync\ on bandit; reuses the orders/PO config.json):
#   config.json                 { ProxyBase, CrmApiSecret, Dsn }
#   last-snapshot-contacts.json ID_Contact -> row hash
#   sync-contacts.log           append-only run log
#
# Master copy: caspio-pricing-proxy/scripts/bandit-agent/ — edit HERE, recopy to bandit.
# The cleaning functions below are ported verbatim from NWCA_Contacts_Export.ps1.
#
# -DryRun : 4-table ODBC read + clean + compute the delta, then POST a sample to
#           ?dryRun=true (validates the whole pipeline, writes NOTHING to Caspio).
# -SeedSnapshot : adopt the CURRENT cleaned state as the delta baseline WITHOUT
#           posting — the table is already current from the last CSV import (same
#           cleaning), so only FUTURE changes sync. ~0 Caspio writes cutover.

# -CsvOut <path> : write the cleaned rows to a CSV (for a one-time bulk Caspio
#           import) instead of syncing — exact table columns, 0 Integrations calls.

param([switch]$DryRun, [switch]$SeedSnapshot, [string]$CsvOut)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root          = 'C:\NWCA\odbc-sync'
$ConfigPath    = Join-Path $Root 'config.json'
$SnapshotPath  = Join-Path $Root 'last-snapshot-contacts.json'
$LogPath       = Join-Path $Root 'sync-contacts.log'
$ChunkSize     = 75
$MaxRowsPerRun = 800

function Log($m) { $line = '{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $m; Add-Content -Path $LogPath -Value $line -Encoding UTF8; Write-Output $line }

# ---- cleaning helpers (verbatim from NWCA_Contacts_Export.ps1) ----
function GF([System.Data.DataRow]$r, [string]$f) { try { $v = $r.Item($f); if ($v -is [DBNull] -or $v -eq $null) { return "" }; return [string]$v } catch { return "" } }
function StripNull([string]$s) { if ([string]::IsNullOrEmpty($s)) { return "" }; return $s -replace '\x00','' }
function Flag($v) { $s = (StripNull ([string]$v)).Trim(); if ($s -eq "") { return $false }; try { return ([double]$s) -ge 1 } catch { return ($s -eq "1" -or $s.ToLower() -eq "true") } }

$cityMap = @{
    'seatle'='Seattle';'seattel'='Seattle';'seatte'='Seattle';'seatttle'='Seattle';'seattle'='Seattle';'seattle,'='Seattle';'seattle, wa'='Seattle';'seatec'='Seattle';'sea tec'='Seattle'
    'puayllup'='Puyallup';'puallup'='Puyallup';'purallup'='Puyallup';'puyallup'='Puyallup'
    'tacona'='Tacoma';'tacoma wa'='Tacoma';'tacoms'='Tacoma'
    'summer'='Sumner';'sunmer'='Sumner';'sumer'='Sumner'
    'aubrun'='Auburn';'aubrn'='Auburn'
    'federal way'='Federal Way';'ferderal way'='Federal Way';'federal wa'='Federal Way';'federal wa.'='Federal Way';'federal  way'='Federal Way';'federal'='Federal Way'
    'edgwood'='Edgewood'
    'tukwilla'='Tukwila';'tulwila'='Tukwila'
    'bonneylake'='Bonney Lake';'bonney'='Bonney Lake'
    'algoina'='Algona'
    'encumclaw'='Enumclaw';'enumnclaw'='Enumclaw';'enumaclw'='Enumclaw';'enunclaw'='Enumclaw'
    'kirland'='Kirkland'
    'pacifice'='Pacific'
    'lacy'='Lacey'
    'lynwood'='Lynnwood'
    'stelicoom'='Steilacoom'
    'mulilteo'='Mukilteo';'muliteo'='Mukilteo';'mukelteo'='Mukilteo'
    'silverdeal'='Silverdale'
    'bermerton'='Bremerton'
    'lakwwood'='Lakewood';'lakewood'='Lakewood'
    'bellueve'='Bellevue';'bellvue'='Bellevue'
    'bellingam'='Bellingham'
    'anacorte'='Anacortes'
    'miklton'='Milton';'mlton'='Milton'
    'buckey'='Buckley'
    'gramham'='Graham'
    'spanway'='Spanaway';'spanaway,'='Spanaway';'spanaway lake'='Spanaway'
    'poulsbon'='Poulsbo'
    'centraila'='Centralia'
    'firecrest'='Fircrest'
    'everette'='Everett'
    'rentona'='Renton'
    'des monies'='Des Moines';'desmoines'='Des Moines'
    'universtity place'='University Place';'univeristy place'='University Place';'unversity place'='University Place';'university'='University Place'
    'mt. vernon'='Mount Vernon';'mt vernon'='Mount Vernon'
    'mt. lake terrace'='Mountlake Terrace';'montlake terrace'='Mountlake Terrace';'mountlake terrace'='Mountlake Terrace';'mount lake terrace'='Mountlake Terrace'
    'seatac'='SeaTac';'sea tac'='SeaTac';'sea-tac'='SeaTac'
    'maple valey'='Maple Valley';'maple vally'='Maple Valley'
    'gig harbor'='Gig Harbor'
    'dupont'='DuPont'
    'woodenville'='Woodinville'
    'millcreek'='Mill Creek'
    'lake tapes'='Lake Tapps';'lake tapp'='Lake Tapps';'lk tapps'='Lake Tapps';'lake tapps, wa'='Lake Tapps'
    'mchord afb'='McChord AFB';'mcchord afb'='McChord AFB';'mc chord afb'='McChord AFB';'mcchord'='McChord AFB';'mcchord field'='McChord AFB';'mcchord clinic'='McChord AFB';'mcchord afb,'='McChord AFB'
    'ft. lewis'='Fort Lewis';'ft lewis'='Fort Lewis'
    'hoquim'='Hoquiam'
    'snoqualmie pass'='Snoqualmie'
    'sedro woolley'='Sedro-Woolley';'sedro wooley'='Sedro-Woolley';'sedro-wooley'='Sedro-Woolley'
    'new castle'='Newcastle'
    'bainbridge ilsand'='Bainbridge Island';'bainbrige island'='Bainbridge Island';'bainbridge is'='Bainbridge Island';'bainbridge'='Bainbridge Island'
    'edmond'='Edmonds'
    'burlingtron'='Burlington'
    'standwood'='Stanwood'
    'ollala'='Olalla';'olalla'='Olalla'
    'fife'='Fife'
    'voughn'='Vaughn'
    'aberdean'='Aberdeen'
    'port angles'='Port Angeles';'pt. angeles'='Port Angeles'
    'richmone'='Richland'
    'mercer  island'='Mercer Island'
    'mose lake'='Moses Lake'
    'east sound'='Eastsound'
    'burien wa 98168'='Burien'
    'bothel'='Bothell'
}

function Fix-State([string]$s) {
    if ([string]::IsNullOrWhiteSpace($s)) { return "" }
    $s = StripNull $s
    $t = $s.Trim()
    if ($t -match '^([A-Za-z]{2})\s+\d') { return $matches[1].ToUpper() }
    $up = $t.ToUpper().TrimEnd('`').Trim()
    switch ($up) {
        'WAA' { return 'WA' }
        'FLA' { return 'FL' }
        'ALBERTA' { return 'AB' }
        'ONTARIO' { return 'ON' }
        'BC CANADA' { return 'BC' }
        'BSC' { return 'BC' }
        default { return $up -replace '\.', '' }
    }
}

function Fix-City([string]$c) {
    if ([string]::IsNullOrWhiteSpace($c)) { return "" }
    $c = StripNull $c
    $t = $c.Trim().TrimEnd(',')
    if ($t -match '^\d{5}$') { return "" }
    $lo = $t.ToLower()
    if ($cityMap.ContainsKey($lo)) { return $cityMap[$lo] }
    if ($t -ceq $t.ToUpper() -and $t.Length -gt 2) {
        return (Get-Culture).TextInfo.ToTitleCase($t.ToLower())
    }
    return $t
}

function Fix-Name([string]$n) {
    if ([string]::IsNullOrWhiteSpace($n)) { return "" }
    $n = StripNull $n
    $n = ($n -replace '\s+', ' ').Trim().TrimEnd(',')
    $n = $n -replace '^(Mr\.\.*\s*|Mrs\.\s*|Ms\.\s*|Dr\.\s*|Mr\s+|Mrs\s+|Ms\s+)', ''
    $n = $n.Trim()
    if ([string]::IsNullOrWhiteSpace($n)) { return "" }
    $p = (Get-Culture).TextInfo.ToTitleCase($n.ToLower())
    if ($p -match "Mc[a-z]") { $p = [regex]::Replace($p, "Mc([a-z])", { param($m) "Mc" + $m.Groups[1].Value.ToUpper() }) }
    if ($p -match "O'[a-z]") { $p = [regex]::Replace($p, "O'([a-z])", { param($m) "O'" + $m.Groups[1].Value.ToUpper() }) }
    if ($p -match "D'[a-z]") { $p = [regex]::Replace($p, "D'([a-z])", { param($m) "D'" + $m.Groups[1].Value.ToUpper() }) }
    return $p
}

function Fix-Title([string]$t) {
    if ([string]::IsNullOrWhiteSpace($t)) { return "" }
    $t = StripNull $t
    $tr = $t.Trim().TrimEnd('.')
    $lo = $tr.ToLower()
    switch ($lo) {
        'ap' { return 'Accounts Payable' }
        'a/p' { return 'Accounts Payable' }
        'accounts payable' { return 'Accounts Payable' }
        'gm' { return 'General Manager' }
        'general manager' { return 'General Manager' }
        'ceo' { return 'CEO' }
        'cfo' { return 'CFO' }
        'coo' { return 'COO' }
        'cto' { return 'CTO' }
        'vp' { return 'Vice President' }
        'vice president' { return 'Vice President' }
        'hr' { return 'HR' }
        'pres' { return 'President' }
        'mgr' { return 'Manager' }
        'office mgr' { return 'Office Manager' }
        'store mgr' { return 'Store Manager' }
        'sales mgr' { return 'Sales Manager' }
        'marketing mgr' { return 'Marketing Manager' }
        'service mgr' { return 'Service Manager' }
        'admin asst' { return 'Admin Assistant' }
        'admin' { return 'Admin' }
        'marketing dir' { return 'Marketing Director' }
        'sales rep' { return 'Sales Rep' }
        'dr' { return 'Dr.' }
        default { return (Get-Culture).TextInfo.ToTitleCase($lo) }
    }
}

function Fix-Company([string]$c) {
    if ([string]::IsNullOrWhiteSpace($c)) { return "" }
    $c = StripNull $c
    $t = $c.Trim().TrimEnd(',')
    if ($t.ToLower() -eq 'dead' -or $t.ToLower() -eq 'dead account') { return "" }
    $t = ($t -replace '\s+', ' ').Trim()
    if ($t.EndsWith('.') -and -not ($t -match '\b(Inc|Co|Ltd|Corp|Jr|Sr|St|Assn|Ave|Blvd|Dr|Dept|Dist|Div|Est|Govt|Hwy)\.$')) {
        $t = $t.TrimEnd('.')
    }
    if ($t -ceq $t.ToUpper() -and $t.Length -gt 3) {
        $t = (Get-Culture).TextInfo.ToTitleCase($t.ToLower())
        $t = $t -replace '\bLlc\b','LLC' -replace '\bInc\b','Inc.' -replace '\bDba\b','DBA'
        $t = $t -replace '\bAfb\b','AFB' -replace '\bUsps\b','USPS' -replace '\bUsa\b','USA'
        $t = $t -replace '\bNw\b','NW' -replace '\bNe\b','NE' -replace '\bSe\b','SE' -replace '\bSw\b','SW'
        $t = $t -replace '\bPo\b','PO' -replace '\bUps\b','UPS'
    }
    return $t
}

$addrKeepUpper = @('PO','BOX','NE','NW','SE','SW','AVE','ST','DR','LN','CT','BLVD','HWY','APO','PSC','STE','RD','PL','WAY','BLDG','FL','PKWY','CIR','TRL','RR')

function Fix-Address([string]$a) {
    if ([string]::IsNullOrWhiteSpace($a)) { return "" }
    $a = StripNull $a
    $t = ($a -replace '\s+', ' ').Trim()
    if ($t -ceq $t.ToUpper() -and $t.Length -gt 5) {
        $t = (Get-Culture).TextInfo.ToTitleCase($t.ToLower())
        foreach ($abbr in $addrKeepUpper) {
            $lo = (Get-Culture).TextInfo.ToTitleCase($abbr.ToLower())
            $t = $t -replace "\b$lo\b",$abbr
        }
        $t = $t -replace '\bP\.o\.\b','P.O.' -replace '\bP\.o\b','P.O.'
    }
    return $t
}

function Fix-Zip([string]$z) {
    if ([string]::IsNullOrWhiteSpace($z)) { return "" }
    $z = StripNull $z
    $t = $z.Trim()
    if ($t -match '^\d{4}$') { return "0$t" }
    if ($t -match '^[A-Za-z]+$' -and $t.Length -gt 3) { return "" }
    if ($t.Length -gt 12) { return "" }
    if ($t -match '^\d{3}-\d{3}-\d{4}') { return "" }
    return $t
}

function Fix-Phone([string]$p) {
    if ([string]::IsNullOrWhiteSpace($p)) { return "" }
    $p = StripNull $p
    $ext = ""
    if ($p -match '(?i)\s*(?:x|ext\.?|extension)\s*(\d+)\s*$') {
        $ext = $matches[1]
        $p = $p -replace '(?i)\s*(?:x|ext\.?|extension)\s*\d+\s*$',''
    }
    $digits = ($p -replace '[^\d]','')
    if ($digits.Length -eq 11 -and $digits.StartsWith('1')) { $digits = $digits.Substring(1) }
    if ($digits.Length -eq 10) {
        $f = "($($digits.Substring(0,3))) $($digits.Substring(3,3))-$($digits.Substring(6,4))"
        if ($ext -ne "") { $f += " x$ext" }
        return $f
    }
    return $p.Trim()
}

function Fix-Web([string]$w) {
    if ([string]::IsNullOrWhiteSpace($w)) { return "" }
    $w = StripNull $w
    $t = ($w -replace '\s+','').Trim()
    if ($t -eq "" -or $t.ToLower() -eq "n/a" -or $t.ToLower() -eq "none" -or $t.ToLower() -eq "http://") { return "" }
    return $t
}

function Fix-Emp([string]$e) {
    if ([string]::IsNullOrWhiteSpace($e)) { return "" }
    $e = StripNull $e
    $t = $e.Trim()
    try { $n = [int][double]$t; if ($n -le 0) { return "" }; return [string]$n } catch { return "" }
}

function Clean-SalesRep([string]$rep) {
    if ([string]::IsNullOrWhiteSpace($rep)) { return "House" }
    $t = $rep.Trim(); $lo = $t.ToLower()
    if ($t -eq "Nika Lao") { return "Nika Lao" }
    if ($t -eq "Taneisha Clark") { return "Taneisha Clark" }
    if ($t -eq "Jim Mickelson") { return "Jim Mickelson" }
    if ($t -eq "Erik Mickelson") { return "Erik Mickelson" }
    if ($t -eq "Taylar Hanson") { return "Taylar Hanson" }
    if ($t -eq "Ruthie Nhoung") { return "Ruthie Nhoung" }
    if ($lo -match "ruth.*nhoung|ruth.*nhong") { return "Ruthie Nhoung" }
    if ($lo -eq "ruth") { return "Ruthie Nhoung" }
    if ($lo -eq "dead" -or $lo -eq "closed") { return "DEAD" }
    return "House"
}

function Get-RepEmail([string]$rep) {
    switch ($rep) {
        "Nika Lao" { return "nika@nwcustomapparel.com" }
        "Taneisha Clark" { return "taneisha@nwcustomapparel.com" }
        "Jim Mickelson" { return "jim@nwcustomapparel.com" }
        "Erik Mickelson" { return "erik@nwcustomapparel.com" }
        "Ruthie Nhoung" { return "ruth@nwcustomapparel.com" }
        default { return "" }
    }
}

function Clean-CustomerType([string]$ty) {
    if ([string]::IsNullOrWhiteSpace($ty)) { return "Uncategorized" }
    $t = $ty.Trim(); $lo = $t.ToLower()
    if ($lo -eq "dead") { return "DEAD" }
    if ($lo -eq "corporate" -or $lo -eq "alaska charter" -or $lo -eq "alaska" -or $lo -eq "charter") { return "Corporate" }
    if ($lo -match "targa real estate") { return "Corporate" }
    if ($lo -eq "construction" -or $lo -eq "landscaper" -or $lo -eq "plumber") { return "Construction" }
    if ($lo -eq "contract") { return "Contract" }
    if ($lo -eq "food service") { return "Food Service" }
    if ($lo -eq "fire/police") { return "Fire/Police" }
    if ($lo -eq "amc") { return "AMC" }
    if ($lo -eq "school") { return "School" }
    if ($lo -eq "medical") { return "Medical" }
    if ($lo -eq "events") { return "Events" }
    if ($lo -eq "military") { return "Military" }
    if ($lo -eq "employee") { return "Employee" }
    if ($lo -eq "boy scout" -or $lo -match "sub vet" -or $lo -eq "subvet" -or $lo -eq "club" -or $lo -eq "emblem") { return "Organization" }
    if ($lo -eq "retail" -or $lo -match "personal" -or $lo -match "person" -or $lo -eq "online store" -or $lo -eq "house" -or $lo -eq "first timer tee" -or $lo -eq "`$1.00 tee" -or $lo -eq "sport") { return "Retail" }
    return $t
}

function Clean-Terms([string]$te) {
    if ([string]::IsNullOrWhiteSpace($te)) { return "" }
    $t = $te.Trim(); $lo = $t.ToLower()
    if ($lo -match "card#|card\d|^1xcc|^cc|visa|mastercard|amex|ameican express|american express|call 4 cc|po/ccon|^credit card$") { return "Credit Card on File" }
    if ($lo -match "need credit|need cc|need reseller") { return "Need Credit Card" }
    if ($lo -eq "prepay" -or $lo -eq "pre pay" -or $lo -eq "prepaid") { return "Prepaid" }
    if ($lo -eq "credit hold") { return "Credit Hold" }
    if ($lo -match "^net 10") { return "Net 10" }
    if ($lo -eq "net 30") { return "Net 30" }
    if ($lo -eq "net 15") { return "Net 15" }
    if ($lo -eq "net 45") { return "Net 45" }
    if ($lo -eq "due on receipt") { return "Due on Receipt" }
    if ($lo -eq "owes") { return "Owes Balance" }
    if ($lo -match "tradeout|^trade$|^transfer$") { return "Trade" }
    if ($lo -match "geiger po") { return "PO" }
    if ($lo -match "eft bank") { return "EFT Bank" }
    if ($t -eq "Pay On Pickup") { return "Pay On Pickup" }
    return $t
}

function Clean-Tier([string]$ti) {
    if ([string]::IsNullOrWhiteSpace($ti)) { return "House-2026" }
    $up = $ti.ToUpper()
    if ($up -like "*GOLD*" -or $up -like "*SILVER*" -or $up -like "*BRONZE*" -or $ti -like "*Win Back*") { return $ti.Trim() }
    return "House-2026"
}

$sgHouse = @('house','home','house 2013','house  2013','house 13','house 2015','shelby','shebly','solo','brian egan','shannon lundrigan','leslie creamer','april balsley','april balcley','dennis kisiel','mike roberts','christine myers','ken baker','ken','christy peterson','kanelle','northwest embroidery','outside sales','gold','kent')
$sgDead = @('dead','dead account','d','out of business 6-147-22')

function Clean-SalesGroup([string]$sg) {
    if ([string]::IsNullOrWhiteSpace($sg)) { return "" }
    $t = $sg.Trim(); $lo = $t.ToLower()
    if ($sgDead -contains $lo) { return "DEAD" }
    if ($sgHouse -contains $lo) { return "House" }
    if ($lo -eq "jim mickelson") { return "House" }
    if ($lo -eq "erik mickelson") { return "Erik Mickelson" }
    if ($lo -eq "nika" -or $lo -eq "nika lao") { return "Nika Lao" }
    if ($lo -eq "ruth" -or $lo -eq "ruth nhoung" -or $lo -eq "ruthie nhoung") { return "Ruthie Nhoung" }
    if ($lo -eq "taneisha clark") { return "Taneisha Clark" }
    if ($lo -match "^contract") { return "Ruthie Nhoung" }
    if ($lo -eq "employees") { return "Employee" }
    return $t
}

function FmtDate([string]$d) {
    if ([string]::IsNullOrWhiteSpace($d)) { return "" }
    $d = StripNull $d
    try { return ([DateTime]::Parse($d)).ToString("M/d/yyyy") } catch { return $d }
}

try {
    if ((Test-Path $LogPath) -and ((Get-Item $LogPath).Length -gt 1MB)) { Set-Content -Path $LogPath -Value (Get-Content $LogPath -Tail 200) -Encoding UTF8 }
    Log "===== sync started ====="

    $cfg = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $headers = @{ 'x-crm-api-secret' = $cfg.CrmApiSecret }
    $uri = "$($cfg.ProxyBase)/api/shopworks-odbc/sync-contacts"
    $connString = "DSN=$($cfg.Dsn);UID=extro;PWD=extro"

    # ---- 4-table ODBC read (verbatim queries from the CSV export) ----
    Log "Loading Contacts..."
    $c1 = New-Object System.Data.Odbc.OdbcConnection($connString); $c1.Open()
    $cmd1 = New-Object System.Data.Odbc.OdbcCommand("SELECT ID_Contact, ct_NameFull, id_Customer, date_Creation, Title, Department, Email_Primary FROM Contacts", $c1)
    $cmd1.CommandTimeout = 300; $a1 = New-Object System.Data.Odbc.OdbcDataAdapter($cmd1)
    $tblCon = New-Object System.Data.DataTable; [void]$a1.Fill($tblCon)
    $cmd1.Dispose(); $a1.Dispose(); $c1.Close(); $c1.Dispose()
    Log "Contacts: $($tblCon.Rows.Count)"

    Log "Loading Addresses..."
    $c2 = New-Object System.Data.Odbc.OdbcConnection($connString); $c2.Open()
    $cmd2 = New-Object System.Data.Odbc.OdbcCommand("SELECT id_Customer, AddressCompany, Address1, Address2, AddressCity, AddressState, AddressZip FROM Addr", $c2)
    $cmd2.CommandTimeout = 300; $a2 = New-Object System.Data.Odbc.OdbcDataAdapter($cmd2)
    $tblAd = New-Object System.Data.DataTable; [void]$a2.Fill($tblAd)
    $cmd2.Dispose(); $a2.Dispose(); $c2.Close(); $c2.Dispose()
    Log "Addresses: $($tblAd.Rows.Count)"

    Log "Loading Emails/Phones..."
    $c3 = New-Object System.Data.Odbc.OdbcConnection($connString); $c3.Open()
    $cmd3 = New-Object System.Data.Odbc.OdbcCommand("SELECT id_Contact, Email, ""Number"", sts_Phone, sts_Fax, sts_Primary, ""Label"" FROM ContactNumbers", $c3)
    $cmd3.CommandTimeout = 300; $a3 = New-Object System.Data.Odbc.OdbcDataAdapter($cmd3)
    $tblEm = New-Object System.Data.DataTable; [void]$a3.Fill($tblEm)
    $cmd3.Dispose(); $a3.Dispose(); $c3.Close(); $c3.Dispose()
    Log "ContactNumbers: $($tblEm.Rows.Count)"

    Log "Loading Customers..."
    $c4 = New-Object System.Data.Odbc.OdbcConnection($connString); $c4.Open()
    $cmd4 = New-Object System.Data.Odbc.OdbcCommand("SELECT ID_Customer, Terms, CustomerType, sts_Active, CustomerServiceRep, date_LastOrdered, CustomField01, SalesGroup, PhoneMain, EmailMain, cur_TotalYearSales1, TaxExemptNumber, sts_TaxExempt, WebsiteURL, n_EmployeeCount, CustomerWarning, HoldMessage FROM Cust", $c4)
    $cmd4.CommandTimeout = 300; $a4 = New-Object System.Data.Odbc.OdbcDataAdapter($cmd4)
    $tblCu = New-Object System.Data.DataTable; [void]$a4.Fill($tblCu)
    $cmd4.Dispose(); $a4.Dispose(); $c4.Close(); $c4.Dispose()
    Log "Customers: $($tblCu.Rows.Count)"

    # ---- lookups ----
    $adH = @{}
    for ($i = 0; $i -lt $tblAd.Rows.Count; $i++) {
        $r = $tblAd.Rows[$i]; $k = (StripNull (GF $r "id_Customer")).Trim()
        if ($k -ne "" -and -not $adH.ContainsKey($k)) {
            $adH[$k] = @{ Co=(StripNull (GF $r "AddressCompany")).Trim(); Ad=(StripNull (GF $r "Address1")).Trim(); Ad2=(StripNull (GF $r "Address2")).Trim(); Ci=(StripNull (GF $r "AddressCity")).Trim(); St=(StripNull (GF $r "AddressState")).Trim(); Zi=(StripNull (GF $r "AddressZip")).Trim() }
        }
    }
    $tblAd = $null; [GC]::Collect(); Log "Addr lookup: $($adH.Count)"

    $emH = @{}; $phH = @{}; $phPrim = @{}
    for ($i = 0; $i -lt $tblEm.Rows.Count; $i++) {
        $r = $tblEm.Rows[$i]; $k = (StripNull (GF $r "id_Contact")).Trim()
        if ($k -eq "") { continue }
        $v = (StripNull (GF $r "Email")).Trim().ToLower()
        if ($v -match "@" -and $v -notmatch '\s' -and $v.IndexOf('@') -eq $v.LastIndexOf('@') -and -not $emH.ContainsKey($k)) { $emH[$k] = $v }
        $num = (StripNull (GF $r "Number")).Trim()
        if ($num -ne "" -and (Flag (GF $r "sts_Phone")) -and -not (Flag (GF $r "sts_Fax"))) {
            $isPrim = Flag (GF $r "sts_Primary")
            if (-not $phH.ContainsKey($k)) { $phH[$k] = $num; $phPrim[$k] = $isPrim }
            elseif ($isPrim -and -not $phPrim[$k]) { $phH[$k] = $num; $phPrim[$k] = $isPrim }
        }
    }
    $tblEm = $null; [GC]::Collect(); Log "Email lookup: $($emH.Count); Phone lookup: $($phH.Count)"

    $cuH = @{}
    for ($i = 0; $i -lt $tblCu.Rows.Count; $i++) {
        $r = $tblCu.Rows[$i]; $k = (StripNull (GF $r "ID_Customer")).Trim()
        if ($k -ne "") {
            $cuH[$k] = @{ Te=(StripNull (GF $r "Terms")).Trim(); Ty=(StripNull (GF $r "CustomerType")).Trim(); Ac=StripNull (GF $r "sts_Active"); Re=(StripNull (GF $r "CustomerServiceRep")).Trim(); Lo=StripNull (GF $r "date_LastOrdered"); Ti=(StripNull (GF $r "CustomField01")).Trim(); Sg=(StripNull (GF $r "SalesGroup")).Trim(); Ph=(StripNull (GF $r "PhoneMain")).Trim(); Em=(StripNull (GF $r "EmailMain")).Trim(); Ys=(StripNull (GF $r "cur_TotalYearSales1")).Trim(); Tx=(StripNull (GF $r "TaxExemptNumber")).Trim(); TxF=(GF $r "sts_TaxExempt"); Web=(StripNull (GF $r "WebsiteURL")).Trim(); Emp=(StripNull (GF $r "n_EmployeeCount")).Trim(); Warn=(StripNull (GF $r "CustomerWarning")).Trim(); Hold=(StripNull (GF $r "HoldMessage")).Trim() }
        }
    }
    $tblCu = $null; [GC]::Collect(); Log "Cust lookup: $($cuH.Count)"

    # ---- process + build rows (verbatim logic; output whitelisted fields) ----
    Log "Processing..."
    $all = New-Object System.Collections.ArrayList
    $newHash = @{}
    $seen = @{}; $kept = 0; $skip = 0

    for ($i = 0; $i -lt $tblCon.Rows.Count; $i++) {
        $r = $tblCon.Rows[$i]
        $conId = (StripNull (GF $r "ID_Contact")).Trim()
        $nm = (StripNull (GF $r "ct_NameFull")).Trim()
        $cusId = (StripNull (GF $r "id_Customer")).Trim()
        $dtCr = StripNull (GF $r "date_Creation")
        $title = (StripNull (GF $r "Title")).Trim()
        $dept = (StripNull (GF $r "Department")).Trim()
        $emPri = (StripNull (GF $r "Email_Primary")).Trim().ToLower()

        if ($nm -eq "" -or $cusId -eq "") { $skip++; continue }
        if ($seen.ContainsKey($conId)) { $skip++; continue }
        $seen[$conId] = 1

        $nm = Fix-Name $nm
        if ($nm -eq "") { $skip++; continue }
        $title = Fix-Title $title
        $dept = if ([string]::IsNullOrWhiteSpace($dept)) { "" } else { (Get-Culture).TextInfo.ToTitleCase($dept.ToLower()) }

        $fn = $nm; $ln = ""
        $sp = $nm.IndexOf(' ')
        if ($sp -gt 0) { $fn = $nm.Substring(0, $sp); $ln = $nm.Substring($sp + 1) }

        $co=""; $ad=""; $ad2=""; $ci=""; $st=""; $zi=""
        if ($adH.ContainsKey($cusId)) {
            $ax = $adH[$cusId]; $co = Fix-Company $ax.Co; $ad = Fix-Address $ax.Ad; $ad2 = Fix-Address $ax.Ad2
            $ci = Fix-City $ax.Ci; $st = Fix-State $ax.St; $zi = Fix-Zip $ax.Zi
            if ($ad -eq "" -and $ad2 -ne "") { $ad = $ad2; $ad2 = "" }
        }

        $em = ""; if ($emH.ContainsKey($conId)) { $em = $emH[$conId] }
        if ($em -eq "" -and $emPri -match "@" -and $emPri -notmatch '\s' -and $emPri.IndexOf('@') -eq $emPri.LastIndexOf('@')) { $em = $emPri }

        $ph = ""; if ($phH.ContainsKey($conId)) { $ph = Fix-Phone $phH[$conId] }

        $trm=""; $cty="Uncategorized"; $act="0"; $srp="House"; $lor=""; $tier="House-2026"; $sg=""; $coPh=""; $coEm=""; $yrSales=""
        $taxNum=""; $taxEx=0; $web=""; $emp=""; $warn=""; $hold=""
        if ($cuH.ContainsKey($cusId)) {
            $cx = $cuH[$cusId]; $trm = Clean-Terms $cx.Te; $cty = Clean-CustomerType $cx.Ty; $act = $cx.Ac
            $srp = Clean-SalesRep $cx.Re; $lor = $cx.Lo; $tier = Clean-Tier $cx.Ti; $sg = Clean-SalesGroup $cx.Sg
            $coPh = $cx.Ph; $coEm = if ($cx.Em -ne "") { $cx.Em.ToLower() } else { "" }; $yrSales = $cx.Ys
            $taxNum = $cx.Tx; $taxEx = if (Flag $cx.TxF) { 1 } else { 0 }; $web = Fix-Web $cx.Web
            $emp = Fix-Emp $cx.Emp; $warn = $cx.Warn; $hold = $cx.Hold
        }

        $acctOwner = $srp; $repEmail = Get-RepEmail $srp

        if ($co -ne "") { $coLo = $co.ToLower(); if ($coLo -match "sample account|delete" -or $coLo -eq "test") { $skip++; continue } }

        $fDt = FmtDate $dtCr; $fLo = FmtDate $lor

        $fAct = if ($act -eq "1") { 1 } else { 0 }
        $fDead = if ($cty -eq "DEAD" -or $srp -eq "DEAD") { 1 } else { 0 }
        if ($fDead -eq 1) { $fAct = 0 }
        $fInd = 0; if ($nm -ne "" -and $co -ne "" -and $nm.ToLower() -eq $co.ToLower()) { $fInd = 1 }
        $fEm = if ($em -eq "") { 0 } else { 1 }
        $fAd = 0; if ($ad -ne "" -and $ci -ne "" -and $st -ne "" -and $zi -ne "") { $fAd = 1 }
        $fSt = 0
        if ($fAct -eq 1) { if ($fLo -eq "") { $fSt = 1 } else { try { if ([DateTime]::Parse($fLo) -lt [DateTime]::Parse("1/1/2024")) { $fSt = 1 } } catch {} } }
        $fRv = 0
        if ($nm -match '[0-9@#$%&*]') { $fRv = 1 }
        if ($nm.ToLower() -match 'faker|sample|^test$|test ') { $fRv = 1 }
        if ($ln -eq "") { $fRv = 1 }
        if ($nm.ToLower() -match 'office|department|dept|corporate|front desk') { $fRv = 1 }
        if ($nm -match '@') { $fRv = 1 }

        $activeFlag = if ($fDead -eq 1) { "0" } else { $act }

        # Whitelisted fields only (proxy ignores anything else; the table lacks
        # Phone / Employee_Count / Hold_Message so they are intentionally omitted).
        $row = [ordered]@{
            id_Customer=$cusId; CustomerCompanyName=$co; ID_Contact=$conId; NameFirst=$fn; NameLast=$ln
            ct_NameFull=$nm; ContactNumbersEmail=$em; CustomerCustomerServiceRep=$srp; Account_Owner=$acctOwner
            Email_Salesrep=$repEmail; DateLastOrderEmail=""; Address=$ad; City=$ci; State=$st; Zip=$zi
            CustTerms=$trm; Title=$title; Department=$dept; Email=$em; Company_Name=$co; Company_Phone=$coPh
            Company_Email=$coEm; Customer_Type=$cty; Sales_Group=$sg; Sales_Rep=$srp; Account_Tier=$tier
            YTD_Sales=$yrSales; Last_Order_Date=$fLo; Address2=$ad2; Contact_Created=$fDt; Payment_Terms=$trm
            Tax_Exempt_Number=$taxNum; Is_Tax_Exempt=$taxEx; Website=$web
            Customer_Warning=$warn
            Active_Flag=$activeFlag; Is_Active=$fAct; Is_Dead=$fDead; Is_Individual=$fInd
            Has_Email=$fEm; Has_Complete_Address=$fAd; Is_Stale=$fSt; Needs_Review=$fRv
        }
        [void]$all.Add($row)
        $newHash[[string]$conId] = (($row.Values | ForEach-Object { "$_" }) -join '|')

        $kept++
        if ($kept % 10000 -eq 0) { Log "Processed $kept..." }
    }
    $tblCon = $null; [GC]::Collect()
    Log "Built $kept rows, $skip filtered"

    if ($CsvOut) {
        ($all | ForEach-Object { [pscustomobject]$_ }) | Export-Csv -Path $CsvOut -NoTypeInformation -Encoding UTF8
        Log "CSV written: $CsvOut ($($all.Count) rows)"
        exit 0
    }

    # ---- snapshot delta + chunked POST ----
    $confirmed = @{}
    if (Test-Path $SnapshotPath) {
        try { (Get-Content $SnapshotPath -Raw -Encoding UTF8 | ConvertFrom-Json).psobject.Properties | ForEach-Object { $confirmed[$_.Name] = $_.Value } } catch { Log 'snapshot unreadable - treating as first run' }
    }
    $pending = @($all | Where-Object { $k = [string]$_.ID_Contact; -not $confirmed.ContainsKey($k) -or $confirmed[$k] -ne $newHash[$k] })
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
        foreach ($row in $all) { $seed[[string]$row.ID_Contact] = $newHash[[string]$row.ID_Contact] }
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
        foreach ($row in $chunk) { $k = [string]$row.ID_Contact; if (-not $erroredIds.ContainsKey($k)) { $confirmed[$k] = $newHash[$k] } }
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
