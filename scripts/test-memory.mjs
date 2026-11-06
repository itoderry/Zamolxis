// Multi-line memory entries (issue #101): every line must survive a save and a read-back, for
// working memory, the user profile and learnings. Run after `npm run build`:
//   node scripts/test-memory.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const { MemoryManager } = await import(pathToFileURL(path.join(root, 'dist', 'core', 'memory.js')).href);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-memtest-'));
const m = new MemoryManager(dir);

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ' want ' + JSON.stringify(want)}`);
};

// wrapped text joins with a space, and the tool says it joined the lines
const r1 = m.add('Cristian prefers dark mode\nand uses Excel for reports');
eq('memory: wrapped text kept whole', m.list(), ['Cristian prefers dark mode and uses Excel for reports']);
eq('memory: reply says lines were joined', /joined 2 lines into one entry/.test(r1.message), true);

// a bulleted list stays a list; a continuation starting with "- " is not split into its own entry
m.addUser('Projects:\n- Zamolxis\n- Typecure');
eq('profile: list joined with "; "', m.userList(), ['Projects: Zamolxis; Typecure']);

// replace with multi-line text
m.replaceUser('Projects:', 'Projects:\r\n- Zamolxis\r\n- Typecure\r\n- Reader');
eq('profile: replace keeps every line (CRLF too)', m.userList(), ['Projects: Zamolxis; Typecure; Reader']);

// learnings go through the same path
m.addLearning('For Excel reports\nuse open_in_excel with columns and rows');
eq('learnings: kept whole', m.learningsList(), ['For Excel reports use open_in_excel with columns and rows']);

// a leading bullet on the first line is dropped (the file adds its own), blank lines are ignored
m.add('- Use the speech service\n\n  before whisper-server');
eq('memory: no double bullet, blank lines ignored', m.list()[1], 'Use the speech service before whisper-server');

// single-line entries are unchanged, and the reply has no "joined" note
const r2 = m.add('Kokoro af_heart is the default voice');
eq('memory: single line unchanged', m.list()[2], 'Kokoro af_heart is the default voice');
eq('memory: no joined note for one line', /joined/.test(r2.message), false);

// the file on disk has one line per entry
const lines = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8').trim().split('\n');
eq('MEMORY.md: one "- " line per entry', lines.every((l) => l.startsWith('- ')) && lines.length === 3, true);

// empty after joining is still refused
eq('memory: blank text refused', m.add('\n  \n').ok, false);

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the learnings index keeps its database open until exit */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
