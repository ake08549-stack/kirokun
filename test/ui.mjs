// 画面(UI)だけの確認。文字起こしワーカーを偽物に差し替えるので、モデルのDL・推論なしで数秒で終わる。
// 実音声(test/test.wav)の再生・ハイライト・自動スクロール・キーボード・要約の保存/復元・レスポンシブを確認する。
// 使い方(playwright-core が解決できるフォルダで実行): node <project>/test/ui.mjs <projectDir> [chromePath]
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(process.cwd() + '/');
const { chromium } = require('playwright-core');

const root = process.argv[2];
const chrome =
  process.argv[3] ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };
const server = createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const f = join(root, 'dist', p === '/' ? 'index.html' : p);
  if (!existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/?profile=wasm`;

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
};

const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
// 偽ワーカー: 41秒ぶんを60区間(約0.68秒ずつ)で即返す
await ctx.addInitScript(() => {
  window.Worker = class {
    constructor() { this.onmessage = null; }
    postMessage() {
      setTimeout(() => {
        const segs = [];
        for (let i = 0; i < 60; i++) segs.push({ start: i * 0.68, end: (i + 1) * 0.68, text: `これは${i + 1}番目の区間です。` + 'あいうえお'.repeat(i % 5) });
        this.onmessage?.({ data: { type: 'progress', doneSec: 20, totalSec: 41 } });
        setTimeout(() => this.onmessage?.({ data: { type: 'result', segments: segs } }), 150);
      }, 100);
    }
    terminate() {}
  };
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const P = () => page.evaluate(() => { const p = document.getElementById('player'); return { t: p.currentTime, paused: p.paused, rate: p.playbackRate }; });
const playingIdx = () => page.evaluate(() => [...document.querySelectorAll('.seg')].findIndex((r) => r.classList.contains('playing')));
const mainTop = () => page.evaluate(() => document.getElementById('mainCol').scrollTop);
const rowInView = (i) => page.evaluate((i) => {
  const r = document.querySelectorAll('.seg')[i].getBoundingClientRect();
  const m = document.getElementById('mainCol').getBoundingClientRect();
  const head = document.querySelector('.res-head').offsetHeight;
  const bar = document.getElementById('playbar').getBoundingClientRect();
  return r.top >= m.top + head - 1 && r.bottom <= bar.top + 1;
}, i);

// ---------- 1280px: ホーム ----------
await page.goto(url);
await page.waitForTimeout(300);
const cols = await page.evaluate(() => ({
  side: document.getElementById('side').getBoundingClientRect().width,
  panelHidden: document.getElementById('panel').hidden,
  barHidden: document.getElementById('playbar').hidden,
}));
ok('ホーム: 左列240px前後・右パネルと再生バーは非表示', Math.abs(cols.side - 240) < 2 && cols.panelHidden && cols.barHidden, JSON.stringify(cols));
await page.screenshot({ path: join(root, 'test/shot-1280-home.png') });

// ---------- 文字起こし → 結果 ----------
await page.setInputFiles('#file', join(root, 'test/test.wav'));
await page.waitForFunction(() => !document.getElementById('start').disabled, null, { timeout: 30000 });
await page.click('#start');
await page.waitForSelector('#result:not([hidden])', { timeout: 15000 });
await page.waitForTimeout(400);
const segCount = await page.$$eval('.seg', (e) => e.length);
ok('結果: 区間が60行', segCount === 60, String(segCount));
const lay = await page.evaluate(() => ({
  panel: document.getElementById('panel').getBoundingClientRect().width,
  barVisible: !document.getElementById('playbar').hidden,
  audioVisible: getComputedStyle(document.getElementById('player')).display !== 'none' && document.getElementById('player').hasAttribute('controls'),
  cur: document.querySelector('#historyList li.current .hist-name')?.textContent,
  total: document.getElementById('pbTime').textContent,
}));
ok('結果: 右パネル300px前後・再生バー表示・<audio controls>なし', Math.abs(lay.panel - 300) < 2 && lay.barVisible && !lay.audioVisible, JSON.stringify(lay));
ok('結果: 履歴の選択中ハイライト', lay.cur === 'test.wav', lay.cur);
ok('結果: 全体時間が表示される(00:41前後)', /\/ 0[01]:4[0-2]$/.test(lay.total), lay.total);
ok('結果: 再生バーが画面下に固定', await page.evaluate(() => Math.abs(document.getElementById('playbar').getBoundingClientRect().bottom - innerHeight) < 1));

// ---------- 区間クリックで再生位置が変わる ----------
await page.click('.seg:nth-child(11) .ts'); // 10番目 = 6.8秒
await page.waitForTimeout(500);
let s = await P();
ok('区間クリックで再生位置が移り再生される', s.t >= 6.7 && s.t < 8.5 && !s.paused, JSON.stringify(s));
ok('再生中の区間がハイライトされる', [10, 11].includes(await playingIdx()), String(await playingIdx()));

// ---------- Space / 矢印 ----------
await page.click('.res-title'); // 中立な場所へフォーカス
await page.keyboard.press('Space');
await page.waitForTimeout(200);
s = await P();
ok('Space で一時停止', s.paused);
const t0 = s.t;
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(150);
const t1 = (await P()).t;
ok('→ で5秒進む', Math.abs(t1 - (t0 + 5)) < 0.3, `${t0.toFixed(2)} -> ${t1.toFixed(2)}`);
await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(150);
const t2 = (await P()).t;
ok('← で5秒戻る', Math.abs(t2 - t0) < 0.3, `${t1.toFixed(2)} -> ${t2.toFixed(2)}`);
await page.keyboard.press('Space');
await page.waitForTimeout(200);
ok('Space で再開', !(await P()).paused);
await page.keyboard.press('Space');
// 入力中は無効
await page.click('.seg:nth-child(3) .tx');
const tb = (await P()).t;
await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(150);
ok('本文の編集中は矢印キーで再生位置が動かない', Math.abs((await P()).t - tb) < 0.05);
await page.click('#search');
await page.keyboard.type('a b');
ok('検索欄でSpaceが入力され再生は始まらない', (await page.inputValue('#search')) === 'a b' && (await P()).paused);
await page.fill('#search', '');
await page.click('.res-title');

// ---------- 再生速度 ----------
await page.selectOption('#rate', '1.5');
ok('再生速度 1.5x が反映される', (await P()).rate === 1.5);
await page.selectOption('#rate', '1');

// ---------- ハイライトの移動と自動スクロール ----------
await page.evaluate(() => { document.getElementById('mainCol').scrollTop = 0; });
await page.click('.seg:nth-child(1) .ts');
await page.waitForTimeout(400);
const a = await playingIdx();
await page.waitForTimeout(2200);
const b = await playingIdx();
ok('再生が進むとハイライトが次の区間に移る', b > a && a >= 0, `${a} -> ${b}`);
await page.waitForTimeout(8500); // 約11秒 = 16番目付近。1画面を超えるので自動で追従するはず
const c = await playingIdx();
ok('自動スクロールで再生中の区間が見える位置に保たれる', (await mainTop()) > 0 && (await rowInView(c)), `idx=${c} scrollTop=${await mainTop()}`);
await page.screenshot({ path: join(root, 'test/shot-1280-result.png') });
// 手動スクロール直後は自動スクロールしない
await page.mouse.move(600, 400);
await page.mouse.wheel(0, -4000);
await page.waitForTimeout(500);
const topAfter = await mainTop();
await page.waitForTimeout(2000);
const topLater = await mainTop();
ok('手動スクロール直後(約2.5秒)は自動スクロールが止まる', topAfter < 50 && Math.abs(topLater - topAfter) < 5, `${topAfter} -> ${topLater}`);
await page.waitForTimeout(3500);
const d = await playingIdx();
ok('数秒後に自動スクロールが再開する', (await mainTop()) > topLater + 100 && (await rowInView(d)), `idx=${d} scrollTop=${await mainTop()}`);
await page.keyboard.press('Space');

// ---------- 要約の入力 → 保存 → リロード後に復元 ----------
const SUMM = '要点\n- 区間は60個\n- テスト用の要約';
await page.fill('#summary', SUMM);
await page.waitForTimeout(1000);
ok('要約の保存表示', (await page.textContent('#summaryState')) === '保存しました', await page.textContent('#summaryState'));
const stored = await page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('mojioko');
  r.onsuccess = () => { const g = r.result.transaction('history').objectStore('history').getAll(); g.onsuccess = () => res(g.result.map((x) => ({ id: x.id, summary: x.summary }))); };
}));
ok('IndexedDB の summary フィールドに保存される', stored.length === 1 && stored[0].summary === SUMM, JSON.stringify(stored));
await page.reload();
await page.waitForSelector('#historyList .hist-open');
await page.click('.hist-open');
await page.waitForSelector('#result:not([hidden])');
ok('履歴から開き直すと要約が復元される', (await page.inputValue('#summary')) === SUMM);
const na = await page.evaluate(() => ({
  none: document.getElementById('pbNone').textContent,
  noneVisible: !document.getElementById('pbNone').hidden && getComputedStyle(document.getElementById('pbNone')).display !== 'none',
  fullHidden: getComputedStyle(document.getElementById('pbFull')).display === 'none',
  hintHidden: document.getElementById('keyHint').hidden,
}));
ok('音声なしの履歴: 再生バーの代わりに案内文を表示', na.noneVisible && na.fullHidden && na.none === '音声は保存していないため再生できません', JSON.stringify(na));
await page.keyboard.press('Space');
ok('音声なしでSpaceを押してもエラーにならない', errors.length === 0, errors.join(' | '));
// 旧データ(summaryなし)互換: summaryを持たない履歴を直接追加して開く
await page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('mojioko');
  r.onsuccess = () => { const t = r.result.transaction('history', 'readwrite'); t.objectStore('history').add({ fileName: '旧データ.wav', createdAt: Date.now() - 86400000, duration: 12, segments: [{ start: 0, end: 2, text: '旧データです' }] }); t.oncomplete = res; };
}));
await page.reload();
await page.waitForSelector('#historyList li[data-id]');
const names = await page.$$eval('.hist-name', (e) => e.map((x) => x.textContent));
ok('履歴一覧に2件(新→旧の順)', names.length === 2 && names[1] === '旧データ.wav', names.join(','));
await page.click('#historyList li:nth-child(2) .hist-open');
ok('旧データ(summaryなし)でも開け、要約欄は空', (await page.inputValue('#summary')) === '' && (await page.textContent('#resName')) === '旧データ.wav');
// 削除(確認ダイアログあり)
let dialogMsg = '';
page.once('dialog', (dlg) => { dialogMsg = dlg.message(); dlg.dismiss(); });
await page.click('#historyList li:nth-child(2) .hist-del');
await page.waitForTimeout(200);
ok('削除は確認ダイアログが出る(キャンセルで残る)', dialogMsg.includes('旧データ.wav') && (await page.$$eval('#historyList li[data-id]', (e) => e.length)) === 2, dialogMsg);
page.once('dialog', (dlg) => dlg.accept());
await page.click('#historyList li:nth-child(2) .hist-del');
await page.waitForTimeout(400);
ok('確認後に削除され、開いていた結果はホームに戻る', (await page.$$eval('#historyList li[data-id]', (e) => e.length)) === 1 && (await page.isVisible('#home')));
// 新しく文字起こし
await page.click('.hist-open');
await page.click('#newBtn');
ok('「新しく文字起こし」でホームに戻り、選択ハイライトが消える', (await page.isVisible('#home')) && (await page.$$eval('#historyList li.current', (e) => e.length)) === 0);

// ---------- 375px ----------
await page.setViewportSize({ width: 375, height: 800 });
await page.goto(url);
await page.waitForSelector('#historyList li', { state: 'attached' });
await page.waitForTimeout(300);
const mob = await page.evaluate(() => ({
  overflow: document.documentElement.scrollWidth > innerWidth,
  menuVisible: getComputedStyle(document.getElementById('menuBtn')).display !== 'none',
  sideX: document.getElementById('side').getBoundingClientRect().right,
}));
ok('375px ホーム: 横スクロールなし・ハンバーガー表示・左列は隠れている', !mob.overflow && mob.menuVisible && mob.sideX <= 0, JSON.stringify(mob));
await page.screenshot({ path: join(root, 'test/shot-375-home.png'), fullPage: true });
await page.click('#menuBtn');
await page.waitForTimeout(350);
const drawer = await page.evaluate(() => ({ l: document.getElementById('side').getBoundingClientRect().left, r: document.getElementById('side').getBoundingClientRect().right, exp: document.getElementById('menuBtn').getAttribute('aria-expanded') }));
ok('375px: ハンバーガーで履歴ドロワーが開く', drawer.l >= 0 && drawer.r > 200 && drawer.exp === 'true', JSON.stringify(drawer));
await page.screenshot({ path: join(root, 'test/shot-375-drawer.png') });
await page.keyboard.press('Escape');
await page.waitForTimeout(350);
ok('375px: Escで閉じる', (await page.evaluate(() => document.getElementById('side').getBoundingClientRect().right)) <= 0);
// 結果画面(音声あり)
await page.setInputFiles('#file', join(root, 'test/test.wav'));
await page.waitForFunction(() => !document.getElementById('start').disabled, null, { timeout: 30000 });
await page.click('#start');
await page.waitForSelector('#result:not([hidden])', { timeout: 15000 });
await page.waitForTimeout(400);
const m2 = await page.evaluate(() => {
  const bar = document.getElementById('playbar');
  const els = ['playBtn', 'pbTime', 'seek', 'rate'].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return { id, l: r.left, r: r.right, w: r.width, h: r.height }; });
  return {
    overflow: document.documentElement.scrollWidth > innerWidth,
    barBottom: bar.getBoundingClientRect().bottom,
    barH: bar.getBoundingClientRect().height,
    inside: els.every((e) => e.l >= 0 && e.r <= innerWidth && e.w > 20),
    els,
    panelBelow: document.getElementById('panel').getBoundingClientRect().top > document.getElementById('mainCol').getBoundingClientRect().top,
  };
});
ok('375px 結果: 横スクロールなし・再生バーが画面内に収まる', !m2.overflow && m2.inside && Math.abs(m2.barBottom - 800) < 1, JSON.stringify({ ...m2, els: undefined }));
ok('375px 結果: 右パネルは中央列の下に回る', m2.panelBelow);
await page.click('#playBtn');
await page.waitForTimeout(800);
ok('375px: 再生ボタンで再生できる', !(await P()).paused && (await P()).t > 0.3, JSON.stringify(await P()));
await page.fill('#seek', '20');
await page.waitForTimeout(300);
ok('375px: シークバーで位置が変わる', Math.abs((await P()).t - 20) < 1.5, String((await P()).t));
await page.waitForTimeout(500);
const pi = await playingIdx();
ok('375px: 再生中の区間が画面内に追従する', await page.evaluate((i) => { const r = document.querySelectorAll('.seg')[i].getBoundingClientRect(); const bar = document.getElementById('playbar').getBoundingClientRect(); return r.top >= 0 && r.bottom <= bar.top + 1; }, pi), `idx=${pi}`);
await page.screenshot({ path: join(root, 'test/shot-375-result.png') });
await page.screenshot({ path: join(root, 'test/shot-375-result-full.png'), fullPage: true });

ok('ページエラー/コンソールエラーなし', errors.length === 0, errors.join(' | '));
console.log(fails === 0 ? '\nALL OK' : `\n${fails} 件 FAIL`);
await browser.close();
server.close();
process.exit(fails === 0 ? 0 : 1);
