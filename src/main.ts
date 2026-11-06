import './style.css';
import { APP_NAME, APP_TAGLINE, PROFILES, SAMPLE_RATE, type ProfileId } from './config';
import { Recorder, decodeToMono16k } from './audio';
import { deleteHistory, listHistory, saveHistory, updateHistory, withSummary } from './db';
import { buildSummaryText, formatClock, toSRT, toTXT, toVTT } from './exporters';
import type { HistoryItem, Segment } from './types';
import type { WorkerIn, WorkerOut } from './worker';

document.title = `${APP_NAME} - 日本語文字起こし`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ICON_PLAY = '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M6 3.5v13l11-6.5z" fill="currentColor"/></svg>';
const ICON_PAUSE = '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><rect x="4.5" y="3.5" width="4" height="13" rx="1" fill="currentColor"/><rect x="11.5" y="3.5" width="4" height="13" rx="1" fill="currentColor"/></svg>';
const ICON_MENU = '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>';
const ICON_PLUS = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>';

document.getElementById('app')!.innerHTML = `
<div id="shell" class="shell">
  <header class="mobilebar">
    <button id="menuBtn" class="menu-btn" aria-label="履歴を開く" aria-controls="side" aria-expanded="false">${ICON_MENU}</button>
    <span class="brand">${APP_NAME}</span>
  </header>
  <div id="scrim" class="scrim" hidden></div>
  <aside id="side" class="side" aria-label="履歴">
    <div class="side-head">
      <span class="brand">${APP_NAME}</span>
      <button id="sideClose" class="side-close">閉じる</button>
    </div>
    <button id="newBtn" class="btn new-btn">${ICON_PLUS}<span>新しく文字起こし</span></button>
    <p class="side-label">履歴</p>
    <ul id="historyList" class="history"></ul>
    <p class="side-foot">データはこの端末の中だけに保存されます(音声本体は保存しません)</p>
  </aside>

  <main id="mainCol" class="main">
    <section id="home" class="home">
      <h2>文字起こしを始める</h2>
      <p class="lead">${APP_TAGLINE}。処理はすべてこのブラウザの中で行います。</p>
      <div id="drop" class="drop" tabindex="0">
        <p class="drop-main">音声・動画ファイルをここにドロップ</p>
        <p class="drop-sub">mp3 / m4a / wav / mp4 / webm など</p>
        <div class="row">
          <button id="pick" class="btn">ファイルを選ぶ</button>
          <button id="rec" class="btn ghost">マイクで録音</button>
        </div>
        <input id="file" type="file" accept="audio/*,video/*" hidden />
      </div>
      <p id="recstate" class="muted" hidden></p>
      <div id="picked" class="picked" hidden>
        <p><strong id="pickedName"></strong><span id="pickedLen" class="muted"></span></p>
      </div>
      <div class="mode">
        <label for="profile">モード</label>
        <select id="profile"></select>
        <span id="modeBadge" class="badge" hidden>軽量モード(精度低め)</span>
      </div>
      <p id="dlNote" class="note"></p>
      <button id="start" class="btn primary" disabled>文字起こしを開始</button>
      <p id="homeErr" class="err" role="alert" hidden></p>
      <p class="credit">モデル: OpenAI Whisper(large-v3-turbo / base)・推論: transformers.js(Apache-2.0)</p>
    </section>

    <section id="progress" class="progress" hidden>
      <h2 id="progTitle">準備中…</h2>
      <div class="bar"><div id="barFill"></div></div>
      <p id="progText" class="muted"></p>
      <button id="cancel" class="btn ghost">キャンセル</button>
    </section>

    <section id="result" hidden>
      <div class="res-head">
        <div class="res-title">
          <h2 id="resName"></h2>
          <span id="resMeta" class="res-meta"></span>
        </div>
        <div class="searchbox">
          <input id="search" type="search" placeholder="全文検索" aria-label="全文検索" />
          <span id="hitCount" class="muted"></span>
        </div>
      </div>
      <div id="segs" class="segs"></div>
    </section>
  </main>

  <aside id="panel" class="panel" aria-label="書き出しと要約" hidden>
    <section class="pbox">
      <h3>書き出し</h3>
      <label class="chk"><input id="withTs" type="checkbox" checked /> TXTにタイムスタンプを付ける</label>
      <div class="btn-grid">
        <button class="btn small" data-exp="txt">TXT</button>
        <button class="btn small" data-exp="srt">SRT</button>
        <button class="btn small" data-exp="vtt">VTT</button>
        <button class="btn small ghost wide" id="copyAll">全文コピー</button>
      </div>
    </section>
    <section class="pbox">
      <h3>要約</h3>
      <button class="btn small accent" id="summ">Claudeで要約</button>
      <p class="muted help">指示文と全文をコピーして、Claudeを新しいタブで開きます。貼り付けて送信してください。</p>
      <label class="cap" for="summary">Claudeの要約をここに貼り付けて保存</label>
      <textarea id="summary" placeholder="Claudeが返した要約を貼り付けます"></textarea>
      <p id="summaryState" class="muted" aria-live="polite"></p>
    </section>
    <p id="keyHint" class="keys">Space 再生/停止 ・ ←→ 5秒移動</p>
  </aside>
</div>

<div id="playbar" class="playbar" hidden>
  <div id="pbFull">
    <button id="playBtn" class="pb-play" aria-label="再生">${ICON_PLAY}</button>
    <span id="pbTime" class="pb-time">00:00 / 00:00</span>
    <input id="seek" class="pb-seek" type="range" min="0" max="0" step="0.1" value="0" aria-label="再生位置" />
    <select id="rate" class="pb-rate" aria-label="再生速度">
      <option value="1">1.0x</option>
      <option value="1.25">1.25x</option>
      <option value="1.5">1.5x</option>
      <option value="2">2.0x</option>
    </select>
  </div>
  <p id="pbNone" hidden>音声は保存していないため再生できません</p>
</div>
<audio id="player" preload="metadata" hidden></audio>
<div id="toast" class="toast" role="status" hidden></div>
`;

