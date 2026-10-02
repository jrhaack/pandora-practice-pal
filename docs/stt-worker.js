// Murmur — on-device Whisper speech recognition (no key, no server).
// in: {type:'init', device} · {type:'run', id, pcm(Float32Array 16 kHz mono)}   out: {type:'ready', device} · {type:'progress', p} · {type:'text', id, text} · {type:'error', id?, message}
let asr = null;
const TF = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/+esm';
async function init(m) {
  const { pipeline } = await import(TF);
  const tries = m.device === 'webgpu'
    ? [['onnx-community/whisper-base.en', { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } }], ['onnx-community/whisper-tiny.en', { device: 'wasm', dtype: 'q8' }]]
    : [['onnx-community/whisper-tiny.en', { device: 'wasm', dtype: 'q8' }]];
  let err = null;
  for (const [model, opts] of tries) {
    try {
      asr = await pipeline('automatic-speech-recognition', model, { ...opts, progress_callback: (e) => { if (e && e.status === 'progress' && /onnx/.test(e.file || '')) postMessage({ type: 'progress', p: e.progress || 0 }); } });
      await asr(new Float32Array(16000)); // warm-up
      postMessage({ type: 'ready', device: opts.device, model }); return;
    } catch (e) { err = e; }
  }
  postMessage({ type: 'error', message: String(err && err.message || err) });
}
onmessage = async (ev) => {
  const m = ev.data;
  if (m.type === 'init') return init(m);
  if (m.type === 'run') {
    try { const out = await asr(m.pcm); postMessage({ type: 'text', id: m.id, text: String(out && out.text || '').trim() }); }
    catch (e) { postMessage({ type: 'error', id: m.id, message: String(e && e.message || e) }); }
  }
};
