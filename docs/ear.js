/* Murmur — voice input that works in every browser.
   Engines, tried in this order (Settings → Microphone can force one):
   1. built-in  – the browser's speech recognition (Chrome, the installed app). Fast and free, but always uses the
                  system's default microphone.
   2. on-device – Whisper running on this phone/computer (WebGPU, or WebAssembly in Firefox). No key, no server;
                  a ~80 MB model downloads once.
   3. cloud     – Whisper on the built-in Murmur cloud (no key), or on Groq if a Groq key is set.
   Engines 2 and 3 record from the microphone chosen in Settings, clean the sound (echo cancellation, noise
   suppression, auto gain), detect when you stop talking, and resample to 16 kHz mono PCM — no lossy codec. */
'use strict';
const Ear = (() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const st = { nativeOk: !!SR, nativeBroken: false, stream: null, streamDev: null, abort: null, lastError: '', level: 0,
    local: 'off', localProgress: 0, localDevice: null, worker: null, seq: 0, waiters: new Map(), listeners: new Set() };
  const emit = () => { for (const f of st.listeners) try { f(st); } catch (e) { } };
  const canRecord = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const groqKey = () => (settings.keys && settings.keys.groq) || '';
  const want = () => settings.earMode || 'auto';

  // which engine will be used right now
  function mode() {
    const w = want(), dev = !!settings.micId;
    if (w === 'native') return st.nativeOk ? 'native' : 'none';
    if (w === 'local') return canRecord() ? 'local' : 'none';
    if (w === 'groq') return canRecord() ? 'groq' : 'none';
    // auto: built-in unless it failed here or a specific microphone was chosen (built-in cannot be pointed at one)
    if (st.nativeOk && !st.nativeBroken && !dev) return 'native';
    if (canRecord()) return 'local';
    return canRecord() ? 'groq' : 'none';
  }

  // ---------- built-in recogniser
  function listenNative(ms) {
    return new Promise((resolve) => {
      const r = new SR();
      r.lang = 'en-US'; r.continuous = false; r.interimResults = false; r.maxAlternatives = 5;
      let done = false;
      const finish = (val) => { if (done) return; done = true; clearTimeout(t); try { r.stop(); } catch (e) { } st.abort = null; resolve(val); };
      const t = setTimeout(() => { try { r.abort(); } catch (e) { } finish(null); }, ms);
      st.abort = () => { try { r.abort(); } catch (e) { } finish(null); };
      r.onresult = (ev) => { const alts = []; for (const res of ev.results) for (let i = 0; i < res.length; i++) alts.push(res[i].transcript); finish(alts); };
      r.onerror = (ev) => {
        if (['network', 'service-not-allowed', 'language-not-supported', 'audio-capture'].includes(ev.error)) { st.nativeBroken = true; st.lastError = 'The built-in recogniser is not available here (' + ev.error + '); switched to on-device Whisper.'; emit(); finish({ retry: true }); return; }
        if (ev.error === 'not-allowed') { st.lastError = 'Microphone permission is blocked. Open Settings → Microphone → Fix permission.'; emit(); }
        finish(null);
      };
      r.onend = () => finish(null);
      try { r.start(); } catch (e) { finish(null); }
    });
  }

  // ---------- recording (shared by on-device and Groq)
  async function stream() {
    const id = settings.micId || '';
    if (st.stream && st.stream.active && st.streamDev === id) return st.stream;
    if (st.stream) st.stream.getTracks().forEach(t => t.stop());
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    if (id) audio.deviceId = { exact: id };
    try { st.stream = await navigator.mediaDevices.getUserMedia({ audio }); }
    catch (e) {
      if (id && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) { settings.micId = ''; saveSettings(); st.stream = await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: undefined } }); }
      else throw e;
    }
    st.streamDev = id; emit();
    return st.stream;
  }
  // records until ~0.8 s of quiet after speech; returns Float32Array at 16 kHz, or null
  async function capture(ms, onLevel) {
    let s; try { s = await stream(); } catch (e) { st.lastError = e.name === 'NotAllowedError' ? 'Microphone permission is blocked. Open Settings → Microphone → Fix permission.' : 'Microphone unavailable: ' + (e.message || e.name); emit(); return null; }
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') { try { await ac.resume(); } catch (e) { } }
    const src = ac.createMediaStreamSource(s);
    const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90;   // cut road rumble
    const proc = ac.createScriptProcessor(2048, 1, 1); const sink = ac.createGain(); sink.gain.value = 0;
    src.connect(hp); hp.connect(proc); proc.connect(sink); sink.connect(ac.destination);
    const chunks = []; let noise = 0.008, spoke = false, lastVoice = 0, pre = []; const t0 = performance.now();
    const result = await new Promise((resolve) => {
      let done = false;
      const stop = (keep) => { if (done) return; done = true; proc.onaudioprocess = null; resolve(keep); };
      st.abort = () => stop(false);
      proc.onaudioprocess = (e) => {
        const x = e.inputBuffer.getChannelData(0); let en = 0; for (let i = 0; i < x.length; i++) en += x[i] * x[i];
        const rms = Math.sqrt(en / x.length); st.level = rms; if (onLevel) onLevel(rms);
        const now = performance.now(); const copy = new Float32Array(x);
        if (!spoke) { noise = noise * 0.96 + rms * 0.04; pre.push(copy); if (pre.length > 6) pre.shift(); }   // keep ~0.25 s before speech starts
        if (rms > Math.max(0.018, noise * 2.8)) { if (!spoke) { spoke = true; chunks.push(...pre); } lastVoice = now; }
        if (spoke) chunks.push(copy);
        if (spoke && now - lastVoice > 800) stop(true);
        if (!spoke && now - t0 > ms) stop(false);
        if (now - t0 > ms + 9000) stop(spoke);
      };
    });
    st.abort = null;
    try { src.disconnect(); proc.disconnect(); } catch (e) { }
    const rate = ac.sampleRate; try { ac.close(); } catch (e) { }
    if (!result || !chunks.length) return null;
    const n = chunks.reduce((a, c) => a + c.length, 0); const all = new Float32Array(n); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
    // resample to 16 kHz with the browser's own (band-limited) resampler, then normalise the level
    const outLen = Math.ceil(n * 16000 / rate); const off = new OfflineAudioContext(1, outLen, 16000);
    const b = off.createBuffer(1, n, rate); b.copyToChannel(all, 0); const bs = off.createBufferSource(); bs.buffer = b; bs.connect(off.destination); bs.start();
    const pcm = (await off.startRendering()).getChannelData(0);
    let peak = 0; for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
    if (peak > 0.0001) { const g = Math.min(8, 0.9 / peak); for (let i = 0; i < pcm.length; i++) pcm[i] *= g; }
    return pcm;
  }
  function wav(pcm) { // 16-bit PCM WAV, 16 kHz mono
    const b = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(b); const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
    return new Blob([b], { type: 'audio/wav' });
  }

  // ---------- on-device Whisper
  async function initLocal() {
    if (st.local === 'loading' || st.local === 'ready') return;
    st.local = 'loading'; st.localProgress = 0; emit();
    let dev = 'wasm'; try { if (navigator.gpu && await navigator.gpu.requestAdapter()) dev = 'webgpu'; } catch (e) { }
    st.worker = new Worker('stt-worker.js', { type: 'module' });
    st.worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'progress') { st.localProgress = m.p; emit(); }
      else if (m.type === 'ready') { st.local = 'ready'; st.localDevice = m.device; settings.localStt = true; try { saveSettings(); } catch (e) { } emit(); }
      else if (m.type === 'text' || (m.type === 'error' && m.id != null)) { const r = st.waiters.get(m.id); st.waiters.delete(m.id); if (r) r(m.type === 'text' ? m.text : null); }
      else if (m.type === 'error') { st.local = 'failed'; st.lastError = 'On-device recogniser could not load: ' + m.message; emit(); }
    };
    st.worker.postMessage({ type: 'init', device: dev });
  }
  async function transcribeLocal(pcm) {
    if (st.local !== 'ready') { initLocal(); return null; } // still downloading: the cloud answers this time
    const id = ++st.seq; st.worker.postMessage({ type: 'run', id, pcm }, [pcm.buffer]);
    return await new Promise(r => { st.waiters.set(id, r); setTimeout(() => { if (st.waiters.has(id)) { st.waiters.delete(id); r(null); } }, 15000); });
  }
  async function transcribeGroq(pcm) {
    try {
      const fd = new FormData(); fd.append('file', wav(pcm), 'answer.wav'); fd.append('model', 'whisper-large-v3-turbo'); fd.append('language', 'en'); fd.append('response_format', 'json');
      fd.append('prompt', 'Option one, option two, true, false, milliamps, kilohms, volts, hertz, NAND, binary.');
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 9000);
      const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + groqKey() }, body: fd, signal: ctl.signal });
      clearTimeout(to); if (!r.ok) { st.lastError = 'Groq transcription failed (' + r.status + ').'; return null; }
      return String((await r.json()).text || '').trim() || null;
    } catch (e) { st.lastError = 'Groq transcription could not be reached.'; return null; }
  }
  async function transcribeCloud(pcm) {
    if (groqKey()) { const t = await transcribeGroq(pcm); if (t) return t; }
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 12000);
      const r = await fetch(CLOUD + '/stt', { method: 'POST', body: wav(pcm), signal: ctl.signal });
      clearTimeout(to); if (!r.ok) { st.lastError = 'Cloud transcription failed (' + r.status + ').'; return null; }
      return String((await r.json()).text || '').trim() || null;
    } catch (e) { st.lastError = 'Cloud transcription could not be reached.'; return null; }
  }
  // Whisper hallucinates stock phrases on silence/noise — drop them
  const junk = (t) => !t || /^(\W*|you|thank you\.?|thanks for watching!?|\[.*\]|\(.*\))$/i.test(t.trim());

  async function listenRecorded(ms, engine) {
    const pcm = await capture(ms); if (!pcm) return null;
    UI.status && UI.status('Hearing', 'listen');
    let text = engine === 'groq' ? await transcribeCloud(pcm) : await transcribeLocal(pcm.slice());
    if (!text && engine === 'local') text = await transcribeCloud(pcm);
    return junk(text) ? null : [text];
  }

  return {
    st, mode, initLocal, wav, capture,
    onChange(f) { st.listeners.add(f); },
    get available() { return settings.mic && mode() !== 'none'; },
    get label() { return { native: 'Built-in speech recognition', local: 'On-device Whisper' + (st.local === 'ready' ? ' (' + st.localDevice + ')' : st.local === 'loading' ? ' (downloading ' + Math.round(st.localProgress) + '%)' : ''), groq: 'Whisper in the cloud', none: 'Not available' }[mode()]; },
    async listen(ms = 7000) {
      if (!settings.mic) return null;
      const m = mode();
      if (m === 'native') { const r = await listenNative(ms); if (r && r.retry) return listenRecorded(ms, mode()); return r; }
      if (m === 'local' || m === 'groq') return listenRecorded(ms, m);
      return null;
    },
    stop() { if (st.abort) st.abort(); },
    release() { if (st.stream) { st.stream.getTracks().forEach(t => t.stop()); st.stream = null; } },
    async permission() { try { if (!navigator.permissions) return 'unknown'; const p = await navigator.permissions.query({ name: 'microphone' }); return p.state; } catch (e) { return 'unknown'; } },
    async request() { try { await stream(); return true; } catch (e) { st.lastError = e.name === 'NotAllowedError' ? 'Permission was refused.' : String(e.message || e.name); emit(); return false; } },
    async devices() { try { return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput'); } catch (e) { return []; } },
  };
})();
