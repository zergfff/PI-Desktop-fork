param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = "Stop"
$ext = [System.IO.Path]::GetExtension($In).ToLowerInvariant()

try {
  if ($ext -in @(".docx", ".doc", ".rtf", ".odt")) {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    try {
      $doc = $word.Documents.Open($In, $false, $true)
      try {
        # 17 = wdExportFormatPDF
        $doc.ExportAsFixedFormat($Out, 17)
      } finally {
        $doc.Close($false)
      }
    } finally {
      $word.Quit()
      [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
    }
  }
  elseif ($ext -in @(".pptx", ".ppt")) {
    $ppt = New-Object -ComObject PowerPoint.Application
    try {
      $pres = $ppt.Presentations.Open($In, $true, $false, $false)
      try {
        # 32 = ppSaveAsPDF
        $pres.SaveAs($Out, 32)
      } finally {
        $pres.Close()
      }
    } finally {
      $ppt.Quit()
      [System.Runtime.InteropServices.Marshal]::ReleaseComObject($ppt) | Out-Null
    }
  }
  elseif ($ext -in @(".xlsx", ".xls", ".csv")) {
    $excel = New-Object -ComObject Excel.Application
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    try {
      $wb = $excel.Workbooks.Open($In, 0, $true)
      try {
        # 0 = xlTypePDF
        $wb.ExportAsFixedFormat(0, $Out)
      } finally {
        $wb.Close($false)
      }
    } finally {
      $excel.Quit()
      [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
    }
  }
  else {
    Write-Error "unsupported extension: $ext"
    exit 2
  }
  if (Test-Path $Out) { Write-Output "OK $((Get-Item $Out).Length)" } else { Write-Error "no output" ; exit 3 }
}
catch {
  Write-Output ("FAIL " + $_.Exception.Message)
  exit 1
}