// ---------- 状態 ----------
type View = 'home' | 'progress' | 'result';

let profileId: ProfileId = 'wasm';
let pickedBlob: Blob | null = null;
let pickedName = '';
let audioData: Float32Array | null = null;
let worker: Worker | null = null;
let current: { id: number; item: HistoryItem } | null = null;
let objectUrl: string | null = null;
let view: View = 'home';
const recorder = new Recorder();
let recording = false;

// ---------- ユーティリティ ----------
const shell = $('shell');
const side = $('side');
const mainCol = $('mainCol');
const player = $<HTMLAudioElement>('player');
const playbar = $('playbar');
const isDesktop = () => window.matchMedia('(min-width: 1024px)').matches;

function show(id: View) {
  view = id;
  for (const s of ['home', 'progress', 'result']) $(s).hidden = s !== id;
  $('panel').hidden = id !== 'result';
  shell.classList.toggle('has-panel', id === 'result');
  side.classList.toggle('busy', id === 'progress');
  updateBar();
}

let toastTimer = 0;
function toast(msg: string) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 3500);
}

function download(name: string, text: string, mime: string) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function baseName(name: string) {
  return name.replace(/\.[^.]+$/, '') || 'transcript';
}

function fmtDate(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- 履歴ドロワー(1024px未満) ----------
function setDrawer(open: boolean) {
  side.classList.toggle('open', open);
  $('scrim').hidden = !open;
  $('menuBtn').setAttribute('aria-expanded', String(open));
}
$('menuBtn').addEventListener('click', () => setDrawer(!side.classList.contains('open')));
$('scrim').addEventListener('click', () => setDrawer(false));
$('sideClose').addEventListener('click', () => setDrawer(false));
window.matchMedia('(min-width: 1024px)').addEventListener('change', (e) => {
  if (e.matches) setDrawer(false);
});

// ---------- モード選択 ----------
async function detectProfile(): Promise<ProfileId> {
  const forced = new URLSearchParams(location.search).get('profile') as ProfileId | null;
  if (forced && forced in PROFILES) return forced;
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<object | null> } }).gpu;
    const adapter = await gpu?.requestAdapter();
    if (adapter) return 'webgpu';
  } catch {
    /* WebGPU 不可 */
  }
  return 'wasm';
}

