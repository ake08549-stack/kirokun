import './style.css';
import { APP_NAME, APP_TAGLINE, PROFILES, SAMPLE_RATE, type ProfileId } from './config';
import { Recorder, decodeToMono16k } from './audio';
import { deleteHistory, listHistory, saveHistory, updateHistory } from './db';
import { buildSummaryText, formatClock, toSRT, toTXT, toVTT } from './exporters';
import type { HistoryItem, Segment } from './types';
import type { WorkerIn, WorkerOut } from './worker';

document.title = `${APP_NAME} - 日本語文字起こし`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

document.getElementById('app')!.innerHTML = `
<header class="top">
  <h1>${APP_NAME}</h1>
  <p class="tag">${APP_TAGLINE}</p>
</header>
<main>
  <section id="home" class="card">
    <p class="lead">Nottaなどの有料文字起こしの代わりに、無料・登録なし・音声を外部に送らずに使えます。処理はすべてこのブラウザの中で行います。</p>
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
  </section>

  <section id="progress" class="card" hidden>
    <h2 id="progTitle">準備中…</h2>
    <div class="bar"><div id="barFill"></div></div>
    <p id="progText" class="muted"></p>
    <button id="cancel" class="btn ghost">キャンセル</button>
  </section>

  <section id="result" class="card" hidden>
    <div class="result-head">
      <h2 id="resName"></h2>
      <button id="back" class="btn ghost small">新しく始める</button>
    </div>
    <audio id="player" controls hidden></audio>
    <p id="noAudio" class="muted" hidden>履歴から開いたため音声はありません(音声は保存していません)。</p>
    <div class="toolbar">
      <input id="search" type="search" placeholder="全文検索" aria-label="全文検索" />
      <span id="hitCount" class="muted"></span>
    </div>
    <div id="segs" class="segs"></div>
    <div class="exports">
      <label class="chk"><input id="withTs" type="checkbox" checked /> TXTにタイムスタンプを付ける</label>
      <div class="row wrap">
        <button class="btn small" data-exp="txt">TXT</button>
        <button class="btn small" data-exp="srt">SRT</button>
        <button class="btn small" data-exp="vtt">VTT</button>
        <button class="btn small ghost" id="copyAll">全文コピー</button>
        <button class="btn small accent" id="summ">Claudeで要約</button>
      </div>
    </div>
  </section>

  <section id="historyBox" class="card">
    <h2>履歴</h2>
    <p class="muted">データはこの端末の中だけに保存されます(音声本体は保存しません)。</p>
    <ul id="historyList" class="history"></ul>
  </section>
</main>
<div id="toast" class="toast" role="status" hidden></div>
<footer class="foot">モデル: OpenAI Whisper(large-v3-turbo / base)・推論: transformers.js(Apache-2.0)</footer>
`;

// ---------- 状態 ----------
let profileId: ProfileId = 'wasm';
let pickedBlob: Blob | null = null;
let pickedName = '';
let audioData: Float32Array | null = null;
let worker: Worker | null = null;
let current: { id: number; item: HistoryItem } | null = null;
let objectUrl: string | null = null;
const recorder = new Recorder();
let recording = false;

// ---------- ユーティリティ ----------
function show(id: 'home' | 'progress' | 'result') {
  for (const s of ['home', 'progress', 'result']) $(s).hidden = s !== id;
  $('historyBox').hidden = id === 'progress';
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
  show('progress');
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
const player = $<HTMLAudioElement>('player');

function openResult(item: HistoryItem, audio: Blob | null) {
  current = { id: item.id, item };
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = audio ? URL.createObjectURL(audio) : null;
  player.hidden = !objectUrl;
  $('noAudio').hidden = !!objectUrl;
  if (objectUrl) player.src = objectUrl;
  else player.removeAttribute('src');
  $('resName').textContent = item.fileName;
  ($('search') as HTMLInputElement).value = '';
  renderSegments();
  show('result');
  window.scrollTo({ top: 0 });
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
      if (!objectUrl) return toast('この履歴には音声がありません');
      player.currentTime = s.start;
      void player.play();
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
    row.append(ts, tx);
    segsEl.appendChild(row);
  });
  applySearch();
}

let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    if (current && current.id) void updateHistory(current.item);
  }, 600);
}

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

// 再生位置の区間を強調
player.addEventListener('timeupdate', () => {
  if (!current) return;
  const t = player.currentTime;
  const segs = current.item.segments;
  const idx = segs.findIndex((s, i) => t >= s.start && (t < (segs[i + 1]?.start ?? Infinity)));
  Array.from(segsEl.children).forEach((r, i) => r.classList.toggle('playing', i === idx));
});

// 書き出し
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

$('back').addEventListener('click', () => {
  player.pause();
  show('home');
});

// ---------- 履歴 ----------
async function renderHistory() {
  const ul = $('historyList');
  let items: HistoryItem[] = [];
  try {
    items = await listHistory();
  } catch {
    ul.innerHTML = '<li class="muted">履歴を読み込めませんでした</li>';
    return;
  }
  ul.textContent = '';
  if (!items.length) {
    ul.innerHTML = '<li class="muted">まだ履歴はありません</li>';
    return;
  }
  for (const it of items) {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.className = 'hist-open';
    const nm = document.createElement('span');
    nm.className = 'hist-name';
    nm.textContent = it.fileName;
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = `${fmtDate(it.createdAt)} ・ ${formatClock(it.duration)}`;
    open.append(nm, meta);
    open.addEventListener('click', () => openResult(it, null));
    const del = document.createElement('button');
    del.className = 'btn ghost small';
    del.textContent = '削除';
    del.addEventListener('click', async () => {
      if (!confirm(`「${it.fileName}」を履歴から削除しますか?`)) return;
      await deleteHistory(it.id);
      void renderHistory();
    });
    li.append(open, del);
    ul.appendChild(li);
  }
}
void renderHistory();
