/**
 * postbuild.js — runs after `plasmo build`
 *
 * Fixes auto-detected content_scripts from src/contents/:
 * 1. Replace "<all_urls>" matches with "https://labs.google/fx/*"
 * 2. Add world:"MAIN" to the slate-bridge entry
 *
 * Usage: called automatically by `npm run build` via package.json scripts.
 */
const fs = require('fs')
const path = require('path')

const MANIFEST_PATH = path.join(__dirname, 'build', 'chrome-mv3-prod', 'manifest.json')
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'))

if (manifest.content_scripts) {
  manifest.content_scripts.forEach((cs) => {
    // Fix matches — restrict to Flow only
    if (cs.js && Array.isArray(cs.js)) {
      const hasFlowContent = cs.js.some((f) => f.includes('flow-content.'))
      const hasFlowBridge = cs.js.some((f) => f.includes('flow-slate-bridge.'))

      if (hasFlowContent || hasFlowBridge) {
        cs.matches = ['https://labs.google/fx/*']
      }

      // Add world MAIN for bridge
      if (hasFlowBridge) {
        cs.world = 'MAIN'
      }

      // Remove auto-added isolated world flow content (we inject manually via background)
      // Keep it — manual injection in background is more reliable
      // No filtering needed; we use background injection as primary
    }
  })
}

fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
console.log('postbuild: manifest fixed — Flow content_scripts restricted to labs.google/fx/*')

// Also copy slate-bridge source for manual injection reference
const srcBridge = path.join(__dirname, 'src', 'contents', 'flow-slate-bridge.ts')
const pubBridge = path.join(__dirname, 'public', 'slate-bridge.main.js')
if (fs.existsSync(srcBridge)) {
  fs.copyFileSync(srcBridge, pubBridge)
  console.log('postbuild: copied slate-bridge to public/')
} else {
  console.log('postbuild: src/contents/flow-slate-bridge.ts not found — skipping copy')
}

console.log('Postbuild complete!')
