import { SAMPLE_RATE } from './config';

/** 音声/動画ファイル(Blob)を 16kHz モノラル Float32 にデコードする。 */
export async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  const buf = await blob.arrayBuffer();
  const Ctx: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(buf);
  } catch {
    throw new Error('このファイルの音声を読み取れませんでした。別の形式(mp3 / m4a / wav / mp4 など)でお試しください。');
  } finally {
    void ctx.close();
  }
  const length = Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, length, SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination); // 多チャンネルは自動でモノラルにダウンミックスされる
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

/** マイク録音の簡易ラッパ。 */
export class Recorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream);
    this.rec.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.rec.start(1000);
  }

  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const rec = this.rec;
      if (!rec) return reject(new Error('録音が開始されていません'));
      rec.onstop = () => {
        this.stream?.getTracks().forEach((t) => t.stop());
        resolve(new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' }));
      };
      rec.stop();
    });
  }
}
