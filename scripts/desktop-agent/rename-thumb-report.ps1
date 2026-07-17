# rename-thumb-report.ps1 — auto-produce the fixed-name Thumb.csv that Caspio's
# "Thumbnail_Import" task expects, from the dated "Thumbnails Report <date>.xlsx"
# that ShopWorks exports into the SWF folder.
#
# WHY: Caspio's scheduled import reads ONE fixed path (/SWF/Thumb.csv). Every
# ShopWorks export has a different dated name (and .xlsx). So today Erik renames/
# converts by hand. This script does it automatically so the only manual step
# left is the ShopWorks export click.
#
# WHERE: runs on the machine that hosts the SWF OneDrive folder (Erik's desktop),
# scheduled every 15-30 min via Task Scheduler, RUN AS ERIK (a logged-on user —
# Excel COM needs a desktop session; do NOT run as SYSTEM).
#
# Handles both export formats:
#   Thumbnails Report*.csv  -> copied straight to Thumb.csv (no conversion)
#   Thumbnails Report*.xlsx -> converted to CSV via Excel COM (Excel must be installed)
#
# Master copy: caspio-pricing-proxy/scripts/desktop-agent/ — edit HERE, recopy to the desktop.

param(
    [string]$SwfFolder  = "$env:USERPROFILE\OneDrive - Northwest Custom Apparel\SWF",
    [string]$TargetName = 'Thumb.csv'
)
$ErrorActionPreference = 'Stop'
$log = Join-Path $SwfFolder 'rename-thumb-report.log'
function Log($m){ $line = '{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $m; Add-Content -Path $log -Value $line -Encoding UTF8; Write-Output $line }

try {
    if ((Test-Path $log) -and ((Get-Item $log).Length -gt 512KB)) {
        Set-Content -Path $log -Value (Get-Content $log -Tail 150) -Encoding UTF8
    }
    if (-not (Test-Path $SwfFolder)) { Log "SWF folder not found: $SwfFolder"; exit 1 }
    $target = Join-Path $SwfFolder $TargetName

    # newest export matching the ShopWorks naming
    $src = Get-ChildItem -LiteralPath $SwfFolder -File |
           Where-Object { $_.Name -like 'Thumbnails Report*' -and ($_.Extension -eq '.xlsx' -or $_.Extension -eq '.xls' -or $_.Extension -eq '.csv') } |
           Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $src) { Log 'no "Thumbnails Report*" export found - nothing to do'; exit 0 }

    # skip if Thumb.csv already reflects this export (idempotent)
    if ((Test-Path $target) -and ((Get-Item $target).LastWriteTime -ge $src.LastWriteTime)) {
        Log ('up to date - Thumb.csv already newer than ' + $src.Name); exit 0
    }

    if ($src.Extension -eq '.csv') {
        Copy-Item -LiteralPath $src.FullName -Destination $target -Force
        Log ('copied ' + $src.Name + ' -> ' + $TargetName)
    } else {
        # xlsx/xls -> CSV via Excel COM (write to temp, then atomic move)
        $tmp = Join-Path $SwfFolder ('~tmp_' + $TargetName)
        $xl = New-Object -ComObject Excel.Application
        try {
            $xl.Visible = $false; $xl.DisplayAlerts = $false
            $wb = $xl.Workbooks.Open($src.FullName, 0, $true)   # read-only
            $wb.SaveAs($tmp, 6)                                 # 6 = xlCSV
            $wb.Close($false)
        } finally {
            $xl.Quit()
            [System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl) | Out-Null
        }
        Move-Item -LiteralPath $tmp -Destination $target -Force
        Log ('converted ' + $src.Name + ' -> ' + $TargetName)
    }
    exit 0
}
catch {
    Log ('FAILED: ' + $_.Exception.Message)
    exit 1
}
