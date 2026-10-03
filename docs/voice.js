/* Murmur voice output. Each playback owns its timers and audio sources, so a cancelled
   utterance cannot resume or stop a newer one. System rewind is word-aligned and approximate. */
'use strict';
const Voice = (() => {
  const GAP = 0.18; // One short breath between sentences, shared by both engines.
  const st = {
    engine: 'system',
    neural: 'off',
    progress: 0,
    device: null,
    worker: null,
    ctx: null,
    cache: new Map(),
    waiters: new Map(),
    seq: 0,
    speaking: false,
    pos: 0,
    lastPos: 0,
    sysVoices: [],
    listeners: new Set(),
    sources: [],
    active: null,
    why: ''
  };
  const inflight = new Map(),
    durations = new Map();
  const emit = () => {
    for (const f of st.listeners)
      try {
        f(st);
      } catch {}
  };
  const active = (op) => st.active === op && !op.cancelled;
  const key = (text) =>
    Number(settings.rate || 1).toFixed(2) + '|' + (settings.voice || '') + '|' + text;
  // Preserve original character offsets; display text and spoken respellings have different lengths.
  function chunks(text) {
    const t = String(text),
      out = [];
    for (const match of t.matchAll(/[^]+?(?:[.!?]+["”’)]?(?=\s|$)|$)/g)) {
      let s = match[0],
        start = match.index,
        lead = s.search(/\S/);
      if (lead < 0) continue;
      start += lead;
      s = s.trim();
      if (s.length <= 230) {
        out.push({ text: s, start });
        continue;
      }
      let from = 0;
      for (const m of s.matchAll(/[,;:]\s+/g)) {
        if (m.index + 1 - from >= 130) {
          const piece = s.slice(from, m.index + 1);
          out.push({ text: piece, start: start + from });
          from = m.index + m[0].length;
        }
      }
      if (from < s.length) out.push({ text: s.slice(from), start: start + from });
    }
    return out;
  }
  function wordMap(c) {
    const out = [];
    let total = 0;
    for (const m of c.text.matchAll(/\S+/g)) {
      const weight =
        Math.max(2, m[0].replace(/[^A-Za-z0-9]/g, '').length) +
        1.2 +
        (/[,:;]$/.test(m[0]) ? 2 : 0) +
        (/[.!?]$/.test(m[0]) ? 3 : 0);
      out.push({ at: c.start + m.index, len: m[0].length, from: total, to: total + weight });
      total += weight;
    }
    for (const w of out) {
      w.from /= total;
      w.to /= total;
    }
    return out;
  }
  const estDur = (text) =>
    Math.max(
      0.6,
      String(SpeechText.forTTS(text)).trim().split(/\s+/).length / (2.55 * (settings.rate || 1))
    );
  function durationOf(text) {
    return chunks(text).reduce(
      (sum, c, i) =>
        sum +
        (st.cache.get(key(c.text))?.duration || durations.get(key(c.text)) || estDur(c.text)) +
        (i ? GAP : 0),
      0
    );
  }
  function ctx() {
    return st.ctx || (st.ctx = new (window.AudioContext || window.webkitAudioContext)());
  }
  function settle(id, buf) {
    const w = st.waiters.get(id);
    if (!w) return;
    clearTimeout(w.timer);
    st.waiters.delete(id);
    inflight.delete(w.key);
    for (const resolve of w.res) resolve(buf);
  }
  function failed(message) {
    st.neural = 'failed';
    st.engine = 'system';
    st.why = message;
    for (const id of [...st.waiters.keys()]) settle(id, null);
    emit();
  }
  /** Prepare the worker only after setup requests it. cacheOnly verifies existing files
   * without fetching missing model assets; runtime imports are handled by the service worker. */
  async function initNeural(force, options = {}) {
    if (['loading', 'ready'].includes(st.neural)) return;
    if (!force && !settings.neuralVoice) return;
    st.neural = 'loading';
    st.progress = 0;
    emit();
    try {
      if (!navigator.gpu || !(await navigator.gpu.requestAdapter())) {
        failed('nogpu');
        return;
      }
      if (st.neural !== 'loading') return;
      const worker = new Worker('tts-worker.js', { type: 'module' });
      st.worker = worker;
      worker.onerror = (e) => {
        if (st.worker === worker)
          failed(e.message || 'Voice worker stopped. Retry the audio download.');
      };
      worker.onmessageerror = () => {
        if (st.worker === worker) failed('Voice worker returned unreadable audio.');
      };
      worker.onmessage = ({ data: m }) => {
        if (st.worker !== worker) return;
        if (m.type === 'progress') {
          st.progress = m.p;
          emit();
        } else if (m.type === 'ready') {
          st.neural = 'ready';
          st.device = m.device;
          st.engine = 'neural';
          settings.neuralVoice = true;
          try {
            saveSettings();
          } catch {}
          emit();
        } else if (m.type === 'audio') {
          try {
            const pcm = m.pcm,
              sr = m.sr;
            let a = 0,
              b = pcm.length - 1;
            while (a < b && Math.abs(pcm[a]) < 0.008) a++;
            while (b > a && Math.abs(pcm[b]) < 0.008) b--;
            a = Math.max(0, a - Math.round(0.03 * sr));
            b = Math.min(pcm.length - 1, b + Math.round(0.06 * sr));
            const w = st.waiters.get(m.id);
            if (!w) return;
            const buf = ctx().createBuffer(1, b - a + 1, sr);
            buf.copyToChannel(pcm.subarray(a, b + 1), 0);
            st.cache.set(w.key, buf);
            if (st.cache.size > 120) st.cache.delete(st.cache.keys().next().value);
            settle(m.id, buf);
          } catch {
            settle(m.id, null);
          }
        } else if (m.type === 'error') {
          if (m.id != null) settle(m.id, null);
          else failed(m.message);
        }
      };
      worker.postMessage({
        type: 'init',
        device: 'webgpu',
        dtype: 'fp32',
        cacheOnly: !!options.cacheOnly
      });
    } catch (e) {
      failed(String(e.message || e));
    }
  }
  // Shared generation jobs are keyed by text/rate/voice. Stop settles their waiters
  // immediately; late worker responses have no owner and are safely ignored.
  function get(text, urgent) {
    const k = key(text),
      hit = st.cache.get(k);
    if (hit) return Promise.resolve(hit);
    if (!st.worker || st.neural !== 'ready') return Promise.resolve(null);
    return new Promise((resolve) => {
      const pending = inflight.get(k);
      if (st.waiters.has(pending)) {
        st.waiters.get(pending).res.push(resolve);
        if (urgent) st.worker.postMessage({ type: 'promote', id: pending });
        return;
      }
      const id = ++st.seq;
      inflight.set(k, id);
      st.waiters.set(id, {
        key: k,
        res: [resolve],
        timer: setTimeout(() => settle(id, null), 45000)
      });
      try {
        st.worker.postMessage({
          type: 'gen',
          id,
          text: SpeechText.forTTS(text),
          voice: 'af_heart',
          speed: settings.rate || 1,
          urgent: !!urgent
        });
      } catch {
        settle(id, null);
      }
    });
  }
  function prefetch(text) {
    if (st.neural === 'ready' && text) for (const c of chunks(text).slice(0, 2)) get(c.text, false);
  }
  function wait(op, ms) {
    return new Promise((resolve) => {
      if (!active(op)) return resolve(false);
      let id;
      const done = () => {
        clearTimeout(id);
        op.cleanups.delete(done);
        resolve(active(op));
      };
      id = setTimeout(done, ms);
      op.cleanups.add(done);
    });
  }
  function sysVoice() {
    const chosen = st.sysVoices.find(
      (v) => v.voiceURI === settings.voice || v.name === settings.voice
    );
    if (chosen) return chosen;
    const rank = (v) =>
      (/natural|neural|premium|enhanced|wavenet|journey|studio/i.test(v.name || '') ? 40 : 0) +
      (/google/i.test(v.name || '') ? 20 : 0) +
      (/en[-_](CA|US)/i.test(v.lang) ? 6 : 0) -
      (/compact|espeak/i.test(v.name || '') ? 15 : 0);
    return [...st.sysVoices].sort((a, b) => rank(b) - rank(a))[0];
  }
  // Browser speech exposes word boundaries, not seekable audio. Resume therefore
  // starts at the nearest estimated word; measured sentence durations improve later rewinds.
  async function saySystem(text, opts, op) {
    if (!('speechSynthesis' in window)) return true;
    const cs = chunks(text),
      v = sysVoice();
    let base = opts.timelineBase || 0;
    const startAt = Math.max(0, opts.startAt || 0);
    for (let ci = 0; ci < cs.length; ci++) {
      if (!active(op)) return false;
      const c = cs[ci],
        d = durations.get(key(c.text)) || estDur(c.text),
        words = wordMap(c);
      if (base + d <= startAt) {
        base += d + GAP;
        continue;
      }
      const off = Math.max(0, startAt - base),
        first = off ? words.find((w) => w.to > off / d) : words[0],
        slice = Math.max(0, (first?.at || c.start) - c.start),
        plan = SpeechText.prepare
          ? SpeechText.prepare(c.text.slice(slice))
          : { text: SpeechText.forTTS(c.text.slice(slice)), map: null };
      let actual = 0;
      const ok = await new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(plan.text);
        if (v) {
          u.voice = v;
          u.lang = v.lang;
        }
        u.rate = settings.rate || 1;
        let done = false,
          started = false,
          t0 = 0,
          boundaries = false,
          iv,
          watch;
        const fin = (success) => {
          if (done) return;
          done = true;
          clearInterval(iv);
          clearTimeout(watch);
          op.cleanups.delete(cancel);
          u.onend = u.onerror = u.onboundary = u.onstart = null;
          actual = started ? (performance.now() - t0) / 1000 : 0;
          resolve(success && active(op));
        };
        const cancel = () => fin(false);
        op.cleanups.add(cancel);
        u.onstart = () => {
          if (!active(op)) return fin(false);
          started = true;
          t0 = performance.now();
          opts.onWait?.(false);
        };
        u.onboundary = (e) => {
          if (!active(op) || e.charIndex == null) return;
          boundaries = true;
          const mapped = plan.map?.[e.charIndex] ?? e.charIndex,
            at = c.start + slice + mapped;
          opts.onProgress?.(at, 1, c.start, c.text.length);
        };
        u.onend = () => fin(true);
        u.onerror = () => fin(false);
        iv = setInterval(() => {
          if (!active(op)) return fin(false);
          if (!started) return;
          const elapsed = (performance.now() - t0) / 1000;
          st.pos = base + off + elapsed;
          if (!boundaries) {
            const f = Math.min(0.999, (off + elapsed) / d),
              w = words.find((w) => f < w.to) || words.at(-1);
            if (w) opts.onProgress?.(w.at, w.len, c.start, c.text.length);
          }
        }, 80);
        watch = setTimeout(
          () => {
            if (active(op)) {
              try {
                speechSynthesis.cancel();
              } catch {}
              fin(false);
            }
          },
          Math.max(15000, d * 3000 + 4000)
        );
        opts.onWait?.(true);
        try {
          speechSynthesis.speak(u);
        } catch {
          fin(false);
        }
      });
      if (!ok) return false;
      if (!slice && actual > 0) durations.set(key(c.text), actual);
      base += off + actual || d;
      st.pos = base;
      if (ci < cs.length - 1) {
        if (!(await wait(op, GAP * 1000))) return false;
        base += GAP;
      }
    }
    return active(op);
  }
  // Generated buffers use the audio clock for precise offsets. Keep only a short
  // look-ahead scheduled so a pause/repeat can stop all owned sources immediately.
  async function sayNeural(text, opts, op) {
    const cs = chunks(text);
    if (!cs.length) return true;
    const ac = ctx();
    if (ac.state === 'suspended') await Promise.race([ac.resume(), op.cancelPromise]);
    if (!active(op)) return false;
    let base = 0,
      nextAt = 0;
    const timeline = [],
      startAt = Math.max(0, opts.startAt || 0);
    const tick = () => {
      if (!active(op)) return;
      const cur = timeline.filter((e) => ac.currentTime >= e.at).at(-1);
      if (!cur) return;
      const elapsed = Math.min(cur.dur, Math.max(0, ac.currentTime - cur.at) + cur.off);
      st.pos = cur.base + elapsed;
      const w = cur.words.find((w) => elapsed / cur.dur < w.to) || cur.words.at(-1);
      if (w) opts.onProgress?.(w.at, w.len, cur.c.start, cur.c.text.length);
    };
    const iv = setInterval(tick, 40);
    const cleanup = () => clearInterval(iv);
    op.cleanups.add(cleanup);
    try {
      for (let i = 0; i < cs.length; i++) {
        if (!active(op)) return false;
        const c = cs[i];
        if (cs[i + 1]) get(cs[i + 1].text, false);
        let buf = st.cache.get(key(c.text));
        if (!buf) {
          if (!timeline.length || ac.currentTime >= nextAt) opts.onWait?.(true);
          buf = await Promise.race([get(c.text, true), op.cancelPromise]);
          if (!active(op)) return false;
          opts.onWait?.(false);
        }
        if (!buf) {
          while (active(op) && ac.currentTime < nextAt - GAP) await wait(op, 40);
          if (!active(op)) return false;
          const remaining = cs
              .slice(i)
              .map((x) => x.text)
              .join(' '),
            origin = c.start;
          return saySystem(
            remaining,
            {
              ...opts,
              startAt: Math.max(startAt, base),
              timelineBase: base,
              onProgress: (at, len, cs, cl) => opts.onProgress?.(origin + at, len, origin + cs, cl)
            },
            op
          );
        }
        const dur = buf.duration;
        if (base + dur <= startAt) {
          base += dur + GAP;
          continue;
        }
        const off = Math.max(0, startAt - base),
          at = Math.max(ac.currentTime + 0.03, nextAt),
          src = ac.createBufferSource();
        src.buffer = buf;
        src.connect(ac.destination);
        op.sources.push(src);
        src.start(at, off);
        timeline.push({ at, dur, off, base, c, words: wordMap(c) });
        nextAt = at + dur - off + GAP;
        base += dur + GAP;
        while (active(op) && nextAt - ac.currentTime > 8) await wait(op, 100);
      }
      while (active(op) && ac.currentTime < nextAt - GAP) await wait(op, 40);
      if (active(op)) tick();
      return active(op);
    } finally {
      cleanup();
      op.cleanups.delete(cleanup);
    }
  }
  /** Cancel one playback without allowing its eventual callbacks to mutate a newer one. */
  function stop() {
    const op = st.active;
    if (!op) return;
    op.cancelled = true;
    st.lastPos = st.pos;
    op.cancelResolve(null);
    try {
      st.worker?.postMessage({ type: 'drop' });
    } catch {}
    for (const id of [...st.waiters.keys()]) settle(id, null);
    for (const cleanup of [...op.cleanups]) cleanup();
    op.cleanups.clear();
    for (const src of op.sources)
      try {
        src.stop();
        src.disconnect();
      } catch {}
    try {
      speechSynthesis.cancel();
    } catch {}
    if (st.active === op) {
      st.active = null;
      st.speaking = false;
      st.sources = [];
    }
  }
  // Setup uses reset for retry, re-download and cache recovery. Unlike stop, it
  // discards the loaded engine and generated buffers so readiness must be verified again.
  function reset() {
    stop();
    for (const id of [...st.waiters.keys()]) settle(id, null);
    st.worker?.terminate();
    st.worker = null;
    st.neural = 'off';
    st.engine = 'system';
    st.progress = 0;
    st.why = '';
    st.cache.clear();
    durations.clear();
    emit();
  }
  return {
    st,
    chunks,
    prefetch,
    durationOf,
    initNeural,
    stop,
    reset,
    onChange(f) {
      st.listeners.add(f);
      return () => st.listeners.delete(f);
    },
    init(options = {}) {
      if ('speechSynthesis' in window) {
        const pick = () => {
          st.sysVoices = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
        };
        pick();
        speechSynthesis.onvoiceschanged = pick;
      }
      if (!options.skipNeural) initNeural(false);
    },
    get speaking() {
      return st.speaking;
    },
    get pos() {
      return st.pos;
    },
    get lastPos() {
      return st.lastPos;
    },
    get engineLabel() {
      return st.neural === 'ready'
        ? 'Natural voice'
        : st.neural === 'loading'
          ? 'Natural voice loading ' + Math.round(st.progress) + '%'
          : 'System voice';
    },
    /** Resolve true after complete playback, false after cancellation. Every await
     * that can outlive this call checks the same operation identity before continuing. */
    async say(text, opts = {}) {
      stop();
      const op = { cancelled: false, sources: [], cleanups: new Set() };
      op.cancelPromise = new Promise((r) => (op.cancelResolve = r));
      st.active = op;
      st.sources = op.sources;
      st.speaking = true;
      st.pos = opts.startAt || 0;
      try {
        return st.neural === 'ready'
          ? await sayNeural(text, opts, op)
          : await saySystem(text, opts, op);
      } finally {
        if (st.active === op) {
          st.lastPos = st.pos;
          st.speaking = false;
          st.active = null;
          for (const src of op.sources)
            try {
              src.disconnect();
            } catch {}
          st.sources = [];
        }
      }
    },
    unlock() {
      try {
        const ac = ctx();
        if (ac.state === 'suspended') ac.resume();
        const b = ac.createBuffer(1, 1, 22050),
          s = ac.createBufferSource();
        s.buffer = b;
        s.connect(ac.destination);
        s.start();
      } catch {}
    }
  };
})();
