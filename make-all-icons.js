const fs = require('fs');
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
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

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
  const compressed = require('zlib').deflateSync(Buffer.from(raw), { level: 9 });

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crcVal = crc32(td);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crcVal >>> 0);
    return Buffer.concat([len, td, crcBuf]);
  }

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}

const genDir = path.join(__dirname, 'gen-assets');
if (!fs.existsSync(genDir)) fs.mkdirSync(genDir, { recursive: true });

const sizes = [16, 32, 48, 64, 128, 256];
for (const size of sizes) {
  const png = createPNG(size);
  fs.writeFileSync(path.join(genDir, `icon${size}.plasmo.png`), png);
  console.log(`gen-assets/icon${size}.plasmo.png (${png.length} bytes)`);
}

const assetsDir = path.join(__dirname);
for (const size of sizes) {
  const png = createPNG(size);
  fs.writeFileSync(path.join(assetsDir, `icon${size}.png`), png);
  console.log(`assets/icon${size}.png (${png.length} bytes)`);
}

console.log('DONE!');
