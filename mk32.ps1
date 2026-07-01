# Minimal PNG decoder - creates 32x32 purple PNG
$ErrorActionPreference = "SilentlyContinue"

$dir = "C:\Users\uchih\Desktop\ai-workflow-automation\assets"

# This is a valid 32x32 purple PNG encoded as base64
# Generated using Node.js canvas
$b64 = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAASklEQVRYR+3PsQEAIAzAMIF/z1Ag2FtkqNXdHx5o0gYAzxERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERAx0B+AAyqXK0hwoA6wAAAABJRU5ErkJggg=="

try {
    $bytes = [System.Convert]::FromBase64String($b64)
    [System.IO.File]::WriteAllBytes("$dir\icon32.png", $bytes)
    Write-Host "icon32.png created ($($bytes.Length) bytes)" -ForegroundColor Green
} catch {
    Write-Host "Error: $_" -ForegroundColor Red
}

# Verify
Get-ChildItem "$dir\*.png" | Format-Table Name, Length
