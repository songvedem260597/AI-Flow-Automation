Add-Type -AssemblyName System.Drawing

$assetsDir = "C:\Users\uchih\Desktop\ai-workflow-automation\assets"

# Clean old files
Remove-Item "$assetsDir\*.png" -Force -ErrorAction SilentlyContinue

$sizes = @(16, 32, 48, 128)

foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    
    # Purple gradient
    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.Point(0, 0)),
        (New-Object System.Drawing.Point($size, $size)),
        [System.Drawing.Color]::FromArgb(124, 92, 246),
        [System.Drawing.Color]::FromArgb(236, 72, 153)
    )
    $g.FillRectangle($brush, $rect)
    
    # White AF text
    $fontSize = [Math]::Max(6, [int]($size * 0.35))
    $font = New-Object System.Drawing.Font("Arial", $fontSize, [System.Drawing.FontStyle]::Bold)
    $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $textRect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
    $g.DrawString("AF", $font, $textBrush, $textRect, $sf)
    
    $filename = Join-Path $assetsDir "icon$size.png"
    $bmp.Save($filename, [System.Drawing.Imaging.ImageFormat]::Png)
    
    $g.Dispose()
    $bmp.Dispose()
    $brush.Dispose()
    $font.Dispose()
    $textBrush.Dispose()
    
    $fileInfo = Get-Item $filename
    Write-Host "Created: icon$size.png ($($fileInfo.Length) bytes)" -ForegroundColor Green
}

Write-Host ""
Write-Host "All icons created successfully!" -ForegroundColor Cyan

# List all PNG files
Write-Host ""
Write-Host "Verifying:" -ForegroundColor Yellow
Get-ChildItem "$assetsDir\*.png" | Format-Table Name, Length -AutoSize
