const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Minimal valid PNG generator - creates proper PNG with correct CRC
function crc32(data) {
    let crc = 0xFFFFFFFF;
    const table = [];
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[i] = c >>> 0;
    }
    for (const byte of data) crc = (table[(crc ^ byte) & 0xFF] ^ (crc >>> 8)) >>> 0;
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function createPNG(size) {
    // Create RGBA pixel data - purple gradient
    const rawData = [];
    for (let y = 0; y < size; y++) {
        rawData.push(0); // filter byte
        for (let x = 0; x < size; x++) {
            const t = (x + y) / (size * 2);
            rawData.push(Math.round(124 + (236-124) * t)); // R
            rawData.push(Math.round(92 + (72-92) * t));   // G
            rawData.push(Math.round(246 + (153-246) * t)); // B
            rawData.push(255); // A
        }
    }
    
    const pixelData = Buffer.from(rawData);
    const compressed = zlib.deflateSync(pixelData, { level: 9 });
    
    function makeChunk(type, data) {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const typeData = Buffer.concat([Buffer.from(type), data]);
        const crcBuf = Buffer.alloc(4);
        crcBuf.writeUInt32BE(crc32(typeData));
        return Buffer.concat([len, typeData, crcBuf]);
    }
    
    // PNG signature
    const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    
    // IHDR chunk
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // RGBA
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace
    
    return Buffer.concat([
        sig,
        makeChunk('IHDR', ihdr),
        makeChunk('IDAT', compressed),
        makeChunk('IEND', Buffer.alloc(0))
    ]);
}

const assetsDir = __dirname;
const sizes = [16, 32, 48, 128];

for (const size of sizes) {
    const png = createPNG(size);
    const filename = path.join(assetsDir, `icon${size}.png`);
    fs.writeFileSync(filename, png);
    console.log(`Created ${filename} (${png.length} bytes)`);
}
console.log('Done!');
