# Create PNG icons using pure PowerShell with System.IO
# Each PNG is a small purple square

$assetsDir = "C:\Users\uchih\Desktop\ai-workflow-automation\assets"

function New-PNG {
    param([int]$Size)
    
    # PNG header
    $signature = [byte[]](137,80,78,71,13,10,26,10)
    
    # IHDR chunk
    $ihdrData = [System.IO.MemoryStream]::new()
    $bw = [System.IO.BinaryWriter]::new($ihdrData)
    $bw.Write([int32]($Size -shr 24 -band 0xFF))
    $bw.Write([int32]($Size -shr 16 -band 0xFF))
    $bw.Write([int32]($Size -shr 8 -band 0xFF))
    $bw.Write([int32]($Size -band 0xFF))
    $bw.Write([byte]8)  # bit depth
    $bw.Write([byte]2)  # RGB
    $bw.Write([byte]0)  # compression
    $bw.Write([byte]0)  # filter
    $bw.Write([byte]0)  # interlace
    $bw.Flush()
    $ihdrBytes = $ihdrData.ToArray()
    $bw.Dispose()
    $ihdrData.Dispose()
    
    # Build raw pixel data
    $raw = [System.Collections.Generic.List[byte]]::new()
    for ($y = 0; $y -lt $Size; $y++) {
        [void]$raw.Add(0)  # filter byte
        for ($x = 0; $x -lt $Size; $x++) {
            $t = ($x + $y) / ($Size * 2)
            [void]$raw.Add([byte](124 + [int](112 * $t)))  # R
            [void]$raw.Add([byte](92 + [int](-20 * $t)))   # G
            [void]$raw.Add([byte](246 + [int](-93 * $t))) # B
        }
    }
    
    # Compress with DeflateStream
    $ms = [System.IO.MemoryStream]::new()
    $ds = [System.IO.Compression.DeflateStream]::new($ms, [System.IO.Compression.CompressionMode]::Compress)
    $ds.Write($raw.ToArray(), 0, $raw.Count)
    $ds.Close()
    $compressed = $ms.ToArray()
    $ms.Dispose()
    
    # Create chunks
    function make-chunk {
        param($type, $data)
        $len = [byte[]]([int32]$data.Length -shr 24 -band 0xFF, ([int32]$data.Length -shr 16 -band 0xFF), ([int32]$data.Length -shr 8 -band 0xFF), [int32]$data.Length -band 0xFF)
        $typeBytes = [System.Text.Encoding]::ASCII.GetBytes($type)
        $crcInput = $typeBytes + $data
        $crc = [uint32]0xFFFFFFFF
        $table = [uint32[]]::new(256)
        for ($i = 0; $i -lt 256; $i++) { $c = $i; for ($j = 0; $j -lt 8; $j++) { if ($c -band 1) { $c = 0xEDB88320 -bxor ($c -shr 1) } else { $c = $c -shr 1 } }; $table[$i] = $c }
        foreach ($b in $crcInput) { $crc = $table[($crc -bxor $b) -band 0xFF] -bxor ($crc -shr 8) }
        $crc = $crc -bxor 0xFFFFFFFF
        $crcBytes = [byte[]]($crc -shr 24 -band 0xFF, $crc -shr 16 -band 0xFF, $crc -shr 8 -band 0xFF, $crc -band 0xFF)
        $chunk = $len + $typeBytes + $data + $crcBytes
        return [byte[]]$chunk
    }
    
    $ihdrChunk = make-chunk "IHDR" $ihdrBytes
    $idatChunk = make-chunk "IDAT" $compressed
    $iendChunk = make-chunk "IEND" ([byte[]]@())
    
    return $signature + $ihdrChunk + $idatChunk + $iendChunk
}

# Create all sizes
$sizes = @(16, 32, 48, 64, 128, 256)
foreach ($size in $sizes) {
    $png = New-PNG -Size $size
    $path = "$assetsDir\icon$size.png"
    [System.IO.File]::WriteAllBytes($path, $png)
    Write-Host "Created icon$size.png ($($png.Length) bytes)" -ForegroundColor Green
}

Write-Host ""
Write-Host "Done!" -ForegroundColor Cyan
Get-ChildItem "$assetsDir\*.png"
