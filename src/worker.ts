/// <reference lib="webworker" />
import { env, pipeline } from '@huggingface/transformers';
import { ASR_OPTIONS, PROFILES, SAMPLE_RATE, type ProfileId } from './config';
import type { Segment } from './types';

// 外部送信は Hugging Face のモデル取得だけにするため、ONNX Runtime の wasm は自サイトから配る。
env.allowLocalModels = false;
env.useBrowserCache = true;
const onnxWasm = env.backends.onnx.wasm;
if (onnxWasm) {
  onnxWasm.wasmPaths = new URL(`${import.meta.env.BASE_URL}ort/`, self.location.href).href;
  if (!self.crossOriginIsolated) onnxWasm.numThreads = 1;
}

export type WorkerIn = {
  type: 'transcribe';
  profile: ProfileId;
  audio: Float32Array;
  /** 検証用: dtype の上書き(URL の ?enc= &dec= から) */
  dtype?: Record<string, string>;
  /** 検証用: モデルIDの上書き(URL の ?model=) */
  model?: string;
};
export type WorkerOut =
  | { type: 'status'; text: string }
  | { type: 'download'; loadedMB: number; totalMB: number }
  | { type: 'ready' }
  | { type: 'progress'; doneSec: number; totalSec: number }
  | { type: 'result'; segments: Segment[]; elapsedMs: number }
  | { type: 'error'; message: string };

const post = (m: WorkerOut) => self.postMessage(m);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cached: { key: string; asr: any } | null = null;

async function load(profileId: ProfileId, dtypeOverride?: Record<string, string>, modelOverride?: string) {
  const p = PROFILES[profileId];
  const dtype = dtypeOverride ?? p.dtype;
  const modelId = modelOverride ?? p.model;
  const key = profileId + modelId + JSON.stringify(dtype);
  if (cached?.key === key) return cached.asr;
  post({ type: 'status', text: 'モデルを準備しています…' });
  const files = new Map<string, { loaded: number; total: number }>();
  const asr = await pipeline('automatic-speech-recognition', modelId, {
    device: p.device,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dtype: dtype as any,
    progress_callback: (e: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (e.status === 'progress' && e.file && e.total) {
        files.set(e.file, { loaded: e.loaded ?? 0, total: e.total });
        let l = 0;
        let t = 0;
        for (const v of files.values()) {
          l += v.loaded;
          t += v.total;
        }
        post({ type: 'download', loadedMB: l / 1048576, totalMB: t / 1048576 });
      }
    },
  });
  cached = { key, asr };
  return asr;
}

self.onmessage = async (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  if (msg.type !== 'transcribe') return;
  try {
    const asr = await load(msg.profile, msg.dtype, msg.model);
    post({ type: 'ready' });

    const audio = msg.audio;
    const totalSec = audio.length / SAMPLE_RATE;
    const window = ASR_OPTIONS.chunk_length_s;
    const stride = ASR_OPTIONS.stride_length_s;
    const jump = window - 2 * stride;

    // transformers.js にはチャンク進捗のコールバックが無いので、generate の呼び出し回数で進捗を出す。
    const model = asr.model;
    const origGenerate = model.generate.bind(model);
    let done = 0;
    model.generate = async (...args: unknown[]) => {
      const r = await origGenerate(...args);
      done++;
      post({ type: 'progress', doneSec: Math.min(totalSec, done * jump + stride), totalSec });
      return r;
    };

    post({ type: 'status', text: '文字起こししています…' });
    post({ type: 'progress', doneSec: 0, totalSec });
    const t0 = performance.now();
    let out;
    try {
      out = await asr(audio, { ...ASR_OPTIONS });
    } finally {
      model.generate = origGenerate;
    }
    const chunks: { text: string; timestamp: [number, number | null] }[] = out.chunks ?? [];
    const segments: Segment[] = chunks
      .map((c, i) => ({
        start: c.timestamp?.[0] ?? 0,
        end: c.timestamp?.[1] ?? chunks[i + 1]?.timestamp?.[0] ?? Math.min(totalSec, (c.timestamp?.[0] ?? 0) + 2),
        text: c.text.trim(),
      }))
      .filter((s) => s.text.length > 0);
    if (segments.length === 0 && out.text?.trim()) {
      segments.push({ start: 0, end: totalSec, text: out.text.trim() });
    }
    post({ type: 'result', segments, elapsedMs: performance.now() - t0 });
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
