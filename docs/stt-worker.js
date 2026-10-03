// Cache verification may load small runtime code, but never fetch missing model files.
const originalFetch = globalThis.fetch.bind(globalThis);
function useCachedModelsOnly() {
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, globalThis.location?.href);
    if (url.hostname === 'cdn.jsdelivr.net' && url.pathname.startsWith('/npm/'))
      return originalFetch(input, init);
    for (const name of ['transformers-cache', 'kokoro-voices']) {
      const cache = await caches.open(name);
      const hit = await cache.match(input);
      if (hit) return hit;
    }
    throw new Error(
      'A required audio file is missing from this device. Find existing files or confirm a download.'
    );
  };
}
// Murmur — on-device Whisper speech recognition (no key, no server).
// in: {type:'init', device} · {type:'run', id, pcm(Float32Array 16 kHz mono)}   out: {type:'ready', device} · {type:'progress', p} · {type:'text', id, text} · {type:'error', id?, message}
let asr = null;
const TF = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/+esm';
async function init(m) {
  if (m.cacheOnly) useCachedModelsOnly();
  const { pipeline } = await import(TF);
  const tries =
    m.device === 'webgpu'
      ? [
          [
            'onnx-community/whisper-base.en',
            { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } }
          ],
          ['onnx-community/whisper-tiny.en', { device: 'wasm', dtype: 'q8' }]
        ]
      : [['onnx-community/whisper-tiny.en', { device: 'wasm', dtype: 'q8' }]];
  let err = null;
  for (const [model, opts] of tries) {
    try {
      asr = await pipeline('automatic-speech-recognition', model, {
        ...opts,
        progress_callback: (e) => {
          if (e && e.status === 'progress' && /onnx/.test(e.file || ''))
            postMessage({ type: 'progress', p: e.progress || 0 });
        }
      });
      await asr(new Float32Array(16000)); // warm-up
      postMessage({ type: 'ready', device: opts.device, model });
      return;
    } catch (e) {
      err = e;
    }
  }
  postMessage({ type: 'error', message: String((err && err.message) || err) });
}
// One inference at a time. A cancelled turn can remove its queued inference;
// an already-running result is ignored by the owning listening turn.
const queue = [];
let busy = false;
async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const m = queue.shift();
      try {
        const out = await asr(m.pcm);
        postMessage({ type: 'text', id: m.id, text: String((out && out.text) || '').trim() });
      } catch (e) {
        postMessage({ type: 'error', id: m.id, message: String((e && e.message) || e) });
      }
    }
  } finally {
    busy = false;
  }
}
onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'init')
    init(m).catch((e) => postMessage({ type: 'error', message: String(e.message || e) }));
  else if (m.type === 'run') {
    queue.push(m);
    pump();
  } else if (m.type === 'drop') {
    const at = queue.findIndex((x) => x.id === m.id);
    if (at >= 0) queue.splice(at, 1);
  }
};
