# きろくん 開発メモ

ブラウザだけで動く、日本語の文字起こしWebアプリです。Nottaなどの有料文字起こしの代わりに、無料・登録なし・音声を外部に送らずに使えます。

- 表示名は `src/config.ts` の `APP_NAME` 1か所で変更できます(`index.html` の title は起動時に上書きされます)。
- サーバー不要の静的サイトです(Vite + TypeScript)。Cloudflare Pages などにそのまま置けます。

## 使い方

1. 音声・動画ファイル(mp3 / m4a / wav / mp4 / webm など、ブラウザが読めるもの)をドロップするか、「マイクで録音」を押します。時間制限はありません。
2. モードを確認して「文字起こしを開始」を押します。
   - WebGPUが使える端末: Whisper large-v3-turbo(q4量子化・初回約0.7GB)
   - WebGPUが使えない端末: 軽量モード(whisper-base・精度低め・約0.1GB)
   - 初回だけモデルのダウンロードがあります。2回目以降はブラウザに保存されたモデルを使います。
3. 結果画面は区間ごとの一覧(左に `[mm:ss]`、右に編集できる本文)です。タイトル横の検索欄で全文検索、時刻クリックでその位置から再生します。
4. 画面右のパネルから TXT(タイムスタンプ有無を選択)/ SRT / VTT のダウンロード、全文コピーができます。
5. 「Claudeで要約」は、議事録用の指示文と全文をクリップボードにコピーして claude.ai を新しいタブで開きます。貼り付けて送信してください(URLにテキストは載せません)。返ってきた要約は同じパネルの貼り付け欄に入れると、履歴の `summary` として保存されます。
6. 履歴は IndexedDB に保存され、左の一覧から再表示・削除できます。
7. 音声がある間(文字起こし直後)は、画面下の再生バーで再生・一時停止・シーク・速度変更(1.0 / 1.25 / 1.5 / 2.0)ができ、再生中の区間がハイライトされて自動で追従します。Space で再生/停止、← → で5秒移動(入力欄の操作中は無効)。

## 画面構成

`src/main.ts` が素のDOMで組み立てています。PC幅(1024px以上)は3列で、左は履歴と「新しく文字起こし」、中央はホーム/進捗/結果の切り替え、右は書き出しと要約のパネル(結果表示中のみ)です。結果表示中は `<audio>`(非表示)を制御する再生バーが画面下に固定されます。履歴から開いた結果は音声がないため、再生バーの代わりに案内文を出します。1024px未満では左列がハンバーガーで開くドロワーになり、右パネルは中央列の下に回ります。スタイルは `src/style.css` の先頭の変数(生成りの紙と深緑)で調整できます。外部のアイコンフォント・画像は使っておらず、アイコンは `main.ts` 内の自作SVGです。履歴の `summary` は任意項目なので、これがない従来のデータもそのまま開けます(`db.ts` の `withSummary`)。

## 起動

```bash
npm install          # postinstall で ONNX Runtime の wasm を public/ort/ にコピー
npm run dev          # http://localhost:5173
npm run build        # dist/ に静的ファイルを出力
npm run preview      # http://localhost:4173 (build後)
npm test             # 書き出し関数・履歴(summary)の単体テスト(vitest)
```

画面の確認用スクリプト: `test/ui.mjs`(文字起こしを偽物に差し替え、再生・ハイライト・自動スクロール・キー操作・要約の保存と復元・375px表示を数秒で確認)と、`test/e2e.mjs`(実際にモデルを動かす。Mac mini 向け)があります。どちらも `playwright-core` が使えるフォルダで `node test/ui.mjs <プロジェクトのパス>` のように実行します。

マイク録音は `localhost` または https でのみ動きます。

## 仕組み

- 文字起こしは Web Worker 内で [transformers.js](https://github.com/huggingface/transformers.js) (`@huggingface/transformers` v3) を使って実行します。メイン画面は固まりません。
- 音声は `decodeAudioData` で読み込み、`OfflineAudioContext` で 16kHz モノラルに変換します。
- 30秒窓・5秒ストライドで分割し、`return_timestamps: true` で区間ごとの時刻を得ます。進捗は処理済みの窓数から概算しています。
- 動作確認の結果、fp16 のモデルは Apple(Metal) の WebGPU で出力が崩れたため、q4 を既定にしています。検証用に URL の `?profile=wasm` や `?enc=fp16&dec=q4` でモード・dtype を上書きできます。
- モデルの設定は `src/config.ts` の `PROFILES` にまとめています(モデル名・dtype・目安サイズ)。
- キャンセルは Worker を破棄して行います(モデルはブラウザキャッシュに残るので、再開は速いです)。

## プライバシー

- 音声は端末の外に出ません。通信するのは Hugging Face からのモデル取得だけです。
- アナリティクス、外部API、APIキーは使いません。ONNX Runtime の wasm も自サイトから配信します。
- 履歴(ファイル名・日時・長さ・文字起こし結果)はこの端末のブラウザ内(IndexedDB)だけに保存されます。音声本体は保存しません。
- 「Claudeで要約」は、ボタンを押したときだけ全文をクリップボードにコピーします。送信はご自身の貼り付け操作で行われます。

## ライセンス・表記

- 本アプリのコード: MIT
- [transformers.js](https://github.com/huggingface/transformers.js): Apache-2.0
- [Whisper large-v3-turbo / base](https://github.com/openai/whisper)(ONNX変換: onnx-community): コードMIT・モデル重みApache-2.0
- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime): MIT

## 既知の制約(v0.1)

- 履歴から開いた結果には音声がないため、再生はできません。
- 進捗(処理済み秒)は窓単位の概算です。
- Cross-Origin Isolation(COOP/COEP)ヘッダを付けていないため、WASMモードは1スレッドで動きます。
