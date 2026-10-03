/* Murmur microphone. A listening turn owns capture, recognition and transcription.
   Explicit on-device mode never uploads audio. Cancelled turns cannot return answers. */
'use strict';
const Ear = (() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const st = {
    nativeOk: !!SR,
    nativeBroken: false,
    stream: null,
    streamDev: null,
    streamPromise: null,
    streamGeneration: 0,
    abort: null,
    lastError: '',
    level: 0,
    local: 'off',
    localProgress: 0,
    localDevice: null,
    worker: null,
    seq: 0,
    waiters: new Map(),
    listeners: new Set(),
    active: null,
    listening: false
  };
  const emit = () => {
    for (const fn of st.listeners)
      try {
        fn(st);
      } catch {}
  };
  const canRecord = () => !!navigator.mediaDevices?.getUserMedia;
  const groqKey = () => settings.keys?.groq || '';
  function mode() {
    const w = settings.earMode || 'auto';
    if (w === 'native') return st.nativeOk ? 'native' : 'none';
    if (w === 'local' || w === 'groq') return canRecord() ? w : 'none';
    if (st.nativeOk && !st.nativeBroken && !settings.micId) return 'native';
    return canRecord() ? 'local' : 'none';
  }
  const active = (op) => st.active === op && !op.cancelled;
  const phase = (op, name) => {
    if (active(op)) {
      st.listening = name === 'listening';
      op.onState?.(name);
      emit();
    }
  };
  // Stop the listening turn but retain its permitted stream for the next question.
  // Session end, microphone-off and device changes also call release().
  function stop() {
    const op = st.active;
    if (op) {
      op.cancelled = true;
      op.resolveCancel(null);
      for (const f of [...op.cleanups]) f();
      op.cleanups.clear();
      if (st.active === op) st.active = null;
    }
    st.abort = null;
    st.listening = false;
    st.level = 0;
    emit();
  }
  // A generation counter prevents a permission prompt that resolves after release
  // from reopening an ended session. Concurrent requests share one permission prompt.
  async function stream() {
    const id = settings.micId || '';
    if (st.stream?.active && st.streamDev === id) return st.stream;
    if (st.streamPromise) return st.streamPromise;
    release();
    const generation = st.streamGeneration;
    const audio = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1
    };
    if (id) audio.deviceId = { exact: id };
    let promise;
    promise = (async () => {
      let selected = id,
        s;
      try {
        s = await navigator.mediaDevices.getUserMedia({ audio });
      } catch (e) {
        if (id && ['OverconstrainedError', 'NotFoundError'].includes(e.name)) {
          settings.micId = '';
          selected = '';
          saveSettings();
          s = await navigator.mediaDevices.getUserMedia({
            audio: { ...audio, deviceId: undefined }
          });
        } else throw e;
      }
      if (generation !== st.streamGeneration) {
        s.getTracks().forEach((t) => t.stop());
        return null;
      }
      st.stream = s;
      st.streamDev = selected;
      emit();
      return s;
    })().finally(() => {
      if (st.streamPromise === promise) st.streamPromise = null;
    });
    st.streamPromise = promise;
    return promise;
  }
  function release() {
    st.streamGeneration++;
    if (st.stream) st.stream.getTracks().forEach((t) => t.stop());
    st.stream = null;
    st.streamDev = null;
    st.streamPromise = null;
  }
  // Some browsers end recognition on brief silence. Restart within the same
  // answer deadline; speech begun near the deadline receives eight seconds to finish.
  function listenNative(ms, op) {
    return new Promise((resolve) => {
      let done = false,
        r,
        deadline = 0,
        spoken = false,
        lastInterim = '',
        timer,
        bootTimer,
        restart;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(bootTimer);
        clearTimeout(restart);
        op.cleanups.delete(cancel);
        if (r) {
          r.onend = r.onresult = r.onerror = r.onstart = r.onspeechstart = null;
          try {
            r.abort();
          } catch {}
        }
        resolve(v);
      };
      const cancel = () => finish(null);
      op.cleanups.add(cancel);
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(
          () => finish(lastInterim ? [lastInterim] : null),
          Math.max(0, deadline - performance.now())
        );
      };
      const begin = () => {
        if (!active(op)) return finish(null);
        r = new SR();
        r.lang = 'en-US';
        r.continuous = true;
        r.interimResults = true;
        r.maxAlternatives = 5;
        r.onstart = () => {
          clearTimeout(bootTimer);
          if (!deadline) {
            deadline = performance.now() + ms;
            arm();
          }
          phase(op, 'listening');
        };
        r.onspeechstart = () => {
          if (!spoken) {
            spoken = true;
            deadline = Math.max(deadline, performance.now() + 8000);
            arm();
          }
        };
        r.onresult = (e) => {
          let final = [];
          for (let n = e.resultIndex || 0; n < e.results.length; n++) {
            const result = e.results[n];
            if (result.isFinal === false) {
              lastInterim = String(result[0]?.transcript || '');
              continue;
            }
            for (let i = 0; i < result.length; i++) final.push(result[i].transcript);
          }
          if (final.length) finish(final);
        };
        r.onerror = (e) => {
          if (done || !active(op)) return;
          if (e.error === 'no-speech' || e.error === 'aborted') return;
          if (
            ['network', 'service-not-allowed', 'language-not-supported', 'audio-capture'].includes(
              e.error
            )
          ) {
            st.nativeBroken = true;
            st.lastError =
              'Built-in speech recognition is unavailable. Choose or download on-device recognition in Audio settings.';
            emit();
            finish({ retry: true });
            return;
          }
          if (e.error === 'not-allowed') {
            st.lastError =
              'Microphone permission is blocked. Open Settings → Microphone → Fix permission.';
            emit();
          }
          finish(null);
        };
        r.onend = () => {
          if (done) return;
          if (lastInterim) return finish([lastInterim]);
          if (active(op) && deadline && performance.now() < deadline - 200) {
            restart = setTimeout(begin, 180);
            return;
          }
          finish(null);
        };
        bootTimer = setTimeout(() => {
          st.lastError =
            'The microphone did not start. Check its permission or choose another recognition engine.';
          emit();
          finish(null);
        }, 7000);
        try {
          r.start();
        } catch (e) {
          st.lastError = 'The microphone could not start: ' + String(e.message || e);
          emit();
          finish(null);
        }
      };
      begin();
    });
  }
  // Local/cloud engines share mono PCM capture. Finish after one second of quiet;
  // independent wall-clock timers also settle blocked or starved audio callbacks.
  async function capture(ms, onLevel, op = st.active) {
    if (!op) return null;
    phase(op, 'opening');
    let s;
    try {
      s = await Promise.race([stream(), op.cancelPromise]);
    } catch (e) {
      if (active(op)) {
        st.lastError =
          e.name === 'NotAllowedError'
            ? 'Microphone permission is blocked. Open Settings → Microphone → Fix permission.'
            : 'Microphone unavailable: ' + String(e.message || e.name);
        emit();
      }
      return null;
    }
    if (!s || !active(op)) return null;
    let ac, src, hp, proc, sink;
    try {
      ac = new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') await Promise.race([ac.resume(), op.cancelPromise]);
      if (!active(op)) {
        ac.close();
        return null;
      }
      src = ac.createMediaStreamSource(s);
      hp = ac.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 90;
      proc = ac.createScriptProcessor(2048, 1, 1);
      sink = ac.createGain();
      sink.gain.value = 0;
      src.connect(hp);
      hp.connect(proc);
      proc.connect(sink);
      sink.connect(ac.destination);
    } catch (e) {
      try {
        ac?.close();
      } catch {}
      st.lastError = 'Audio input could not start: ' + String(e.message || e);
      emit();
      return null;
    }
    const chunks = [],
      pre = [];
    let noise = 0.006,
      spoke = false,
      lastVoice = performance.now();
    phase(op, 'listening');
    const result = await new Promise((resolve) => {
      let done = false,
        quietTimer,
        firstTimer,
        hardTimer;
      const finish = (keep) => {
        if (done) return;
        done = true;
        clearTimeout(quietTimer);
        clearTimeout(firstTimer);
        clearTimeout(hardTimer);
        proc.onaudioprocess = null;
        op.cleanups.delete(cancel);
        resolve(keep && active(op));
      };
      const cancel = () => finish(false);
      op.cleanups.add(cancel);
      firstTimer = setTimeout(() => finish(false), ms);
      hardTimer = setTimeout(() => finish(spoke), ms + 15000);
      proc.onaudioprocess = (e) => {
        if (!active(op)) return finish(false);
        const x = e.inputBuffer.getChannelData(0);
        let en = 0;
        for (const a of x) en += a * a;
        const rms = Math.sqrt(en / x.length);
        st.level = rms;
        onLevel?.(rms);
        const now = performance.now(),
          copy = new Float32Array(x),
          isVoice = rms > Math.max(0.012, noise * 2.5);
        if (!spoke) {
          if (!isVoice) noise = noise * 0.98 + rms * 0.02;
          pre.push(copy);
          if (pre.length > 6) pre.shift();
        }
        if (isVoice) {
          if (!spoke) {
            spoke = true;
            clearTimeout(firstTimer);
            chunks.push(...pre);
          } else chunks.push(copy);
          lastVoice = now;
          clearTimeout(quietTimer);
          quietTimer = setTimeout(() => finish(true), 1000);
        } else if (spoke) chunks.push(copy);
      };
    });
    st.level = 0;
    for (const node of [src, hp, proc, sink])
      try {
        node.disconnect();
      } catch {}
    const rate = ac.sampleRate;
    try {
      await ac.close();
    } catch {}
    if (!result || !chunks.length || !active(op)) return null;
    const n = chunks.reduce((sum, c) => sum + c.length, 0),
      all = new Float32Array(n);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.length;
    }
    const offline = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
        1,
        Math.ceil((n * 16000) / rate),
        16000
      ),
      buffer = offline.createBuffer(1, n, rate);
    buffer.copyToChannel(all, 0);
    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start();
    const rendered = await Promise.race([offline.startRendering(), op.cancelPromise]);
    if (!rendered || !active(op)) return null;
    const pcm = rendered.getChannelData(0);
    let peak = 0;
    for (const x of pcm) peak = Math.max(peak, Math.abs(x));
    if (peak > 0.0001) {
      const gain = Math.min(8, 0.9 / peak);
      for (let i = 0; i < pcm.length; i++) pcm[i] *= gain;
    }
    return pcm;
  }
  function wav(pcm) {
    const b = new ArrayBuffer(44 + pcm.length * 2),
      v = new DataView(b),
      w = (o, s) => {
        for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
      };
    w(0, 'RIFF');
    v.setUint32(4, 36 + pcm.length * 2, true);
    w(8, 'WAVE');
    w(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 16000, true);
    v.setUint32(28, 32000, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    w(36, 'data');
    v.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++)
      v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
    return new Blob([b], { type: 'audio/wav' });
  }
  function settle(id, text) {
    const w = st.waiters.get(id);
    if (!w) return;
    clearTimeout(w.timer);
    st.waiters.delete(id);
    w.resolve(text);
  }
  function failed(error) {
    st.local = 'failed';
    st.lastError = 'On-device recognition could not load: ' + error;
    for (const id of [...st.waiters.keys()]) settle(id, null);
    emit();
  }
  /** Load or verify the recognizer. cacheOnly is forwarded to the worker before
   * it imports the inference library, so absent model files cannot trigger a download. */
  async function initLocal(options = {}) {
    if (['loading', 'ready'].includes(st.local)) return;
    st.local = 'loading';
    st.localProgress = 0;
    emit();
    try {
      let device = 'wasm';
      if (navigator.gpu && (await navigator.gpu.requestAdapter())) device = 'webgpu';
      if (st.local !== 'loading') return;
      const worker = new Worker('stt-worker.js', { type: 'module' });
      st.worker = worker;
      worker.onerror = (e) => {
        if (st.worker === worker) failed(e.message || 'Worker stopped');
      };
      worker.onmessageerror = () => {
        if (st.worker === worker) failed('Unreadable recognition response');
      };
      worker.onmessage = ({ data: m }) => {
        if (st.worker !== worker) return;
        if (m.type === 'progress') {
          st.localProgress = m.p;
          emit();
        } else if (m.type === 'ready') {
          st.local = 'ready';
          st.localDevice = m.device;
          settings.localStt = true;
          try {
            saveSettings();
          } catch {}
          emit();
        } else if (m.type === 'text' || (m.type === 'error' && m.id != null))
          settle(m.id, m.type === 'text' ? m.text : null);
        else if (m.type === 'error') failed(m.message);
      };
      worker.postMessage({ type: 'init', device, cacheOnly: !!options.cacheOnly });
    } catch (e) {
      failed(String(e.message || e));
    }
  }
  // Register the reply before posting. Cancellation removes queued work and resolves
  // this turn even if an already-running GPU inference cannot be interrupted.
  async function transcribeLocal(pcm, op) {
    if (st.local !== 'ready') return null;
    const id = ++st.seq;
    return new Promise((resolve) => {
      st.waiters.set(id, { resolve, timer: setTimeout(() => settle(id, null), 30000) });
      const cancel = () => {
        settle(id, null);
        st.worker?.postMessage({ type: 'drop', id });
      };
      op.cleanups.add(cancel);
      const original = st.waiters.get(id).resolve;
      st.waiters.get(id).resolve = (text) => {
        op.cleanups.delete(cancel);
        original(text);
      };
      try {
        st.worker.postMessage({ type: 'run', id, pcm }, [pcm.buffer]);
      } catch {
        settle(id, null);
      }
    });
  }
  async function requestText(url, headers, body, op) {
    const ctl = new AbortController(),
      cancel = () => ctl.abort(),
      timer = setTimeout(cancel, 12000);
    op.cleanups.add(cancel);
    try {
      const r = await fetch(url, { method: 'POST', headers, body, signal: ctl.signal });
      if (!active(op)) return null;
      if (!r.ok) throw Error('Recognition service returned ' + r.status);
      return String((await r.json()).text || '').trim() || null;
    } catch (e) {
      if (active(op)) {
        st.lastError = String(e.message || 'Cloud recognition could not be reached.');
        emit();
      }
      return null;
    } finally {
      clearTimeout(timer);
      op.cleanups.delete(cancel);
    }
  }
  // Called only for an explicitly selected cloud recognizer. A personal Groq key
  // is used there; the separate Murmur backup additionally requires noCloud === false.
  async function transcribeCloud(pcm, op) {
    if (!active(op)) return null;
    if (groqKey()) {
      const fd = new FormData();
      fd.append('file', wav(pcm), 'answer.wav');
      fd.append('model', 'whisper-large-v3-turbo');
      fd.append('language', 'en');
      fd.append('response_format', 'json');
      const text = await requestText(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        { Authorization: 'Bearer ' + groqKey() },
        fd,
        op
      );
      if (text || !active(op)) return text;
    }
    if (settings.noCloud !== false) return null;
    return requestText(CLOUD + '/stt', {}, wav(pcm), op);
  }
  const junk = (t) =>
    !t || /^(\W*|you|thank you\.?|thanks for watching!?|\[.*\]|\(.*\))$/i.test(t.trim());
  async function listenRecorded(ms, engine, op) {
    if (engine === 'groq' && !groqKey() && settings.noCloud !== false) {
      st.lastError =
        'Cloud recognition needs your chosen service connection. On-device mode keeps audio on this device.';
      emit();
      return null;
    }
    if (engine === 'local' && st.local !== 'ready') {
      if (settings.localStt && st.local !== 'loading') initLocal();
      st.lastError =
        st.local === 'loading'
          ? 'On-device recognition is preparing. Use the answer buttons, or wait for Audio settings to show Ready.'
          : 'Download on-device recognition in Audio settings, or choose built-in recognition.';
      emit();
      return null;
    }
    const pcm = await capture(ms, null, op);
    if (!pcm || !active(op)) return null;
    phase(op, 'transcribing');
    const text =
      engine === 'groq' ? await transcribeCloud(pcm, op) : await transcribeLocal(pcm, op);
    return active(op) && !junk(text) ? [text] : null;
  }
  /** Fully discard the recognizer for setup recovery; preserve no stale readiness. */
  function reset() {
    stop();
    release();
    for (const id of [...st.waiters.keys()]) settle(id, null);
    st.worker?.terminate();
    st.worker = null;
    st.local = 'off';
    st.localProgress = 0;
    st.localDevice = null;
    st.lastError = '';
    st.nativeBroken = false;
    emit();
  }
  return {
    st,
    mode,
    initLocal,
    wav,
    capture,
    stop,
    release,
    reset,
    onChange(fn) {
      st.listeners.add(fn);
      return () => st.listeners.delete(fn);
    },
    get available() {
      return settings.mic && mode() !== 'none';
    },
    get label() {
      return {
        native: 'Built-in speech recognition',
        local:
          'On-device Whisper' +
          (st.local === 'ready'
            ? ' (' + st.localDevice + ')'
            : st.local === 'loading'
              ? ' (preparing)'
              : ''),
        groq: 'Whisper in the cloud',
        none: 'Not available'
      }[mode()];
    },
    /** One owner per answer window. A cancelled turn returns null and can never
     * deliver a late transcript or clear the next turn's microphone state. */
    async listen(ms = 15000, opts = {}) {
      stop();
      if (!settings.mic) return null;
      const op = { cancelled: false, cleanups: new Set(), onState: opts.onState };
      op.cancelPromise = new Promise((r) => (op.resolveCancel = r));
      st.active = op;
      st.abort = stop;
      try {
        const selected = mode();
        let result;
        if (selected === 'native') {
          phase(op, 'opening');
          result = await listenNative(ms, op);
          if (result?.retry && active(op)) {
            const fallback = mode();
            result = fallback === 'native' ? null : await listenRecorded(ms, fallback, op);
          }
        } else if (selected === 'local' || selected === 'groq')
          result = await listenRecorded(ms, selected, op);
        return active(op) ? result : null;
      } finally {
        if (st.active === op) {
          st.active = null;
          st.abort = null;
          st.listening = false;
          st.level = 0;
          emit();
        }
      }
    },
    async permission() {
      try {
        return (await navigator.permissions.query({ name: 'microphone' })).state;
      } catch {
        return 'unknown';
      }
    },
    async request() {
      try {
        return !!(await stream());
      } catch (e) {
        st.lastError =
          e.name === 'NotAllowedError' ? 'Permission was refused.' : String(e.message || e);
        emit();
        return false;
      }
    },
    async devices() {
      try {
        return (await navigator.mediaDevices.enumerateDevices()).filter(
          (d) => d.kind === 'audioinput'
        );
      } catch {
        return [];
      }
    }
  };
})();
