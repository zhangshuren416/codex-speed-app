# 生成应用图标与托盘图标（Windows PowerShell / pwsh 均可，需要 System.Drawing）
# 用法：pwsh -File scripts/make-icons.ps1

param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function New-RoundedRectPath {
  param([float]$X, [float]$Y, [float]$W, [float]$H, [float]$R)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $R * 2
  $path.AddArc($X, $Y, $d, $d, 180, 90)
  $path.AddArc($X + $W - $d, $Y, $d, $d, 270, 90)
  $path.AddArc($X + $W - $d, $Y + $H - $d, $d, $d, 0, 90)
  $path.AddArc($X, $Y + $H - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function Draw-Bars {
  param(
    [System.Drawing.Graphics]$Graphics,
    [float]$Size,
    [System.Drawing.Color]$Color,
    [double[]]$Ratios = @(0.34, 0.52, 0.72)
  )
  $gap = $Size * 0.12
  $barW = $Size * 0.16
  $totalW = $barW * 3 + $gap * 2
  $x0 = ($Size - $totalW) / 2
  $baseY = $Size * 0.78
  $brush = New-Object System.Drawing.SolidBrush($Color)
  for ($i = 0; $i -lt 3; $i++) {
    $h = [float]($Size * $Ratios[$i])
    $x = [float]($x0 + $i * ($barW + $gap))
    $y = [float]($baseY - $h)
    $path = New-RoundedRectPath -X $x -Y $y -W $barW -H $h -R ($barW / 2)
    $Graphics.FillPath($brush, $path)
    $path.Dispose()
  }
  $brush.Dispose()
}

function New-Icon {
  param(
    [int]$Size,
    [string]$OutFile,
    [bool]$WithBackground,
    [System.Drawing.Color]$BarColor
  )
  $bitmap = New-Object System.Drawing.Bitmap($Size, $Size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)

  if ($WithBackground) {
    $pad = [float]($Size * 0.06)
    $radius = [float]($Size * 0.22)
    $bgPath = New-RoundedRectPath -X $pad -Y $pad -W ($Size - $pad * 2) -H ($Size - $pad * 2) -R $radius
    $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 16, 19, 26))
    $graphics.FillPath($bgBrush, $bgPath)
    $bgBrush.Dispose()

    $borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 40, 48, 62), [float][Math]::Max(1, $Size * 0.004))
    $graphics.DrawPath($borderPen, $bgPath)
    $borderPen.Dispose()
    $bgPath.Dispose()
  }

  Draw-Bars -Graphics $graphics -Size $Size -Color $BarColor
  $graphics.Dispose()

  $dir = Split-Path -Parent $OutFile
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  $bitmap.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
  Write-Host "wrote $OutFile"
}

$accent = [System.Drawing.Color]::FromArgb(255, 16, 163, 127)
$bright = [System.Drawing.Color]::FromArgb(255, 53, 214, 164)
$black = [System.Drawing.Color]::FromArgb(255, 0, 0, 0)

New-Icon -Size 512 -OutFile (Join-Path $Root 'build\icon.png') -WithBackground $true -BarColor $accent
New-Icon -Size 256 -OutFile (Join-Path $Root 'build\icon-256.png') -WithBackground $true -BarColor $accent
New-Icon -Size 256 -OutFile (Join-Path $Root 'assets\app.png') -WithBackground $true -BarColor $accent
New-Icon -Size 32 -OutFile (Join-Path $Root 'assets\tray.png') -WithBackground $false -BarColor $bright
New-Icon -Size 16 -OutFile (Join-Path $Root 'assets\trayTemplate.png') -WithBackground $false -BarColor $black
New-Icon -Size 32 -OutFile (Join-Path $Root 'assets\trayTemplate@2x.png') -WithBackground $false -BarColor $black