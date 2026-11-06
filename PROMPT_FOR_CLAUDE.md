# Claudeへの指示文(この下を全部コピーして Claude Code に貼り付け)

---

このフォルダに、ブラウザだけで動く日本語の文字起こしWebアプリ「きろくん」を作ってください。完成したら `npm start` で起動できる状態にして、起動方法を教えてください。

## 方針
- Vite + TypeScript の静的サイト。サーバー・外部API・APIキー・アクセス解析は使わない。
- 文字起こしは `@huggingface/transformers`(v3系)を Web Worker の中で動かす。画面が固まらないようにする。
- 音声はパソコンの外に出さない。通信するのは Hugging Face からのモデル取得だけ。
- ONNX Runtime の wasm ファイルは CDN から読まず、`node_modules` から `public/ort/` にコピーして自分で配信する(`postinstall` で自動コピー)。

## モデル(動作確認済みの組み合わせ)
- WebGPU が使える場合: `onnx-community/whisper-large-v3-turbo`、`device: 'webgpu'`、dtype は `{ encoder_model: 'q4', decoder_model_merged: 'q4' }`
  - fp16 は Mac(Metal)の WebGPU で「日日日…」と出力が崩れたので使わない
- WebGPU が使えない場合: `onnx-community/whisper-base`、`device: 'wasm'`、dtype は q8。画面に「軽量モード(精度低め)」と出す
- 文字起こしの設定: `language: 'japanese'`, `task: 'transcribe'`, `chunk_length_s: 30`, `stride_length_s: 5`, `return_timestamps: true`

## 機能
1. 音声・動画ファイルのドラッグ&ドロップ/選択と、マイク録音。時間制限なし。`decodeAudioData` で読み、`OfflineAudioContext` で16kHzモノラルに変換する。
2. 開始前に「初回は約0.7GBのダウンロードがあります」と表示。ダウンロードの%とMB、文字起こしの処理済み秒数を表示。キャンセルボタンも付ける。
3. 結果は `[mm:ss]` 付きの区間リスト。区間ごとにその場で編集でき、全文検索でヒットをハイライトし、時刻クリックで元音声のその位置から再生する。
4. TXT(タイムスタンプ有/無)、SRT、VTT のダウンロードと、全文コピー。
5. 「Claudeで要約」ボタン: 「以下は会議/録音の文字起こしです。議事録として 1.要点3行 2.決定事項 3.ToDo(担当・期限が分かれば) 4.次回への持ち越し の形でまとめてください。」と全文をクリップボードにコピーし、https://claude.ai/new を新しいタブで開く(URLに本文は載せない)。
6. 履歴を IndexedDB に保存(ファイル名・日時・長さ・区間)。一覧から再表示・削除できる。「データはこの端末の中だけに保存されます」と書く。
7. 日本語UI、シンプルで見やすく。スマホ幅でも崩れない。

## package.json のスクリプト
- `npm start` = ビルドしてから `vite preview --port 4173 --open`(ブラウザが自動で開く)

## 確認してほしいこと
- `npm run build` がエラーなく通る
- SRT/VTT/TXT の書き出し関数に単体テスト(vitest)を書いて通す
- 最後に、私が何をすれば起動できるかを、パソコンに詳しくない人向けに3行で教えて
