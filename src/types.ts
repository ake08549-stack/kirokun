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
}
