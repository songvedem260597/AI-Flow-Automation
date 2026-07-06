/**
 * Resize the source icon PNG into the standard Chromium MV3 icon sizes.
 * Reads from `assets/icon-source.png`, writes icon{16,32,48,64,128}.png.
 *
 * Usage: node assets/build-icons-from-source.js [sourcePath]
 *   default sourcePath: assets/icon-source.png
 *
 * Requires `sharp` (already in the Plasmo transitive dependency tree).
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SOURCE = path.resolve(process.argv[2] || path.join(__dirname, 'icon-source.png'));
const SIZES = [16, 32, 48, 64, 128];

if (!fs.existsSync(SOURCE)) {
  console.error(`Source image not found: ${SOURCE}`);
  process.exit(1);
}

(async () => {
  for (const size of SIZES) {
    const out = path.join(__dirname, `icon${size}.png`);
    await sharp(SOURCE)
      .resize(size, size, { fit: 'cover', kernel: 'lanczos3' })
      .png({ compressionLevel: 9 })
      .toFile(out);
    const stat = fs.statSync(out);
    console.log(`Created ${path.relative(process.cwd(), out)} (${stat.size} bytes)`);
  }
  console.log('All icons created.');
})().catch((err) => {
  console.error('Failed to build icons:', err);
  process.exit(1);
});