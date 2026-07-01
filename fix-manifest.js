const fs = require('fs');
const path = require('path');

const cacheDir = 'C:/Users/uchih/Desktop/ai-workflow-automation/.plasmo/cache';
if (fs.existsSync(cacheDir)) {
  fs.rmSync(cacheDir, { recursive: true, force: true });
  console.log('Cache cleared');
}

const manifestPath = 'C:/Users/uchih/Desktop/ai-workflow-automation/.plasmo/chrome-mv3.plasmo.manifest.json';
let content = fs.readFileSync(manifestPath, 'utf8');

content = content.replace(/"css":\s*\[[\s\S]*?\],?/g, '');
content = content.replace(/,\s*"js":/g, '"js":');
content = content.replace(/,\s*,/g, ',');
content = content.replace(/{\s*,/g, '{');
content = content.replace(/,\s*}/g, '}');
content = content.replace(/(\])\s*,(\s*")/g, '$1$2');
content = content.replace(/(\])\s*,(\s*})/g, '$1$2');

fs.writeFileSync(manifestPath, content);
console.log('Manifest fixed');
