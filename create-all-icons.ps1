Add-Type -AssemblyName System.Drawing

$dir = "C:\Users\uchih\Desktop\ai-workflow-automation\assets"
$purple = [System.Drawing.Color]::FromArgb(124, 92, 246)
$white = [System.Drawing.Brushes]::White

# All sizes Plasmo might need
$sizes = @(16, 32, 48, 64, 128, 256)

foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    
    # Fill with purple
    $g.FillRectangle((New-Object System.Drawing.SolidBrush($purple)), 0, 0, $size, $size)
    
    # Draw AF text
    $fontSize = [Math]::Max(5, [int]($size * 0.4))
    $font = New-Object System.Drawing.Font("Arial", $fontSize, [System.Drawing.FontStyle]::Bold)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $rect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
    $g.DrawString("AF", $font, $white, $rect, $sf)
    
    $filename = "$dir\icon$size.png"
    $bmp.Save($filename, [System.Drawing.Imaging.ImageFormat]::Png)
    
    $g.Dispose()
    $bmp.Dispose()
    $font.Dispose()
    
    Write-Host "Created icon$size.png" -ForegroundColor Green
}

Write-Host ""
Write-Host "All icons created!" -ForegroundColor Cyan
Get-ChildItem "$dir\*.png" | Select-Object Name, Length