function refreshMode() {
  const p = PROFILES[profileId];
  $('modeBadge').hidden = p.device !== 'wasm';
  $('dlNote').textContent = `${p.note} 2回目以降はブラウザに保存されたモデルを使うので、すぐ始まります。`;
}

const sel = $<HTMLSelectElement>('profile');
for (const p of Object.values(PROFILES)) {
  const o = document.createElement('option');
  o.value = p.id;
  o.textContent = `${p.label}(初回約${p.approxMB >= 1000 ? (p.approxMB / 1000).toFixed(1) + 'GB' : p.approxMB + 'MB'})`;
  sel.appendChild(o);
}
sel.addEventListener('change', () => {
  profileId = sel.value as ProfileId;
  refreshMode();
});
detectProfile().then((p) => {
  profileId = p;
  sel.value = p;
  refreshMode();
});

// ---------- 入力 ----------
function homeError(msg: string | null) {
  const e = $('homeErr');
  e.hidden = !msg;
  e.textContent = msg ?? '';
}

async function setInput(blob: Blob, name: string) {
  homeError(null);
  pickedBlob = blob;
  pickedName = name;
  audioData = null;
  $('start').toggleAttribute('disabled', true);
  $('picked').hidden = false;
  $('pickedName').textContent = name;
  $('pickedLen').textContent = ' 読み込み中…';
  try {
    audioData = await decodeToMono16k(blob);
    $('pickedLen').textContent = ` ${formatClock(audioData.length / SAMPLE_RATE)}`;
    $('start').toggleAttribute('disabled', false);
  } catch (e) {
    pickedBlob = null;
    $('picked').hidden = true;
    homeError(e instanceof Error ? e.message : String(e));
  }
}

function clearInput() {
  pickedBlob = null;
  pickedName = '';
  audioData = null;
  $('picked').hidden = true;
  $('start').toggleAttribute('disabled', true);
  homeError(null);
}

const fileInput = $<HTMLInputElement>('file');
$('pick').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) void setInput(f, f.name);
  fileInput.value = '';
});
const drop = $('drop');
['dragenter', 'dragover'].forEach((t) =>
  drop.addEventListener(t, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  }),
);
['dragleave', 'drop'].forEach((t) =>
  drop.addEventListener(t, (e) => {
    e.preventDefault();
    drop.classList.remove('over');
  }),
);
drop.addEventListener('drop', (e) => {
  const f = (e as DragEvent).dataTransfer?.files?.[0];
  if (f) void setInput(f, f.name);
});

$('rec').addEventListener('click', async () => {
  const btn = $('rec');
  homeError(null);
  if (!recording) {
    try {
      await recorder.start();
    } catch {
      homeError('マイクを使えませんでした。ブラウザのマイク許可を確認してください。');
      return;
    }
    recording = true;
    btn.textContent = '録音を停止';
    btn.classList.add('recording');
    const t0 = Date.now();
    const st = $('recstate');
    st.hidden = false;
    const tick = window.setInterval(() => {
      if (!recording) return clearInterval(tick);
      st.textContent = `録音中 ${formatClock((Date.now() - t0) / 1000)}`;
    }, 500);
  } else {
    recording = false;
    btn.textContent = 'マイクで録音';
    btn.classList.remove('recording');
    $('recstate').hidden = true;
    const blob = await recorder.stop();
    const d = new Date();
    void setInput(blob, `録音 ${fmtDate(d.getTime())}`);
  }
});

// ---------- 文字起こし ----------
function setProgress(pct: number | null, title: string, text: string) {
  $('progTitle').textContent = title;
  $('progText').textContent = text;
  const fill = $('barFill');
  fill.style.width = pct == null ? '100%' : `${Math.max(2, Math.min(100, pct))}%`;
  fill.classList.toggle('indeterminate', pct == null);
}

