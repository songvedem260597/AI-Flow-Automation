/**
 * prebuild.js — runs before `plasmo build` (and `plasmo dev`).
 *
 * Feeds Plasmo's expected icon slots (`.plasmo/gen-assets/icon*.plasmo.png`)
 * from the project's single source of truth: `assets/icon-source.png`.
 *
 * Pipeline:
 *   1. If `assets/icon-source.png` is present, run
 *      `node assets/build-icons-from-source.js` to (re)generate the
 *      `assets/icon{16,32,48,64,128}.png` resized variants via `sharp`.
 *   2. Copy each `assets/icon{16,32,48,64,128}.png` to the matching
 *      `.plasmo/gen-assets/icon{16,32,48,64,128}.plasmo.png` slot that
 *      Plasmo references from `.plasmo/chrome-mv3.plasmo.manifest.json`.
 *   3. If no source is available and the resized PNGs are also missing,
 *      fail with a clear error so the missing-artifact surface area is
 *      obvious (the old gradient placeholder generator has been removed).
 *
 * Paths are resolved from `__dirname` so this script works regardless of
 * the absolute location of the repo on disk.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = __dirname;
const assetsDir = path.join(repoRoot, 'assets');
const plasmoDir = path.join(repoRoot, '.plasmo');
const genDir = path.join(plasmoDir, 'gen-assets');
const sourcePng = path.join(assetsDir, 'icon-source.png');
const buildScript = path.join(assetsDir, 'build-icons-from-source.js');
const sizes = [16, 32, 48, 64, 128];

if (!fs.existsSync(genDir)) {
  fs.mkdirSync(genDir, { recursive: true });
}

const resizedExists = (size) =>
  fs.existsSync(path.join(assetsDir, `icon${size}.png`));

if (fs.existsSync(sourcePng)) {
  console.log(`[prebuild] Source icon found: ${path.relative(repoRoot, sourcePng)}`);
  if (!fs.existsSync(buildScript)) {
    console.error(`[prebuild] FATAL: ${path.relative(repoRoot, buildScript)} is missing.`);
    process.exit(1);
  }
  const result = spawnSync(process.execPath, [buildScript], {
    cwd: repoRoot,
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    console.error('[prebuild] FATAL: assets/build-icons-from-source.js failed.');
    process.exit(result.status ?? 1);
  }
} else {
  console.warn(`[prebuild] Source icon not found: ${path.relative(repoRoot, sourcePng)}`);
}

const missing = sizes.filter((s) => !resizedExists(s));
if (missing.length > 0) {
  console.error(
    `[prebuild] FATAL: missing resized icon(s) in assets/: ${missing
      .map((s) => `icon${s}.png`)
      .join(', ')}.`
  );
  console.error(
    '[prebuild] Add assets/icon-source.png (1024x1024 PNG) so the build pipeline can resize it.'
  );
  process.exit(1);
}

for (const size of sizes) {
  const src = path.join(assetsDir, `icon${size}.png`);
  const dst = path.join(genDir, `icon${size}.plasmo.png`);
  fs.copyFileSync(src, dst);
  const dstStat = fs.statSync(dst);
  console.log(
    `[prebuild] Copied ${path.relative(repoRoot, src)} -> ${path.relative(
      repoRoot,
      dst
    )} (${dstStat.size} bytes)`
  );
}

console.log('[prebuild] Prebuild complete - icons ready!');
