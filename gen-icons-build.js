const fs = require('fs');
const zlib = require('zlib');
const { spawn } = require('child_process');

const tc = [];
for (let i = 0; i < 256; i++) {
  let v = 0xFFFFFFFF;
  for (let j = 0; j < 8; j++) v = (v >>> 1) ^ (v & 1 ? 0xEDB88320 : 0);
  tc[i] = v >>> 0;
}

function crc(d) {
  let r = 0xFFFFFFFF >>> 0;
  for (const b of d) r = (tc[(r ^ b) & 0xFF] ^ (r >>> 8)) >>> 0;
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
  function chk(t, d) {
    const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td) >>> 0);
    return Buffer.concat([l, td, cr]);
  }
  return Buffer.concat([sig, chk('IHDR', ihdr), chk('IDAT', comp), chk('IEND', Buffer.alloc(0))]);
}

const base = 'C:/Users/uchih/Desktop/ai-workflow-automation/.plasmo';
const genDir = base + '/gen-assets';
const sizes = [16, 32, 48, 64, 128];

// First, create the icons
if (fs.existsSync(genDir)) {
  fs.rmSync(genDir, { recursive: true, force: true });
}
fs.mkdirSync(genDir, { recursive: true });

for (const s of sizes) {
  fs.writeFileSync(genDir + '/icon' + s + '.plasmo.png', png(s));
  console.log('Created gen-assets/icon' + s + '.plasmo.png');
}

// Clear Plasmo cache
const cacheDir = base + '/cache';
if (fs.existsSync(cacheDir)) {
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir);
  console.log('Cache cleared');
}

// Fix manifest - remove content_scripts
const manifestPath = base + '/chrome-mv3.plasmo.manifest.json';
if (fs.existsSync(manifestPath)) {
  let content = fs.readFileSync(manifestPath, 'utf8');
  content = content.replace(/"content_scripts":\s*\[[\s\S]*?\]/g, '');
  content = content.replace(/,\s*,/g, ',');
  content = content.replace(/{\s*,/g, '{');
  content = content.replace(/,\s*}/g, '}');
  fs.writeFileSync(manifestPath, content);
  console.log('Manifest cleaned');
}

// Verify icons exist
for (const s of sizes) {
  const f = genDir + '/icon' + s + '.plasmo.png';
  if (fs.existsSync(f)) {
    console.log('Verified: ' + f + ' (' + fs.statSync(f).size + ' bytes)');
  } else {
    console.log('MISSING: ' + f);
  }
}

console.log('Starting Plasmo build...');

// Spawn plasmo build with continuous icon recreation
let buildDone = false;
let recreateCount = 0;

function recreateIcons() {
  if (buildDone) return;
  recreateCount++;
  for (const s of sizes) {
    fs.writeFileSync(genDir + '/icon' + s + '.plasmo.png', png(s));
  }
  setTimeout(recreateIcons, 500);
}

recreateIcons();

const plasmo = spawn('npx', ['plasmo', 'build'], {
  cwd: 'C:/Users/uchih/Desktop/ai-workflow-automation',
  shell: true,
  stdio: 'inherit'
});

plasmo.on('close', (code) => {
  buildDone = true;
  console.log('Plasmo build exited with code', code);
  console.log('Recreated icons', recreateCount, 'times during build');
  process.exit(code);
});