function stopWorker() {
  worker?.terminate();
  worker = null;
}

$('start').addEventListener('click', () => {
  if (!audioData) return;
  homeError(null);
  pausePlayer();
  show('progress');
  setDrawer(false);
  setProgress(null, 'モデルを準備しています', '初回は数百MB〜1GB超のダウンロードがあります');
  stopWorker();
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const total = audioData.length / SAMPLE_RATE;
  const dur = total;
  const name = pickedName;
  worker.onmessage = async (ev: MessageEvent<WorkerOut>) => {
    const m = ev.data;
    if (m.type === 'status') setProgress(null, m.text, '');
    else if (m.type === 'download') {
      const pct = m.totalMB > 0 ? (m.loadedMB / m.totalMB) * 100 : null;
      setProgress(pct, 'モデルをダウンロード中', `${pct == null ? '' : pct.toFixed(0) + '% '}(${m.loadedMB.toFixed(0)}MB / ${m.totalMB.toFixed(0)}MB)`);
    } else if (m.type === 'progress') {
      const pct = (m.doneSec / m.totalSec) * 100;
      setProgress(pct, '文字起こし中', `${formatClock(m.doneSec)} / ${formatClock(m.totalSec)} 処理済み`);
    } else if (m.type === 'result') {
      stopWorker();
      const item: Omit<HistoryItem, 'id'> = { fileName: name, createdAt: Date.now(), duration: dur, segments: m.segments };
      let id = 0;
      try {
        id = await saveHistory(item);
      } catch {
        toast('履歴に保存できませんでした(結果は表示します)');
      }
      openResult({ ...item, id }, pickedBlob);
      void renderHistory();
    } else if (m.type === 'error') {
      stopWorker();
      show('home');
      homeError(`文字起こしに失敗しました: ${m.message}${PROFILES[profileId].device === 'webgpu' ? '(モードを「軽量モード」に切り替えて再試行できます)' : ''}`);
    }
  };
  worker.onerror = (e) => {
    stopWorker();
    show('home');
    homeError(`ワーカーでエラーが発生しました: ${e.message}`);
  };
  // 音声はコピーして渡す(結果画面の再生用に元Blobは保持)
  const copy = new Float32Array(audioData);
  const qp = new URLSearchParams(location.search);
  const enc = qp.get('enc');
  const dec = qp.get('dec');
  const dtype = enc && dec ? { encoder_model: enc, decoder_model_merged: dec } : undefined;
  const model = qp.get('model') ?? undefined;
  const msg: WorkerIn = { type: 'transcribe', profile: profileId, audio: copy, dtype, model };
  worker.postMessage(msg, [copy.buffer]);
});

$('cancel').addEventListener('click', () => {
  stopWorker();
  show('home');
  toast('キャンセルしました');
});

// ---------- 結果画面 ----------
const segsEl = $('segs');

function openResult(item: HistoryItem, audio: Blob | null) {
  flushSaves();
  pausePlayer();
  current = { id: item.id, item };
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = audio ? URL.createObjectURL(audio) : null;
  if (objectUrl) player.src = objectUrl;
  else {
    player.removeAttribute('src');
    player.load();
  }
  applyRate();
  $('resName').textContent = item.fileName;
  $('resMeta').textContent = `${fmtDate(item.createdAt)} ・ ${formatClock(item.duration)}`;
  ($('search') as HTMLInputElement).value = '';
  const sm = $<HTMLTextAreaElement>('summary');
  sm.value = item.summary ?? '';
  $('summaryState').textContent = item.id ? '' : '履歴に保存できていないため、要約は保存されません';
  lastIdx = -1;
  renderSegments();
  show('result');
  syncBar();
  syncHighlight(false);
  markCurrent();
  mainCol.scrollTo({ top: 0 });
  window.scrollTo({ top: 0 });
}

function closeResult() {
  flushSaves();
  pausePlayer();
  current = null;
  markCurrent();
}

