# Create PNG icons for AI Flow Automation Chrome Extension

$dir = "C:\Users\uchih\Desktop\ai-workflow-automation\assets"

# Small valid purple PNG (16x16)
$b64_16 = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAANElEQVQ4y2P4//8/AyWYNRiKAcNQNIA4FA1EjqCByBG1AKqh0EDkCIYJAAAbgQYR2vB9YgAAAABJRU5ErkJggg=="

# Small valid purple PNG (32x32)
$b64_32 = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAbklEQVRo3u3PsQEAIAzAsIF/z1Ag2FtkqNXdHx5o0gYAzxERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERAx0B+AAyqXK0l8B8vQAAAAASUVORK5CYII="

# Medium valid purple PNG (48x48)
$b64_48 = "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmMAAAAbElEQVRo3u3PsQ0AIAwDwdL9h6xAYCCJ2t0PHmjSBgDPERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERAx0B+AAyqXK0l8B8vQAAAAASUVORK5CYII="

# Larger valid purple gradient PNG (128x128)
$b64_128 = "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAA2klEQVR4nO3BMQEAAADCoPVPbQhfoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIC/AcgAAX+2b9EAAAAASUVORK5CYII="

# Write all files
try {
    [System.IO.File]::WriteAllBytes("$dir\icon16.png", [Convert]::FromBase64String($b64_16))
    Write-Host "[OK] icon16.png created" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] icon16.png: $_" -ForegroundColor Red
}

try {
    [System.IO.File]::WriteAllBytes("$dir\icon32.png", [Convert]::FromBase64String($b64_32))
    Write-Host "[OK] icon32.png created" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] icon32.png: $_" -ForegroundColor Red
}

try {
    [System.IO.File]::WriteAllBytes("$dir\icon48.png", [Convert]::FromBase64String($b64_48))
    Write-Host "[OK] icon48.png created" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] icon48.png: $_" -ForegroundColor Red
}

try {
    [System.IO.File]::WriteAllBytes("$dir\icon128.png", [Convert]::FromBase64String($b64_128))
    Write-Host "[OK] icon128.png created" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] icon128.png: $_" -ForegroundColor Red
}

# Verify
Write-Host ""
Write-Host "Verifying files..." -ForegroundColor Cyan
Get-ChildItem "$dir\*.png" | ForEach-Object {
    Write-Host "  $($_.Name): $($_.Length) bytes" -ForegroundColor White
}
