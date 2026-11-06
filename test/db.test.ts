import { describe, expect, it } from 'vitest';
import { withSummary } from '../src/db';
import type { HistoryItem } from '../src/types';

const base: HistoryItem = {
  id: 7,
  fileName: 'a.wav',
  createdAt: 1,
  duration: 10,
  segments: [{ start: 0, end: 2, text: 'こんにちは' }],
};

describe('withSummary', () => {
  it('要約を付ける(元は変更しない)', () => {
    const r = withSummary(base, '要点: テスト');
    expect(r.summary).toBe('要点: テスト');
    expect(r.id).toBe(7);
    expect(r.segments).toBe(base.segments);
    expect('summary' in base).toBe(false);
  });
  it('既存の要約を上書きできる', () => {
    const a = withSummary(base, '古い');
    expect(withSummary(a, '新しい').summary).toBe('新しい');
  });
  it('空・空白だけなら summary を持たない(旧データと同じ形)', () => {
    const a = withSummary(base, '古い');
    const r = withSummary(a, '  \n');
    expect('summary' in r).toBe(false);
    expect(r).toEqual(base);
  });
  it('summary の無い旧データも扱える', () => {
    expect(base.summary).toBeUndefined();
    expect(withSummary(base, '').segments).toHaveLength(1);
  });
});