function renderSegments() {
  if (!current) return;
  segsEl.textContent = '';
  current.item.segments.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'seg';
    row.dataset.i = String(i);
    const ts = document.createElement('button');
    ts.className = 'ts';
    ts.textContent = `[${formatClock(s.start)}]`;
    ts.title = 'ここから再生';
    ts.addEventListener('click', () => {
      ts.blur();
      if (!objectUrl) return toast('この履歴には音声がありません');
      player.currentTime = s.start;
      void player.play();
      syncBar();
      syncHighlight(true);
    });
    const tx = document.createElement('div');
    tx.className = 'tx';
    tx.contentEditable = 'plaintext-only';
    tx.spellcheck = false;
    tx.textContent = s.text;
    tx.addEventListener('input', () => {
      s.text = tx.textContent ?? '';
      scheduleSave();
      applySearch();
    });
    tx.addEventListener('blur', flushSaves);
    row.append(ts, tx);
    segsEl.appendChild(row);
  });
  applySearch();
}

// 保存(本文・要約とも、現在のitemをまるごと書く)
let saveTimer = 0;
function scheduleSave(delay = 600) {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushSaves, delay);
}
function flushSaves() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  if (current && current.id) {
    updateHistory(current.item)
      .then(() => {
        if (summaryDirty) {
          summaryDirty = false;
          $('summaryState').textContent = current?.item.summary ? '保存しました' : '';
        }
      })
      .catch(() => toast('履歴に保存できませんでした'));
  }
}
window.addEventListener('pagehide', flushSaves);

function applySearch() {
  const q = ($('search') as HTMLInputElement).value.trim();
  const rows = Array.from(segsEl.children) as HTMLElement[];
  let hits = 0;
  const ranges: Range[] = [];
  rows.forEach((row) => {
    const tx = row.querySelector('.tx') as HTMLElement;
    const text = tx.textContent ?? '';
    const lower = text.toLowerCase();
    const ql = q.toLowerCase();
    const hit = q !== '' && lower.includes(ql);
    row.classList.toggle('hit', hit);
    if (hit && tx.firstChild) {
      let idx = lower.indexOf(ql);
      while (idx >= 0) {
        hits++;
        const r = new Range();
        r.setStart(tx.firstChild, idx);
        r.setEnd(tx.firstChild, idx + ql.length);
        ranges.push(r);
        idx = lower.indexOf(ql, idx + ql.length);
      }
    }
  });
  const css = CSS as unknown as { highlights?: Map<string, unknown> };
  const HL = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (css.highlights && HL) {
    if (ranges.length) css.highlights.set('search', new HL(...ranges));
    else css.highlights.delete('search');
  }
  $('hitCount').textContent = q ? `${hits}件` : '';
}
$('search').addEventListener('input', applySearch);

// ---------- 再生バー ----------
const playBtn = $<HTMLButtonElement>('playBtn');
const seekEl = $<HTMLInputElement>('seek');
const rateEl = $<HTMLSelectElement>('rate');
const SEEK_STEP = 5;
let lastIdx = -1;
let lastUserScroll = 0;

function totalSec(): number {
  const d = player.duration;
  if (Number.isFinite(d) && d > 0) return d;
  return current?.item.duration ?? 0;
}

function hasAudio() {
  return !!objectUrl;
}

function pausePlayer() {
  if (!player.paused) player.pause();
}

function updateBar() {
  const showBar = view === 'result';
  playbar.hidden = !showBar;
  const audio = hasAudio();
  $('pbFull').hidden = !audio;
  $('pbNone').hidden = audio;
  playbar.classList.toggle('noaudio', !audio);
  $('keyHint').hidden = !audio;
  setBarHeight();
}

function setBarHeight() {
  const h = playbar.hidden ? 0 : Math.ceil(playbar.getBoundingClientRect().height);
  document.documentElement.style.setProperty('--bar-h', `${h}px`);
}
new ResizeObserver(setBarHeight).observe(playbar);

