import { describe, expect, it } from 'vitest';
import {
  buildSummaryText,
  formatClock,
  normalizeSegments,
  SUMMARY_PROMPT,
  toSRT,
  toTXT,
  toVTT,
} from '../src/exporters';

const segs = [
  { start: 0, end: 3.5, text: 'こんにちは。' },
  { start: 3.5, end: 65.25, text: '今日の議題は\n三つです。' },
  { start: 3725.001, end: 3730, text: '最後です。' },
];

describe('formatClock', () => {
  it('mm:ss と h:mm:ss', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(65.9)).toBe('01:05');
    expect(formatClock(3725)).toBe('1:02:05');
  });
});

describe('toTXT', () => {
  it('タイムスタンプ有', () => {
    expect(toTXT(segs, true)).toBe(
      '[00:00] こんにちは。\n[00:03] 今日の議題は 三つです。\n[1:02:05] 最後です。',
    );
  });
  it('タイムスタンプ無', () => {
    expect(toTXT(segs, false)).toBe('こんにちは。\n今日の議題は 三つです。\n最後です。');
  });
});

describe('toSRT', () => {
  it('連番・カンマ区切りのミリ秒', () => {
    expect(toSRT(segs)).toBe(
      [
        '1\n00:00:00,000 --> 00:00:03,500\nこんにちは。',
        '2\n00:00:03,500 --> 00:01:05,250\n今日の議題は 三つです。',
        '3\n01:02:05,001 --> 01:02:10,000\n最後です。',
      ].join('\n\n') + '\n',
    );
  });
  it('空配列は空文字', () => {
    expect(toSRT([])).toBe('');
  });
});

describe('toVTT', () => {
  it('WEBVTT ヘッダとピリオド区切り', () => {
    const v = toVTT(segs);
    expect(v.startsWith('WEBVTT\n\n00:00:00.000 --> 00:00:03.500\nこんにちは。')).toBe(true);
    expect(v).toContain('01:02:05.001 --> 01:02:10.000');
    expect(v).not.toContain(',');
  });
});

describe('normalizeSegments', () => {
  it('終了欠落・空区間を補正', () => {
    const r = normalizeSegments([
      { start: 1, end: NaN, text: 'a' },
      { start: 5, end: 4, text: '  ' },
      { start: 6, end: 6, text: 'b' },
    ]);
    expect(r).toEqual([
      { start: 1, end: 5, text: 'a' },
      { start: 6, end: 8, text: 'b' },
    ]);
  });
});

describe('buildSummaryText', () => {
  it('指示文+全文', () => {
    const t = buildSummaryText(segs);
    expect(t.startsWith(SUMMARY_PROMPT + '\n\n')).toBe(true);
    expect(t.endsWith('最後です。')).toBe(true);
  });
});
