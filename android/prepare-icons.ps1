$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$resourceRoot = Join-Path $PSScriptRoot 'app\src\main\res'
$source = [Drawing.Image]::FromFile((Join-Path $PSScriptRoot 'branding\app-icon.png'))
try {
    $exports = @{
        'mipmap-mdpi' = 48
        'mipmap-hdpi' = 72
        'mipmap-xhdpi' = 96
        'mipmap-xxhdpi' = 144
        'mipmap-xxxhdpi' = 192
        'drawable-nodpi' = 432
    }
    foreach ($entry in $exports.GetEnumerator()) {
        $directory = Join-Path $resourceRoot $entry.Key
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
        $name = if ($entry.Key -eq 'drawable-nodpi') { 'launcher_logo.png' } else { 'ic_launcher.png' }
        $bitmap = New-Object Drawing.Bitmap($entry.Value, $entry.Value)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.Clear([Drawing.Color]::Black)
            $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.DrawImage($source, 0, 0, $entry.Value, $entry.Value)
            $bitmap.Save((Join-Path $directory $name), [Drawing.Imaging.ImageFormat]::Png)
        } finally { $graphics.Dispose(); $bitmap.Dispose() }
    }
} finally { $source.Dispose() }
Write-Output 'Exported launcher icons from the supplied logo.'
