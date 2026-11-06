export interface Segment {
  start: number; // 秒
  end: number; // 秒
  text: string;
}

export interface HistoryItem {
  id: number;
  fileName: string;
  createdAt: number; // epoch ms
  duration: number; // 秒
  segments: Segment[];
  /** Claudeの要約を貼り付けて保存したもの(任意。古い履歴には無い) */
  summary?: string;
}
