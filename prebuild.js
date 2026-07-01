const fs = require('fs');
const zlib = require('zlib');

function makeTable() {
  const t = [];
  for (let i = 0; i < 256; i++) {
    let v = 0xFFFFFFFF;
    for (let j = 0; j < 8; j++) v = (v >>> 1) ^ (v & 1 ? 0xEDB88320 : 0);
    t[i] = v >>> 0;
  }
  return t;
}

const table = makeTable();

function crc32(data) {
  let r = 0xFFFFFFFF >>> 0;
  for (const b of data) r = (table[(r ^ b) & 0xFF] ^ (r >>> 8)) >>> 0;
  return (r ^ 0xFFFFFFFF) >>> 0;
}

function png(s) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(s, 0);
  ihdr.writeUInt32BE(s, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const raw = [];
  for (let y = 0; y < s; y++) {
    raw.push(0);
    for (let x = 0; x < s; x++) {
      const t = (x + y) / (s * 2);
      raw.push(Math.round(124 + 112 * t));
      raw.push(Math.round(92 - 20 * t));
      raw.push(Math.round(246 - 93 * t));
    }
  }
  const comp = zlib.deflateSync(Buffer.from(raw), { level: 9 });

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeData = Buffer.concat([Buffer.from(type), data]);
    const crcVal = crc32(typeData);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crcVal >>> 0);
    return Buffer.concat([len, typeData, crcBuf]);
  }

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', comp), chunk('IEND', Buffer.alloc(0))]);
}

const baseDir = 'C:/Users/uchih/Desktop/ai-workflow-automation';
const plasmoDir = baseDir + '/.plasmo';
const genDir = plasmoDir + '/gen-assets';

// Create gen-assets inside .plasmo
if (!fs.existsSync(genDir)) {
  fs.mkdirSync(genDir, { recursive: true });
}

const sizes = [16, 32, 48, 64, 128];
for (const s of sizes) {
  const buf = png(s);
  fs.writeFileSync(genDir + '/icon' + s + '.plasmo.png', buf);
  console.log('Created .plasmo/gen-assets/icon' + s + '.plasmo.png (' + buf.length + ' bytes)');
}

console.log('Prebuild complete - icons ready!');
