// Murmur — Kokoro neural voice, generated on the phone (WebGPU) in a background worker.
// Messages in:  {type:'init', device, dtype} · {type:'gen', id, text, voice, speed}
// Messages out: {type:'ready', device} · {type:'progress', p} · {type:'audio', id, pcm(Float32Array), sr} · {type:'error', id?, message}
let tts = null, device = null;
const KOKORO = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm';
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

async function init(msg) {
  const { KokoroTTS } = await import(KOKORO);
  const tries = msg.device === 'webgpu' ? [['webgpu', msg.dtype || 'fp32'], ['wasm', 'q8']] : [['wasm', 'q8']];
  let lastErr = null;
  for (const [dev, dtype] of tries) {
    try {
      tts = await KokoroTTS.from_pretrained(MODEL, {
        dtype, device: dev,
        progress_callback: (e) => { if (e && e.status === 'progress' && e.file && /onnx/.test(e.file)) postMessage({ type: 'progress', p: e.progress || 0 }); },
      });
      device = dev;
      await tts.generate('Ready.', { voice: 'af_heart' }); // warm-up compiles the shaders
      postMessage({ type: 'ready', device });
      return;
    } catch (e) { lastErr = e; }
  }
  postMessage({ type: 'error', message: 'voice could not load: ' + (lastErr && lastErr.message || lastErr) });
}

const queue = []; let busy = false;
async function pump() {
  if (busy) return; busy = true;
  while (queue.length) {
    const m = queue.shift();
    try {
      const a = await tts.generate(m.text, { voice: m.voice || 'af_heart', speed: m.speed || 1 });
      const pcm = a.audio instanceof Float32Array ? a.audio : new Float32Array(a.audio);
      postMessage({ type: 'audio', id: m.id, pcm, sr: a.sampling_rate }, [pcm.buffer]);
    } catch (e) { postMessage({ type: 'error', id: m.id, message: String(e && e.message || e) }); }
  }
  busy = false;
}

onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'init') init(m);
  else if (m.type === 'gen') { if (m.urgent) queue.unshift(m); else queue.push(m); pump(); }
  else if (m.type === 'drop') { for (let i = queue.length - 1; i >= 0; i--) if (!m.keep || !m.keep.includes(queue[i].id)) queue.splice(i, 1); }
};
