// ヘッドレスChromium(playwright-core)で dist/ を配信し、実際に文字起こしを回して CER を測る。
// 使い方: node e2e.mjs <projectDir> <profile: wasm|webgpu> [chromePath]
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(process.cwd() + '/');
const { chromium } = require('playwright-core');

const root = process.argv[2];
const profile = process.argv[3] ?? 'wasm';
const chrome =
  process.argv[4] ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const audioFile = process.env.AUDIO ?? join(root, 'test/test.wav');
const scriptText = readFileSync(join(root, 'test/script.txt'), 'utf8').trim();

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };
const server = createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  let f = join(root, 'dist', p === '/' ? 'index.html' : p);
  if (!existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// ---- CER ----
const KD = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const KU = { 十: 10, 百: 100, 千: 1000 };
function kanjiToNum(s) {
  let total = 0, cur = 0, seen = false;
  for (const ch of s) {
    if (ch in KD) { cur = KD[ch]; seen = true; }
    else if (ch in KU) { total += (cur || 1) * KU[ch]; cur = 0; seen = true; }
  }
  return total + cur;
}
function normalize(t) {
  t = t.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  t = t.replace(/(?<=\d),(?=\d)/g, '');
  t = t.replace(/[〇一二三四五六七八九十百千]+/g, (m) => (/^[一〇]$/.test(m) && false ? m : String(kanjiToNum(m))));
  return t.replace(/[\s、。，．,.!！?？「」『』()（）\-ー・]/g, '');
}
function lev(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const cer = (ref, hyp) => lev([...ref], [...hyp]) / [...ref].length;

const hosts = new Set();
const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=metal'],
});
const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1000, height: 900 } });
const page = await ctx.newPage();
page.on('request', (r) => { try { hosts.add(new URL(r.url()).host); } catch {} });
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));

await page.goto(`http://127.0.0.1:${port}/?profile=${profile}${process.env.QS ?? ''}`);
const gpu = await page.evaluate(async () => {
  try { const a = await navigator.gpu?.requestAdapter(); return a ? [...a.features].includes('shader-f16') ? 'webgpu+f16' : 'webgpu' : 'no-adapter'; } catch (e) { return 'err ' + e; }
});
console.log('WebGPU in headless:', gpu);
console.log('profile:', await page.inputValue('#profile'));

await page.setInputFiles('#file', audioFile);
await page.waitForFunction(() => !document.getElementById('start').disabled, null, { timeout: 60000 });
console.log('picked length:', await page.textContent('#pickedLen'));

const t0 = Date.now();
await page.click('#start');
let lastText = '';
const timeoutMs = 25 * 60 * 1000;
while (Date.now() - t0 < timeoutMs) {
  if (await page.isVisible('#result')) break;
  if (await page.isVisible('#homeErr')) { console.log('ERROR:', await page.textContent('#homeErr')); break; }
  const t = (await page.textContent('#progTitle')) + ' | ' + (await page.textContent('#progText'));
  if (t !== lastText) { lastText = t; console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, t); }
  await page.waitForTimeout(1000);
}
const wall = (Date.now() - t0) / 1000;
if (!(await page.isVisible('#result'))) { console.log('FAILED: no result'); await browser.close(); server.close(); process.exit(2); }

const segs = await page.$$eval('.seg', (rows) => rows.map((r) => ({ ts: r.querySelector('.ts').textContent, tx: r.querySelector('.tx').textContent })));
console.log('segments:', segs.length);
segs.forEach((s) => console.log(' ', s.ts, s.tx));
const hyp = segs.map((s) => s.tx).join('');
const rawCer = cer(scriptText.replace(/[\s、。]/g, ''), hyp.replace(/[\s、。]/g, ''));
const normCer = cer(normalize(scriptText), normalize(hyp));
console.log(`WALL_SEC=${wall.toFixed(1)}  CER_raw=${(rawCer * 100).toFixed(1)}%  CER_numnorm=${(normCer * 100).toFixed(1)}%`);
console.log('ref_norm:', normalize(scriptText));
console.log('hyp_norm:', normalize(hyp));

// ---- UI機能の確認 ----
await page.fill('#search', '会議');
await page.waitForTimeout(200);
console.log('search "会議":', await page.textContent('#hitCount'), 'hitRows=', await page.$$eval('.seg.hit', (e) => e.length));
// 編集
await page.click('.seg:first-child .tx');
await page.keyboard.press('End');
await page.keyboard.type('【編集】');
await page.waitForTimeout(900);
console.log('edited first seg:', (await page.textContent('.seg:first-child .tx')).slice(-8));
// 書き出し
for (const k of ['txt', 'srt', 'vtt']) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click(`[data-exp=${k}]`)]);
  const path = await dl.path();
  const body = readFileSync(path, 'utf8');
  console.log(`download ${dl.suggestedFilename()} bytes=${body.length}`, JSON.stringify(body.slice(0, 70)));
}
// 履歴
await page.click('#back');
await page.waitForTimeout(300);
const hist = await page.$$eval('#historyList li', (e) => e.map((x) => x.textContent.trim().slice(0, 60)));
console.log('history:', hist);
await page.reload();
await page.waitForTimeout(500);
console.log('history after reload:', await page.$$eval('#historyList li', (e) => e.length));
await page.click('.hist-open');
console.log('reopened from history, edited text persisted:', (await page.textContent('.seg:first-child .tx')).includes('【編集】'));
// 375px
await page.setViewportSize({ width: 375, height: 800 });
await page.waitForTimeout(300);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
console.log('375px horizontal overflow:', overflow);
await page.screenshot({ path: join(root, `test/shot-375-result-${profile}.png`), fullPage: true });
await page.click('#back');
await page.screenshot({ path: join(root, `test/shot-375-home-${profile}.png`), fullPage: true });
console.log('request hosts:', [...hosts].join(', '));
writeFileSync(join(root, `test/result-${profile}${process.env.TAG ?? ''}.json`), JSON.stringify({ profile, gpu, wall, rawCer, normCer, segs }, null, 2));
await browser.close();
server.close();
