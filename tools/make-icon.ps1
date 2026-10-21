# Generates src/app.ico: a stack of two photos on a red rounded tile.
#
#   powershell -ExecutionPolicy Bypass -File tools\make-icon.ps1
#
# Small sizes are written as 32-bpp DIB frames and 256 as a PNG frame, which
# is what Windows expects from a multi-size icon.

param(
    [string]$Output = (Join-Path $PSScriptRoot '..\src\app.ico')
)

Add-Type -AssemblyName System.Drawing

function New-Artwork([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $s = [double]$size

    # Tile ------------------------------------------------------------------
    $inset = $s * 0.03
    $tile = New-Object System.Drawing.RectangleF($inset, $inset, ($s - 2 * $inset), ($s - 2 * $inset))
    $radius = $s * 0.22
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $path.AddArc($tile.X, $tile.Y, $d, $d, 180, 90)
    $path.AddArc($tile.Right - $d, $tile.Y, $d, $d, 270, 90)
    $path.AddArc($tile.Right - $d, $tile.Bottom - $d, $d, $d, 0, 90)
    $path.AddArc($tile.X, $tile.Bottom - $d, $d, $d, 90, 90)
    $path.CloseFigure()

    # The tile is PepperSnap's red, so the two apps sit together in a taskbar:
    # the same warm gradient, with the artwork in white.
    $tileBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $tile,
        [System.Drawing.Color]::FromArgb(255, 238, 67, 67),
        [System.Drawing.Color]::FromArgb(255, 230, 59, 59),
        90.0)
    $g.FillPath($tileBrush, $path)

    # Two photos, side by side with a gap ------------------------------------
    $gap = $s * 0.075
    $pad = $s * 0.19
    $photoW = ($s - 2 * $pad - $gap) / 2
    $photoH = $s - 2 * $pad
    $photoRadius = $s * 0.055

    function Add-RoundedRect($g, $rect, $radius, $color) {
        $p = New-Object System.Drawing.Drawing2D.GraphicsPath
        $dd = $radius * 2
        $p.AddArc($rect.X, $rect.Y, $dd, $dd, 180, 90)
        $p.AddArc($rect.Right - $dd, $rect.Y, $dd, $dd, 270, 90)
        $p.AddArc($rect.Right - $dd, $rect.Bottom - $dd, $dd, $dd, 0, 90)
        $p.AddArc($rect.X, $rect.Bottom - $dd, $dd, $dd, 90, 90)
        $p.CloseFigure()
        $b = New-Object System.Drawing.SolidBrush($color)
        $g.FillPath($b, $p)
        $b.Dispose(); $p.Dispose()
    }

    $left = New-Object System.Drawing.RectangleF($pad, $pad, $photoW, $photoH)
    $right = New-Object System.Drawing.RectangleF(($pad + $photoW + $gap), $pad, $photoW, $photoH)

    # One solid photo and one paler one, so the pair still reads as a stack on
    # a tile that is now as bright as the pictures.
    Add-RoundedRect $g $left  $photoRadius ([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
    Add-RoundedRect $g $right $photoRadius ([System.Drawing.Color]::FromArgb(150, 255, 255, 255))

    $g.Dispose(); $tileBrush.Dispose(); $path.Dispose()
    return $bmp
}

function Get-PngBytes([System.Drawing.Bitmap]$bmp) {
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
    $ms.Dispose()
    return $bytes
}

function Get-DibBytes([System.Drawing.Bitmap]$bmp) {
    $w = $bmp.Width
    $h = $bmp.Height
    $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
                          [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $stride = $data.Stride
    $pixels = New-Object byte[] ($stride * $h)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $pixels, 0, $pixels.Length)
    $bmp.UnlockBits($data)

    $maskStride = [int](([math]::Floor(($w + 31) / 32)) * 4)
    $xorSize = $w * 4 * $h
    $andSize = $maskStride * $h
    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)

    # BITMAPINFOHEADER; height is doubled because of the AND mask.
    $bw.Write([int32]40); $bw.Write([int32]$w); $bw.Write([int32]($h * 2))
    $bw.Write([int16]1); $bw.Write([int16]32); $bw.Write([int32]0)
    $bw.Write([int32]($xorSize + $andSize))
    $bw.Write([int32]0); $bw.Write([int32]0); $bw.Write([int32]0); $bw.Write([int32]0)

    for ($y = $h - 1; $y -ge 0; $y--) {
        $row = $y * $stride
        for ($x = 0; $x -lt $w; $x++) {
            $i = $row + $x * 4
            $bw.Write([byte]$pixels[$i + 0])
            $bw.Write([byte]$pixels[$i + 1])
            $bw.Write([byte]$pixels[$i + 2])
            $bw.Write([byte]$pixels[$i + 3])
        }
    }
    $bw.Write((New-Object byte[] $andSize))

    $bw.Flush()
    $bytes = $ms.ToArray()
    $bw.Dispose(); $ms.Dispose()
    return $bytes
}

$sizes = @(16, 24, 32, 48, 64, 128)
$frames = New-Object System.Collections.Generic.List[object]
foreach ($size in $sizes) {
    $big = New-Artwork ($size * 4)
    $small = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $sg = [System.Drawing.Graphics]::FromImage($small)
    $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $sg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $sg.Clear([System.Drawing.Color]::Transparent)
    $sg.DrawImage($big, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)),
                  (New-Object System.Drawing.Rectangle(0, 0, $big.Width, $big.Height)),
                  [System.Drawing.GraphicsUnit]::Pixel)
    $sg.Dispose(); $big.Dispose()

    $frames.Add(@{ Size = $size; Bytes = [byte[]](Get-DibBytes $small); BitCount = 32 })
    $small.Dispose()
}

