// Syntax check of the browser scripts in webui/ (served from disk, never compiled): one bad quote
// there leaves the desktop empty. Runs as part of `npm run build`.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'webui');
let bad = 0;
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js')).sort()) {
  try {
    new vm.Script(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: f });
  } catch (err) {
    bad++;
    console.error(`webui/${f}: ${String(err.message || err)}`);
  }
}
if (bad) { console.error(`${bad} browser script(s) in webui/ do not parse`); process.exit(1); }
console.log('webui scripts parse');
