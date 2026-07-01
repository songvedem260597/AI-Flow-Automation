const fs = require('fs');
const path = require('path');

const srcDir = 'C:/Users/uchih/Desktop/ai-workflow-automation/src';

function walk(dir) {
  const files = fs.readdirSync(dir);
  for (const f of files) {
    const fp = path.join(dir, f);
    const stat = fs.statSync(fp);
    if (stat.isDirectory()) {
      walk(fp);
    } else if (f.endsWith('.ts') || f.endsWith('.tsx')) {
      let content = fs.readFileSync(fp, 'utf8');
      if (content.includes("from '~/")) {
        content = content.replace(/from '~\//g, "from '@/");
        fs.writeFileSync(fp, content);
        console.log('Fixed:', fp);
      }
    }
  }
}

walk(srcDir);
console.log('Done replacing ~/ with @/');
