/* Pandora Practice Pal — voice output.
   Natural voice: Kokoro (af_heart) generated on the phone in tts-worker.js, played through Web Audio.
   Every sentence is its own audio buffer, so the app always knows exactly where it is in the text:
   that position drives the word highlight, the auto-scroll and the 15-second rewind.
   Fallback: the system voice (speechSynthesis) when WebGPU is not available. */
'use strict';
const Voice = (() => {
  const GAP = 0.16;            // seconds of air between sentences
  const st = {
    engine: 'system',          // 'neural' | 'system'
    neural: 'off',             // off | loading | ready | failed
    progress: 0, device: null, worker: null, ctx: null,
    cache: new Map(), waiters: new Map(), seq: 0,
    cancelled: false, speaking: false, source: null, raf: 0,
    pos: 0, lastPos: 0, sysVoices: [], listeners: new Set(),
  };
  const emit = () => { for (const f of st.listeners) try { f(st); } catch (e) { } };

  // ---------- text → chunks (sentences, long ones split at commas/semicolons)
  function chunks(text) {
    const t = String(text).replace(/\s+/g, ' ').trim(); if (!t) return [];
    const sents = t.match(/[^]+?(?:[.!?]+["”’)]?(?=\s|$)|$)/g) || [t];
    const out = []; let at = 0;
    for (let s of sents) {
      const start = t.indexOf(s.trim(), at); s = s.trim(); if (!s) continue; at = start + s.length;
      if (s.length <= 230) { out.push({ text: s, start }); continue; }
      let part = '', pStart = start, off = 0;
      for (const piece of s.split(/(?<=[,;:])\s+/)) {
        if (part && (part + ' ' + piece).length > 200) { out.push({ text: part, start: pStart }); pStart = start + off; part = ''; }
        part = part ? part + ' ' + piece : piece; off = s.indexOf(piece, off) + piece.length;
      }
      if (part) out.push({ text: part, start: pStart });
    }
    return out;
  }
  // word timing inside one chunk: weight by letters, plus pauses at punctuation
  function wordMap(chunk) {
    const words = []; const re = /\S+/g; let m, total = 0;
    while ((m = re.exec(chunk.text))) {
      const w = m[0]; let wt = Math.max(2, w.replace(/[^A-Za-z0-9]/g, '').length) + 1.2;
      if (/[,;:]$/.test(w)) wt += 3; if (/[.!?]$/.test(w)) wt += 4; if (/\d/.test(w)) wt += w.length * 1.5;
      words.push({ at: chunk.start + m.index, len: w.length, from: total, to: total + wt }); total += wt;
    }
    for (const w of words) { w.from /= total; w.to /= total; }
    return words;
  }

  // ---------- neural engine
  function key(text) { return (settings.rate || 1).toFixed(2) + '|' + text; }
  function trim(pcm, sr) { // remove leading/trailing silence so sentences join cleanly and timing is exact
    const thr = 0.008; let a = 0, b = pcm.length - 1;
    while (a < b && Math.abs(pcm[a]) < thr) a++; while (b > a && Math.abs(pcm[b]) < thr) b--;
    a = Math.max(0, a - Math.round(0.03 * sr)); b = Math.min(pcm.length - 1, b + Math.round(0.06 * sr));
    return pcm.subarray(a, b + 1);
  }
  function ctx() { if (!st.ctx) st.ctx = new (window.AudioContext || window.webkitAudioContext)(); return st.ctx; }
  async function initNeural(force) {
    if (st.neural === 'loading' || st.neural === 'ready') return;
    if (!force && !settings.neuralVoice) return;
    let dev = 'wasm';
    try { if (navigator.gpu && await navigator.gpu.requestAdapter()) dev = 'webgpu'; } catch (e) { }
    if (dev !== 'webgpu') { st.neural = 'failed'; st.why = 'nogpu'; emit(); return; }
    st.neural = 'loading'; st.progress = 0; emit();
    try {
      st.worker = new Worker('tts-worker.js', { type: 'module' });
      st.worker.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === 'progress') { st.progress = m.p; emit(); }
        else if (m.type === 'ready') { st.neural = 'ready'; st.device = m.device; st.engine = 'neural'; settings.neuralVoice = true; saveSettings(); emit(); }
        else if (m.type === 'audio') {
          const w = st.waiters.get(m.id); st.waiters.delete(m.id); if (!w) return;
          const pcm = trim(m.pcm, m.sr); const buf = ctx().createBuffer(1, pcm.length, m.sr); buf.copyToChannel(pcm, 0);
          st.cache.set(w.key, buf); if (st.cache.size > 400) st.cache.delete(st.cache.keys().next().value);
          w.res.forEach(r => r(buf));
        } else if (m.type === 'error') {
          if (m.id != null) { const w = st.waiters.get(m.id); st.waiters.delete(m.id); if (w) w.res.forEach(r => r(null)); }
          else { st.neural = 'failed'; st.why = m.message; st.engine = 'system'; emit(); }
        }
      };
      st.worker.postMessage({ type: 'init', device: 'webgpu', dtype: 'fp32' });
    } catch (e) { st.neural = 'failed'; st.why = String(e.message || e); emit(); }
  }
  const inflight = new Map(); // key -> id
  function get(text, urgent) {
    const k = key(text); const hit = st.cache.get(k); if (hit) return Promise.resolve(hit);
    return new Promise((res) => {
      const id0 = inflight.get(k);
      if (id0 != null && st.waiters.has(id0)) { st.waiters.get(id0).res.push(res); return; }
      const id = ++st.seq; inflight.set(k, id); st.waiters.set(id, { key: k, res: [res] });
      st.worker.postMessage({ type: 'gen', id, text, voice: 'af_heart', speed: settings.rate || 1, urgent: !!urgent });
    });
  }
  function prefetch(text) { if (st.engine !== 'neural' || st.neural !== 'ready' || !text) return; for (const c of chunks(text)) if (!st.cache.has(key(c.text))) get(c.text, false); }
  function estDur(text) { return Math.max(0.6, String(text).split(/\s+/).length / (2.55 * (settings.rate || 1))); }
  function durationOf(text) {
    let d = 0; const cs = chunks(text);
    cs.forEach((c, i) => { const b = st.cache.get(key(c.text)); d += (b ? b.duration : estDur(c.text)) + (i ? GAP : 0); });
    return d;
  }

  async function sayNeural(text, opts) {
    const cs = chunks(text); if (!cs.length) return true;
    cs.forEach((c, i) => { if (!st.cache.has(key(c.text))) get(c.text, i === 0); }); // queue the whole block now
    const ac = ctx(); if (ac.state === 'suspended') await ac.resume();
    let base = 0; const startAt = Math.max(0, opts.startAt || 0);
    for (let i = 0; i < cs.length; i++) {
      if (st.cancelled) return false;
      const c = cs[i];
      let buf = st.cache.get(key(c.text));
      if (!buf) { if (opts.onWait) opts.onWait(true); buf = await get(c.text, true); if (opts.onWait) opts.onWait(false); }
      if (st.cancelled) return false;
      if (!buf) { const ok = await saySystem(c.text, {}); if (!ok) return false; base += estDur(c.text) + GAP; continue; }
      const dur = buf.duration;
      if (base + dur <= startAt) { base += dur + GAP; continue; }   // rewind landed after this sentence
      const off = Math.max(0, startAt - base);
      const words = wordMap(c);
      const ok = await new Promise((resolve) => {
        const src = ac.createBufferSource(); src.buffer = buf; src.connect(ac.destination); st.source = src;
        const t0 = ac.currentTime - off; let done = false;
        const tick = () => {
          if (done) return;
          const el = Math.min(dur, ac.currentTime - t0); st.pos = base + el;
          const f = el / dur; const w = words.find(w => f < w.to) || words[words.length - 1];
          if (w && opts.onProgress) opts.onProgress(w.at, w.len, c.start, c.text.length);
          st.raf = requestAnimationFrame(tick);
        };
        src.onended = () => { done = true; cancelAnimationFrame(st.raf); st.source = null; resolve(!st.cancelled); };
        src.start(0, off); tick();
      });
      if (!ok) return false;
      base += dur;
      if (i < cs.length - 1) { st.pos = base; await sleep(GAP * 1000); base += GAP; }
    }
    return true;
  }

  // ---------- system voice fallback
  function sysVoice() {
    const rank = (v) => { let r = 0; const n = (v.name || '') + ' ' + (v.voiceURI || ''); if (/natural|neural|premium|enhanced|wavenet|journey|studio/i.test(n)) r += 40; if (/network/i.test(n)) r += 30; if (/google/i.test(n)) r += 20; if (v.localService === false) r += 10; if (/en[-_](CA|US)/i.test(v.lang)) r += 6; if (/compact|espeak|local$/i.test(n)) r -= 15; return r; };
    return [...st.sysVoices].sort((a, b) => rank(b) - rank(a))[0];
  }
  async function saySystem(text, opts) {
    if (!('speechSynthesis' in window)) { await sleep(estDur(text) * 1000); return !st.cancelled; }
    speechSynthesis.cancel();
    const cs = chunks(text); const v = sysVoice(); let base = 0; const startAt = opts.startAt || 0;
    for (const c of cs) {
      if (st.cancelled) return false;
      const d = estDur(c.text); if (base + d <= startAt) { base += d; continue; }
      const words = wordMap(c);
      await new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(c.text); if (v) { u.voice = v; u.lang = v.lang; } u.rate = settings.rate || 1;
        const t0 = performance.now(); let gotBoundary = false; let done = false;
        const fin = () => { if (done) return; done = true; clearInterval(iv); resolve(); };
        u.onboundary = (e) => { if (e.name === 'word' || e.charIndex != null) { gotBoundary = true; const at = c.start + e.charIndex; const m = /\S+/.exec(c.text.slice(e.charIndex)); if (opts.onProgress) opts.onProgress(at, m ? m[0].length : 1, c.start, c.text.length); } };
        u.onend = fin; u.onerror = fin;
        const iv = setInterval(() => {
          const el = (performance.now() - t0) / 1000; st.pos = base + Math.min(el, d);
          if (!gotBoundary && opts.onProgress) { const f = Math.min(0.999, el / d); const w = words.find(w => f < w.to) || words[words.length - 1]; if (w) opts.onProgress(w.at, w.len, c.start, c.text.length); }
          if (st.cancelled || el > d * 3 + 4) { try { speechSynthesis.cancel(); } catch (e) { } fin(); }
        }, 120);
        speechSynthesis.speak(u);
      });
      base += d;
    }
    return !st.cancelled;
  }

  return {
    st, chunks, prefetch, durationOf, initNeural, onChange(f) { st.listeners.add(f); },
    init() {
      if ('speechSynthesis' in window) { const pick = () => { st.sysVoices = speechSynthesis.getVoices().filter(v => /^en/i.test(v.lang)); }; pick(); speechSynthesis.onvoiceschanged = pick; }
      initNeural(false);
    },
    get speaking() { return st.speaking; },
    get pos() { return st.pos; },
    get lastPos() { return st.lastPos; },
    get engineLabel() { return st.neural === 'ready' ? 'Natural voice' : st.neural === 'loading' ? 'Natural voice loading ' + Math.round(st.progress) + '%' : 'System voice'; },
    async say(text, opts = {}) {
      st.cancelled = false; st.speaking = true; st.pos = opts.startAt || 0;
      try { return (st.neural === 'ready') ? await sayNeural(text, opts) : await saySystem(text, opts); }
      finally { st.lastPos = st.pos; st.speaking = false; }
    },
    stop() {
      st.cancelled = true; st.lastPos = st.pos;
      try { if (st.source) st.source.stop(); } catch (e) { } cancelAnimationFrame(st.raf);
      try { speechSynthesis.cancel(); } catch (e) { }
      st.speaking = false;
    },
    unlock() { try { const ac = ctx(); if (ac.state === 'suspended') ac.resume(); const b = ac.createBuffer(1, 1, 22050); const s = ac.createBufferSource(); s.buffer = b; s.connect(ac.destination); s.start(); } catch (e) { } },
  };
})();
