// QA non-regression: proves the call feature leaves the single-user product untouched.
// Usage: node scripts/qa-nonregression.mjs   (exit 1 on any failure)
// Never touches the working tree: main is exported with `git archive` into a scratch dir.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('..', import.meta.url));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26, ...opts });
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };

const PROTECTED = ['lib/providers.mjs', 'lib/cleanup.mjs', 'lib/http.mjs', 'lib/tts', 'public/index.html', 'public/app.js',
  'public/playback.js', 'public/style.css', 'test/pipeline.test.mjs', 'test/playback.test.mjs', 'test/twinly.test.mjs',
  'scripts/check-google.mjs', 'scripts/smoke-live.mjs', 'scripts/preview-ui.mjs', 'render.yaml', 'DESIGN.md', 'PRODUCT.md'];
const ADDITIVE = ['server.mjs', 'lib/config.mjs', 'package.json', 'README.md', '.env.example'];

// 1. Protected files byte-identical to main (working tree vs main, so uncommitted edits count).
const stat = sh('git', ['diff', 'main', '--stat', '--', ...PROTECTED]).trim();
check('protected files identical to main', stat === '', stat ? '\n' + stat : '');
const staged = sh('git', ['diff', 'main', '--name-status', '--', ...PROTECTED]).trim();
check('protected files: no deletes/renames vs main', staged === '', staged);

// 2. Additive-only files: zero deleted lines.
const num = sh('git', ['diff', 'main', '--numstat', '--', ...ADDITIVE]).trim().split('\n').filter(Boolean);
for (const f of ADDITIVE) {
  const row = num.find(l => l.endsWith('\t' + f));
  const [added = '0', deleted = '0'] = row ? row.split('\t') : [];
  check(`additive-only ${f}`, deleted === '0', `+${added} -${deleted}`);
}

// 3. Export main and compare test results.
const scratch = mkdtempSync(join(tmpdir(), 'qa-main-'));
const mainDir = join(scratch, 'main'); mkdirSync(mainDir);
execFileSync('sh', ['-c', `git archive main | tar -x -C "${mainDir}"`], { cwd: root });
const pass = out => Number(/ℹ pass (\d+)/.exec(out)?.[1] ?? -1);
const run = (cwd, args) => { try { return execFileSync('node', ['--test', ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, CALL_TOKEN: '' } }); }
  catch (e) { return (e.stdout || '') + (e.stderr || ''); } };
const existing = ['test/pipeline.test.mjs', 'test/playback.test.mjs', 'test/twinly.test.mjs'];
const mainOut = run(mainDir, existing), branchOut = run(root, existing);
check('existing 3 test files: branch pass count == main', pass(mainOut) > 0 && pass(mainOut) === pass(branchOut),
  `main=${pass(mainOut)} branch=${pass(branchOut)} branchFail=${/ℹ fail (\d+)/.exec(branchOut)?.[1]}`);
const fullOut = run(root, ['test/pipeline.test.mjs', 'test/playback.test.mjs', 'test/twinly.test.mjs', ...(existsSync(join(root, 'test/call.test.mjs')) ? ['test/call.test.mjs'] : [])]);
console.log(`INFO  existing + A's call.test.mjs on branch: pass=${pass(fullOut)} fail=${/ℹ fail (\d+)/.exec(fullOut)?.[1]}`);

// 4. /api/process contract + / page, branch vs main, mock mode.
async function boot(cwd) {
  const child = spawn('node', ['server.mjs'], { cwd, env: { PATH: process.env.PATH, APP_MODE: 'mock', TTS_PROVIDER: 'mock', PORT: '0', HOST: '127.0.0.1',
    CALL_TOKEN: 'qa-nonreg-token' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const base = await new Promise((res, rej) => {
    let buf = ''; const t = setTimeout(() => rej(new Error('boot timeout')), 8000);
    child.stdout.on('data', d => { buf += d; const m = /Local: (http:\/\/\S+)/.exec(buf); if (m) { clearTimeout(t); res(m[1]); } });
    child.on('exit', c => rej(new Error('server exited ' + c)));
  });
  return { child, base };
}
async function profile({ base }) {
  const audio = Buffer.alloc(4096, 1);
  const r = await fetch(`${base}/api/process`, { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: audio });
  const lines = (await r.text()).trim().split('\n').map(l => JSON.parse(l));
  const shape = lines.map(e => `${e.type}:${Object.keys(e).sort().join(',')}`);
  const seq = []; for (const s of shape) if (seq[seq.length - 1] !== s) seq.push(s);
  const page = await (await fetch(base + '/')).text();
  const ids = [...page.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]).sort();
  const scripts = [...page.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
  const links = [...page.matchAll(/<(?:a|link)[^>]*href="([^"]+)"/g)].map(m => m[1]);
  const bad = await fetch(`${base}/api/process`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
  const h = r.headers;
  return { status: r.status, ctype: h.get('content-type'), seq, ids, scripts, links, badStatus: bad.status,
    badBody: Object.keys(await bad.json()).sort(), hasCall: /call/i.test(page) };
}
let a, b;
try {
  a = await boot(mainDir); b = await boot(root);
  const pm = await profile(a), pb = await profile(b);
  check('/api/process status+content-type identical', pm.status === pb.status && pm.ctype === pb.ctype, `${pm.status} ${pm.ctype}`);
  check('/api/process NDJSON type+field sequence identical', JSON.stringify(pm.seq) === JSON.stringify(pb.seq), `main=${pm.seq.length} events-shapes branch=${pb.seq.length}`);
  check('/api/process error shape identical (415)', pm.badStatus === pb.badStatus && JSON.stringify(pm.badBody) === JSON.stringify(pb.badBody));
  check('/ element id list identical', JSON.stringify(pm.ids) === JSON.stringify(pb.ids), `${pb.ids.length} ids`);
  check('/ scripts identical', JSON.stringify(pm.scripts) === JSON.stringify(pb.scripts), pb.scripts.join(' '));
  check('/ links identical, no /call reference', JSON.stringify(pm.links) === JSON.stringify(pb.links) && !pb.hasCall);
  const [ma, mb] = [await fetch(a.base + '/app.js'), await fetch(b.base + '/app.js')];
  check('/app.js body identical', (await ma.text()) === (await mb.text()));
  for (const p of ['/healthz', '/api/config']) {
    const [x, y] = [await (await fetch(a.base + p)).text(), await (await fetch(b.base + p)).text()];
    check(`${p} identical`, x === y);
  }
  const [c1, c2] = [await fetch(a.base + '/call'), await fetch(b.base + '/call')];
  console.log(`INFO  GET /call  main=${c1.status}  branch=${c2.status}`);
} catch (e) { check('non-regression servers ran', false, String(e)); }
finally { for (const s of [a, b]) s?.child.kill(); await delay(100); rmSync(scratch, { recursive: true, force: true }); }
console.log(failures ? `\nNON-REGRESSION: ${failures} FAILURE(S)` : '\nNON-REGRESSION: ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
