/* Pandora Practice Pal — voice input that works in every browser.
   1. Built-in speech recognition (Chrome, the installed app, Samsung Internet, Edge) — instant, free.
   2. Otherwise (Firefox, or when the built-in one fails): record the answer with the microphone, detect when you stop
      talking, and transcribe the clip with Whisper on Groq's free tier (needs the Groq key in Settings). */
'use strict';
const Ear = (() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const st = { nativeOk: !!SR, nativeBroken: false, rec: null, stream: null, mr: null, abort: null, last: '' };
  const canRecord = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  const groqKey = () => (settings.keys && settings.keys.groq) || '';
  const mode = () => (st.nativeOk && !st.nativeBroken && settings.earMode !== 'whisper') ? 'native' : (canRecord() && groqKey() ? 'whisper' : 'none');

  function listenNative(ms) {
    return new Promise((resolve) => {
      const r = new SR(); st.rec = r;
      r.lang = 'en-US'; r.continuous = false; r.interimResults = false; r.maxAlternatives = 5;
      let done = false;
      const finish = (val) => { if (done) return; done = true; clearTimeout(t); try { r.stop(); } catch (e) { } st.rec = null; st.abort = null; resolve(val); };
      const t = setTimeout(() => { try { r.abort(); } catch (e) { } finish(null); }, ms);
      st.abort = () => { try { r.abort(); } catch (e) { } finish(null); };
      r.onresult = (ev) => { const alts = []; for (const res of ev.results) for (let i = 0; i < res.length; i++) alts.push(res[i].transcript); finish(alts); };
      r.onerror = (ev) => {
        // network / service errors: the built-in engine is unusable here — switch to Whisper for the rest of the session
        if (['network', 'service-not-allowed', 'language-not-supported'].includes(ev.error)) { st.nativeBroken = true; finish({ retry: true }); return; }
        if (ev.error === 'not-allowed') { st.lastError = 'Microphone permission was refused. Allow it for this app in Android settings.'; }
        finish(null);
      };
      r.onend = () => finish(null);
      try { r.start(); } catch (e) { finish(null); }
    });
  }

  async function stream() {
    if (st.stream && st.stream.active) return st.stream;
    st.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    return st.stream;
  }
  // record until ~0.9 s of quiet after speech (or the time limit), then transcribe
  async function listenWhisper(ms) {
    let s; try { s = await stream(); } catch (e) { st.lastError = 'Microphone permission was refused.'; return null; }
    const ac = new (window.AudioContext || window.webkitAudioContext)(); const srcNode = ac.createMediaStreamSource(s);
    const an = ac.createAnalyser(); an.fftSize = 1024; srcNode.connect(an); const buf = new Float32Array(an.fftSize);
    const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t)) || '';
    const mr = new MediaRecorder(s, type ? { mimeType: type } : undefined); const parts = []; st.mr = mr;
    mr.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
    let noise = 0.01, spoke = false, lastVoice = 0; const t0 = performance.now(); let stopped = false;
    const blob = await new Promise((resolve) => {
      const stop = () => { if (stopped) return; stopped = true; clearInterval(iv); try { mr.stop(); } catch (e) { resolve(null); } };
      st.abort = () => { spoke = false; stop(); };
      mr.onstop = () => resolve(spoke ? new Blob(parts, { type: mr.mimeType || 'audio/webm' }) : null);
      mr.start(250);
      const iv = setInterval(() => {
        an.getFloatTimeDomainData(buf); let e = 0; for (const x of buf) e += x * x; const rms = Math.sqrt(e / buf.length);
        const now = performance.now();
        if (!spoke) noise = noise * 0.95 + rms * 0.05;
        if (rms > Math.max(0.02, noise * 3)) { spoke = true; lastVoice = now; }
        if (spoke && now - lastVoice > 900) stop();
        if (!spoke && now - t0 > ms) stop();
        if (now - t0 > ms + 8000) stop();
      }, 60);
    });
    try { ac.close(); } catch (e) { } st.abort = null; st.mr = null;
    if (!blob) return null;
    UI.status('Hearing', 'listen');
    try {
      const fd = new FormData(); fd.append('file', blob, 'answer.' + ((blob.type.match(/(webm|ogg|mp4)/) || ['webm'])[0])); fd.append('model', 'whisper-large-v3-turbo'); fd.append('language', 'en'); fd.append('response_format', 'json');
      fd.append('prompt', 'Spoken answers in an electronics course: option one, option two, true, false, milliamps, kilohms, volts, hertz, NAND, binary.');
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 9000);
      const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + groqKey() }, body: fd, signal: ctl.signal });
      clearTimeout(to);
      if (!r.ok) { st.lastError = 'Transcription failed (' + r.status + ').'; return null; }
      const j = await r.json(); const text = String(j.text || '').trim();
      return text ? [text] : null;
    } catch (e) { st.lastError = 'Transcription could not reach Groq.'; return null; }
  }

  return {
    st, mode,
    get available() { return mode() !== 'none'; },
    get label() { const m = mode(); return m === 'native' ? 'Built-in speech recognition' : m === 'whisper' ? 'Whisper (Groq) transcription' : (st.nativeOk ? 'Off' : 'Needs a Groq key (this browser has no speech recognition)'); },
    async listen(ms = 7000) {
      if (!settings.mic) return null;
      const m = mode();
      if (m === 'native') { const r = await listenNative(ms); if (r && r.retry) return mode() === 'whisper' ? listenWhisper(ms) : null; return r; }
      if (m === 'whisper') return listenWhisper(ms);
      return null;
    },
    stop() { if (st.abort) st.abort(); },
    release() { if (st.stream) { st.stream.getTracks().forEach(t => t.stop()); st.stream = null; } },
    async permission() { try { const s = await stream(); return !!s; } catch (e) { return false; } },
  };
})();
