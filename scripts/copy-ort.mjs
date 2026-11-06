// ONNX Runtime の wasm を public/ort/ に複製する(CDNに取りに行かず自サイトから配るため)
import { copyFileSync, mkdirSync } from 'node:fs';
const src = 'node_modules/onnxruntime-web/dist/';
mkdirSync('public/ort', { recursive: true });
for (const f of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
  copyFileSync(src + f, 'public/ort/' + f);
}
console.log('copied ort wasm -> public/ort');
