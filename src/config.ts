// アプリ名(仮)。差し替えはここ1か所だけでよい。
export const APP_NAME = 'きろくん';
export const APP_TAGLINE = '無料・登録なし・音声は外部に送らない、日本語の文字起こし';

export type ProfileId = 'webgpu' | 'wasm';

export interface ModelProfile {
  id: ProfileId;
  label: string;
  model: string;
  device: 'webgpu' | 'wasm';
  dtype: Record<string, string>;
  approxMB: number;
  note: string;
}

// WebGPU 用は large-v3-turbo(q4)。2026-11-06 実測(41秒の日本語会議原稿・TTS)で
// 数字正規化後CER 0.0%。kotoba v2.2 q4 は 13.1%(誤認識+文末欠落)、base は 9.3% だった。
export const PROFILES: Record<ProfileId, ModelProfile> = {
  // fp16 のエンコーダ/デコーダは Apple(Metal) の WebGPU で出力が崩れたため(実測)、q4 を既定にしている。
  webgpu: {
    id: 'webgpu',
    label: '高精度(WebGPU)',
    model: 'onnx-community/whisper-large-v3-turbo',
    device: 'webgpu',
    dtype: { encoder_model: 'q4', decoder_model_merged: 'q4' },
    approxMB: 730,
    note: '高精度モデルを使います。初回のみ約0.7GBをダウンロードします。',
  },
  wasm: {
    id: 'wasm',
    label: '軽量モード(精度低め)',
    model: 'onnx-community/whisper-base',
    device: 'wasm',
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
    approxMB: 100,
    note: 'WebGPUが使えない端末向けの軽量モデルです。精度は低めです。初回のみ約0.1GBをダウンロードします。',
  },
};

export const ASR_OPTIONS = {
  language: 'japanese',
  task: 'transcribe',
  chunk_length_s: 30,
  stride_length_s: 5,
  return_timestamps: true,
} as const;

export const SAMPLE_RATE = 16000;