function syncBar() {
  const total = totalSec();
  const t = Math.min(player.currentTime || 0, total || Infinity);
  seekEl.max = String(total);
  seekEl.value = String(t);
  $('pbTime').textContent = `${formatClock(t)} / ${formatClock(total)}`;
  const playing = !player.paused && !player.ended;
  playBtn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  playBtn.setAttribute('aria-label', playing ? '一時停止' : '再生');
}

function applyRate() {
  const r = Number(rateEl.value) || 1;
  player.defaultPlaybackRate = r;
  player.playbackRate = r;
}

function togglePlay() {
  if (!hasAudio()) return;
  if (player.paused) void player.play().catch(() => toast('再生できませんでした'));
  else player.pause();
}

function seekTo(sec: number) {
  if (!hasAudio()) return;
  player.currentTime = Math.max(0, Math.min(sec, totalSec() || sec));
  syncBar();
  syncHighlight(true);
}

playBtn.addEventListener('click', () => {
  playBtn.blur();
  togglePlay();
});
seekEl.addEventListener('input', () => seekTo(Number(seekEl.value)));
const endSeek = () => {
  seekEl.blur();
};
seekEl.addEventListener('change', endSeek);
seekEl.addEventListener('pointerup', endSeek);
rateEl.addEventListener('change', () => {
  applyRate();
  rateEl.blur();
});

for (const ev of ['timeupdate', 'loadedmetadata', 'durationchange', 'play', 'pause', 'ended', 'seeked']) {
  player.addEventListener(ev, () => {
    syncBar();
    syncHighlight(false);
  });
}

// 再生位置の区間を強調し、手動スクロール直後でなければ見える位置に保つ
function syncHighlight(force: boolean) {
  if (!current) return;
  const t = player.currentTime;
  const segs = current.item.segments;
  let idx = -1;
  if (hasAudio()) {
    for (let i = 0; i < segs.length; i++) {
      if (t >= segs[i].start) idx = i;
      else break;
    }
  }
  if (idx === lastIdx && !force) return;
  lastIdx = idx;
  const rows = Array.from(segsEl.children) as HTMLElement[];
  rows.forEach((r, i) => r.classList.toggle('playing', i === idx));
  if (idx >= 0 && rows[idx]) keepVisible(rows[idx], force);
}

function keepVisible(row: HTMLElement, force: boolean) {
  if (!force && Date.now() - lastUserScroll < 4000) return;
  const r = row.getBoundingClientRect();
  let top: number;
  let bottom: number;
  if (isDesktop()) {
    const m = mainCol.getBoundingClientRect();
    top = m.top + ($('result').querySelector('.res-head') as HTMLElement).offsetHeight;
    bottom = m.bottom;
  } else {
    top = (document.querySelector('.mobilebar') as HTMLElement).offsetHeight;
    bottom = window.innerHeight - (playbar.hidden ? 0 : playbar.offsetHeight);
  }
  if (r.top >= top + 8 && r.bottom <= bottom - 8) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  row.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
}

// ユーザー自身のスクロール操作を検知(自動スクロールの一時停止用)
const markUserScroll = () => (lastUserScroll = Date.now());
window.addEventListener('wheel', markUserScroll, { passive: true });
window.addEventListener('touchmove', markUserScroll, { passive: true });
window.addEventListener('pointerdown', (e) => {
  // スクロールバーのつまみ操作は、要素自体(子ではなく)へのpointerdownになる
  if (e.target === mainCol || e.target === document.documentElement) markUserScroll();
});

// ---------- キーボード ----------
function isEditing(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && side.classList.contains('open')) return setDrawer(false);
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
  if (view !== 'result' || !hasAudio() || isEditing(e.target)) return;
  if (e.key === ' ' || e.code === 'Space') {
    // ボタンにフォーカスがある時のSpaceはボタン本来の動作に任せる
    if (e.target instanceof HTMLButtonElement) return;
    e.preventDefault();
    togglePlay();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    seekTo(player.currentTime - SEEK_STEP);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    seekTo(player.currentTime + SEEK_STEP);
  }
});