$pngBmp = New-Artwork 256
$frames.Add(@{ Size = 256; Bytes = [byte[]](Get-PngBytes $pngBmp); BitCount = 32 })

# Keep a preview of the large rendering for the README.
$preview = New-Artwork 256
$docs = Join-Path (Split-Path $PSScriptRoot -Parent) 'docs'
New-Item -ItemType Directory -Force -Path $docs | Out-Null
$preview.Save((Join-Path $docs 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$preview.Dispose(); $pngBmp.Dispose()

$parent = Join-Path (Split-Path $PSScriptRoot -Parent) 'src'
New-Item -ItemType Directory -Force -Path $parent | Out-Null
$full = Join-Path $parent (Split-Path $Output -Leaf)

$stream = [System.IO.File]::Create($full)
$bw = New-Object System.IO.BinaryWriter($stream)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$frames.Count)

$offset = 6 + 16 * $frames.Count
foreach ($frame in $frames) {
    $dim = if ($frame.Size -ge 256) { 0 } else { $frame.Size }
    $bw.Write([byte]$dim); $bw.Write([byte]$dim)
    $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]$frame.BitCount)
    $bw.Write([uint32]$frame.Bytes.Length)
    $bw.Write([uint32]$offset)
    $offset += $frame.Bytes.Length
}
foreach ($frame in $frames) {
    $bytes = [byte[]]$frame.Bytes
    $bw.Write($bytes, 0, $bytes.Length)
}
$bw.Flush()
$stream.Flush($true)
$bw.Dispose(); $stream.Dispose()

# Read it back: a malformed icon must not make it into the executable.
$icon = New-Object System.Drawing.Icon($full)
$check = Join-Path $env:TEMP 'ps-icon-check.ico'
[System.IO.File]::WriteAllBytes($check, [System.IO.File]::ReadAllBytes($full))
$bytes = [System.IO.File]::ReadAllBytes($full)
"Wrote $full ($([math]::Round($bytes.Length / 1KB, 1)) KB, $($frames.Count) frames, main frame $($icon.Width)x$($icon.Height))"
$icon.Dispose()
