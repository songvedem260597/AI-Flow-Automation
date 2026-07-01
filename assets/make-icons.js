const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

function crc32(data) {
  let crc = 0xFFFFFFFF >>> 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0) >>> 0;
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function createPNG(size) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = [];
  for (let y = 0; y < size; y++) {
    raw.push(0);
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (size * 2);
      raw.push(Math.round(124 + 112 * t));
      raw.push(Math.round(92 - 20 * t));
      raw.push(Math.round(246 - 93 * t));
    }
  }
  const compressed = zlib.deflateSync(Buffer.from(raw), { level: 9 });

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type), data]);
    const crcVal = crc32(typeAndData);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crcVal >>> 0);
    return Buffer.concat([len, typeAndData, crcBuf]);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const dir = path.join(__dirname);
const sizes = [16, 32, 48, 64, 128, 256];

for (const size of sizes) {
  const png = createPNG(size);
  const filePath = path.join(dir, `icon${size}.png`);
  fs.writeFileSync(filePath, png);
  console.log(`Created ${filePath} (${png.length} bytes)`);
}

console.log('All icons created!');