// ---------- 書き出し・要約 ----------
document.querySelectorAll<HTMLButtonElement>('[data-exp]').forEach((b) =>
  b.addEventListener('click', () => {
    if (!current) return;
    const segs = current.item.segments;
    const base = baseName(current.item.fileName);
    switch (b.dataset.exp) {
      case 'txt':
        download(`${base}.txt`, toTXT(segs, $<HTMLInputElement>('withTs').checked), 'text/plain');
        break;
      case 'srt':
        download(`${base}.srt`, toSRT(segs), 'application/x-subrip');
        break;
      case 'vtt':
        download(`${base}.vtt`, toVTT(segs), 'text/vtt');
        break;
    }
  }),
);

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

$('copyAll').addEventListener('click', async () => {
  if (!current) return;
  const ok = await copyText(toTXT(current.item.segments, false));
  toast(ok ? '全文をコピーしました' : 'コピーに失敗しました');
});

$('summ').addEventListener('click', async () => {
  if (!current) return;
  const ok = await copyText(buildSummaryText(current.item.segments));
  if (!ok) return toast('コピーに失敗しました');
  // URLにテキストは載せない。クリップボード経由で貼り付けてもらう。
  window.open('https://claude.ai/new', '_blank', 'noopener');
  toast('コピーしました。Claudeに貼り付けてください');
});

// 要約の貼り付け欄: 入力すると履歴(IndexedDB)の summary に保存される
let summaryDirty = false;
const summaryEl = $<HTMLTextAreaElement>('summary');
summaryEl.addEventListener('input', () => {
  if (!current) return;
  current.item = withSummary(current.item, summaryEl.value);
  if (!current.id) return;
  summaryDirty = true;
  $('summaryState').textContent = '保存中…';
  scheduleSave(400);
});
summaryEl.addEventListener('blur', flushSaves);

// ---------- 新しく始める ----------
$('newBtn').addEventListener('click', () => {
  closeResult();
  if (!recording) clearInput();
  show('home');
  setDrawer(false);
  mainCol.scrollTo({ top: 0 });
});

// ---------- 履歴 ----------
function markCurrent() {
  document.querySelectorAll<HTMLElement>('#historyList li[data-id]').forEach((li) => {
    const on = !!current && Number(li.dataset.id) === current.id;
    li.classList.toggle('current', on);
    li.querySelector('.hist-open')?.toggleAttribute('aria-current', on);
  });
}

async function renderHistory() {
  const ul = $('historyList');
  let items: HistoryItem[] = [];
  try {
    items = await listHistory();
  } catch {
    ul.innerHTML = '<li class="empty">履歴を読み込めませんでした</li>';
    return;
  }
  ul.textContent = '';
  if (!items.length) {
    ul.innerHTML = '<li class="empty">まだ履歴はありません</li>';
    return;
  }
  for (const it of items) {
    const li = document.createElement('li');
    li.dataset.id = String(it.id);
    const open = document.createElement('button');
    open.className = 'hist-open';
    const nm = document.createElement('span');
    nm.className = 'hist-name';
    nm.textContent = it.fileName;
    nm.title = it.fileName;
    const meta = document.createElement('span');
    meta.className = 'hist-meta';
    meta.textContent = `${fmtDate(it.createdAt)} ・ ${formatClock(it.duration)}`;
    open.append(nm, meta);
    open.addEventListener('click', () => {
      setDrawer(false);
      if (current?.id === it.id && view === 'result') return;
      openResult(it, null);
    });
    const del = document.createElement('button');
    del.className = 'hist-del';
    del.textContent = '削除';
    del.setAttribute('aria-label', `${it.fileName} を削除`);
    del.addEventListener('click', async () => {
      if (!confirm(`「${it.fileName}」を履歴から削除しますか?`)) return;
      await deleteHistory(it.id);
      if (current?.id === it.id) {
        closeResult();
        show('home');
      }
      void renderHistory();
    });
    li.append(open, del);
    ul.appendChild(li);
  }
  markCurrent();
}
void renderHistory();
show('home');
