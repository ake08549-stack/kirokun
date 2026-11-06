import type { Segment } from './types';

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** [mm:ss] 表示用。1時間以上は h:mm:ss。 */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}

function formatCue(sec: number, sep: ',' | '.'): string {
  const total = Math.max(0, Math.round(sec * 1000));
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  const h = Math.floor(total / 3600000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms, 3)}`;
}

function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/** 終了時刻が欠落・逆転している区間を補正し、空の区間を除く。 */
export function normalizeSegments(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const text = oneLine(seg.text);
    if (!text) continue;
    const start = Number.isFinite(seg.start) ? Math.max(0, seg.start) : 0;
    let end = Number.isFinite(seg.end) ? seg.end : NaN;
    if (!(end > start)) {
      const next = segments[i + 1];
      end = next && next.start > start ? next.start : start + 2;
    }
    out.push({ start, end, text });
  }
  return out;
}

export function toTXT(segments: Segment[], withTimestamps: boolean): string {
  const segs = normalizeSegments(segments);
  return segs
    .map((s) => (withTimestamps ? `[${formatClock(s.start)}] ${s.text}` : s.text))
    .join('\n');
}

export function toSRT(segments: Segment[]): string {
  const segs = normalizeSegments(segments);
  return (
    segs
      .map((s, i) => `${i + 1}\n${formatCue(s.start, ',')} --> ${formatCue(s.end, ',')}\n${s.text}`)
      .join('\n\n') + (segs.length ? '\n' : '')
  );
}

export function toVTT(segments: Segment[]): string {
  const segs = normalizeSegments(segments);
  const body = segs
    .map((s) => `${formatCue(s.start, '.')} --> ${formatCue(s.end, '.')}\n${s.text}`)
    .join('\n\n');
  return `WEBVTT\n\n${body}${segs.length ? '\n' : ''}`;
}

export const SUMMARY_PROMPT =
  '以下は会議/録音の文字起こしです。議事録として 1.要点3行 2.決定事項 3.ToDo(担当・期限が分かれば) 4.次回への持ち越し の形でまとめてください。';

export function buildSummaryText(segments: Segment[]): string {
  return `${SUMMARY_PROMPT}\n\n${toTXT(segments, false)}`;
}
