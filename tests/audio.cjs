'use strict';
const fs = require('fs'),
  path = require('path'),
  vm = require('vm'),
  assert = require('assert');
const root = path.resolve(__dirname, '../docs'),
  read = (n) => fs.readFileSync(path.join(root, n), 'utf8');
let tests = 0;
async function test(name, fn) {
  let watchdog;
  try {
    await Promise.race([
      fn(),
      new Promise(
        (_, reject) => (watchdog = setTimeout(() => reject(Error('Test did not settle')), 3000))
      )
    ]);
    tests++;
  } catch (e) {
    console.error('FAIL', name);
    throw e;
  } finally {
    clearTimeout(watchdog);
  }
}
const flush = async () => {
  for (let i = 0; i < 16; i++) await Promise.resolve();
};
class Clock {
  constructor() {
    this.now = 0;
    this.id = 0;
    this.jobs = new Map();
  }
  set(fn, ms, repeat = false) {
    const id = ++this.id;
    this.jobs.set(id, { fn, at: this.now + ms, ms, repeat });
    return id;
  }
  clear(id) {
    this.jobs.delete(id);
  }
  async advance(ms) {
    const end = this.now + ms;
    for (let n = 0; n < 10000; n++) {
      await flush();
      let next = [...this.jobs.entries()]
        .filter(([id, x]) => x.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) {
        this.now = end;
        await flush();
        return;
      }
      const [id, job] = next;
      this.now = job.at;
      this.jobs.delete(id);
      if (job.repeat) this.jobs.set(id, { ...job, at: this.now + job.ms });
      job.fn();
    }
    throw Error('timer loop');
  }
}
function setup(extra = {}) {
  const clock = new Clock(),
    utterances = [],
    recognizers = [],
    workers = [],
    requests = [],
    contexts = [],
    streams = [];
  const c = {
    console,
    Math,
    Date,
    Map,
    Set,
    Promise,
    URL,
    URLSearchParams,
    ArrayBuffer,
    DataView,
    Float32Array,
    Blob,
    AbortController,
    FormData,
    performance: { now: () => clock.now },
    settings: { rate: 1, voice: 'chosen', mic: true, earMode: 'native', noCloud: true, keys: {} },
    saveSettings() {},
    sleep: (ms) => new Promise((r) => clock.set(r, ms)),
    setTimeout: (f, ms) => clock.set(f, ms),
    clearTimeout: (id) => clock.clear(id),
    setInterval: (f, ms) => clock.set(f, ms, true),
    clearInterval: (id) => clock.clear(id),
    navigator: {
      gpu: { requestAdapter: async () => ({}) },
      mediaDevices: {
        getUserMedia: async () => {
          const s = {
            active: true,
            stopped: 0,
            getTracks() {
              return [
                {
                  stop: () => {
                    s.stopped++;
                    s.active = false;
                  }
                }
              ];
            }
          };
          streams.push(s);
          return s;
        }
      }
    },
    caches: { open: async () => ({ match: async () => null }) },
    fetch: async (...args) => {
      requests.push(args);
      return { ok: true, json: async () => ({ text: 'answer' }) };
    },
    SpeechSynthesisUtterance: function (text) {
      this.text = text;
    },
    speechSynthesis: {
      getVoices: () => [
        { name: 'Chosen voice', voiceURI: 'chosen', lang: 'en-CA' },
        { name: 'Google Natural', voiceURI: 'other', lang: 'en-US' }
      ],
      cancel() {},
      speak(u) {
        utterances.push(u);
        clock.set(() => u.onstart?.(), 0);
      }
    },
    SpeechRecognition: class {
      constructor() {
        recognizers.push(this);
      }
      start() {
        clock.set(() => this.onstart?.(), 0);
      }
      abort() {}
      stop() {}
    },
    Worker: class {
      constructor(url) {
        this.url = url;
        this.messages = [];
        workers.push(this);
      }
      postMessage(m) {
        this.messages.push(m);
      }
      terminate() {
        this.terminated = true;
      }
    },
    AudioContext: class {
      constructor() {
        this.state = 'running';
        this.sampleRate = 48000;
        this.destination = {};
        this.closed = false;
        contexts.push(this);
      }
      get currentTime() {
        return clock.now / 1000;
      }
      resume() {
        this.state = 'running';
        return Promise.resolve();
      }
      close() {
        this.closed = true;
        return Promise.resolve();
      }
      node() {
        return { connect() {}, disconnect() {} };
      }
      createMediaStreamSource() {
        return this.node();
      }
      createBiquadFilter() {
        return { ...this.node(), frequency: {} };
      }
      createScriptProcessor() {
        return (this.proc = { ...this.node() });
      }
      createGain() {
        return { ...this.node(), gain: {} };
      }
      createBuffer(ch, n, sr) {
        return { duration: n / sr, copyToChannel() {} };
      }
      createBufferSource() {
        return { ...this.node(), start() {}, stop() {} };
      }
    },
    OfflineAudioContext: class {
      createBuffer() {
        return { copyToChannel() {} };
      }
      createBufferSource() {
        return { connect() {}, start() {} };
      }
      startRendering() {
        return Promise.resolve({ getChannelData: () => new Float32Array(16000).fill(0.1) });
      }
    }
  };
  Object.assign(c, extra);
  c.window = c;
  vm.createContext(c);
  for (const file of ['speechtext.js', 'voice.js', 'ear.js'])
    vm.runInContext(read(file), c, { filename: file });
  vm.runInContext('globalThis.audio={Voice,Ear,SpeechText};', c);
  return { c, clock, utterances, recognizers, workers, requests, contexts, streams, ...c.audio };
}
function app(h) {
  const c = h.c,
    source = read('app.js'),
    els = {},
    calls = { speech: [], status: [], options: [] };
  c.$ = (id) => (els[id] ??= { textContent: '', style: {}, play: async () => {}, pause() {} });
  c.location = { search: '?qa=1' };
  c.UI = {
    status: (...x) => calls.status.push(x),
    stage() {},
    highlightAt() {},
    heard() {},
    options: (x) => calls.options.push(x),
    setPause() {},
    show() {},
    summary() {},
    count() {},
    mark() {}
  };
  c.Parse = { command: (s) => s };
  c.COURSE_VAR = {};
  c.COURSE_ORDER = ['DIGI210'];
  c.courseName = (c) => c;
  c.progress = { lectures: {}, sessions: [], topics: {} };
  c.saveProgress = () => {};
  c.Sync = { pushSoon() {} };
  c.Study = null;
  c.Help = {};
  c.Tutorbot = {};
  c.Tutor = {};
  c.Media = { start() {}, stop() {} };
  c.byId = {};
  c.lectureById = {};
  c.bank = { lectures: [] };
  c.unlocked = () => true;
  c.focusScore = () => 0;
  c.pickOne = (a) => a[0];
  c.topicKey = (c, t) => c + '|' + t;
  const a = source.indexOf('const Input = {'),
    b = source.indexOf('// Media Session:', a),
    sp = source.indexOf('async function speak(text,'),
    se = source.indexOf(
      '// ------------------------------------------------------------------ TUTOR',
      sp
    ),
    la = source.indexOf('const Lecture = {'),
    lb = source.indexOf('const Sync = {', la);
  assert(a >= 0 && b > a && sp > b && se > sp && la > se && lb > la,
    'session fixture must isolate the real session and lecture declarations');
  vm.runInContext(
    source.slice(a, b) +
      source.slice(sp, se) +
      source.slice(la, lb) +
      ';globalThis.flow={Input,Session,Lecture,speak,hear,speakThenWindow};',
    c
  );
  c.flow.Session.running = true;
  return { ...c.flow, calls, els };
}
(async () => {
  await test('pronunciation and engineering normalization preserve displayed source positions', () => {
    const h = setup(),
      source = 'Boolean LOW HIGH decoupling: 4.7 kΩ, 5 µA, 2 MΩ, 74LS00 and x².';
    const p = h.SpeechText.prepare(source);
    assert(p.text.includes('boo lee un low high dee coupling'));
    assert(p.text.includes('kilo ohms'));
    assert(p.text.includes('microamps'));
    assert(p.text.includes('mega ohms'));
    assert(p.text.includes('seventy four L S 0 0'));
    assert(p.text.includes('x squared'));
    assert.equal(p.map.length, p.text.length);
    assert(p.map.every((x, i) => x >= 0 && x < source.length && (!i || x >= p.map[i - 1])));
    assert.equal(h.SpeechText.display('kilohms', '4.7'), 'kΩ');
    assert.equal(h.SpeechText.forTTS('communicative'), 'kuh myoo nih kuh tiv');
    assert.equal(h.SpeechText.forTTS('commutative'), 'kuh myoo tuh tiv');
    assert.notEqual(h.SpeechText.forTTS('communicative'), h.SpeechText.forTTS('commutative'));
    assert.equal(h.SpeechText.forTTS('Boolean'), 'boo lee un');
    assert.equal(source, 'Boolean LOW HIGH decoupling: 4.7 kΩ, 5 µA, 2 MΩ, 74LS00 and x².');
  });
  await test('stopping system speech settles even when browser sends no cancel event', async () => {
    const h = setup();
    h.Voice.init({ skipNeural: true });
    const p = h.Voice.say('A very long unfinished sentence.');
    await h.clock.advance(0);
    h.Voice.stop();
    assert.equal(await p, false);
    assert.equal(h.clock.jobs.size, 0);
  });
  await test('old utterance callback cannot end newer playback', async () => {
    const h = setup();
    let first = h.Voice.say('First.'),
      oldEnd = h.utterances[0].onend;
    let second = h.Voice.say('Second.');
    assert.equal(await first, false);
    oldEnd();
    assert(h.Voice.speaking);
    h.utterances[1].onend();
    assert.equal(await second, true);
    assert(!h.Voice.speaking);
  });
  await test('system voice respects selection and maps expanded word boundaries', async () => {
    const h = setup();
    h.Voice.init({ skipNeural: true });
    let at;
    const text = 'Boolean LOW decoupling.';
    const p = h.Voice.say(text, { onProgress: (x) => (at = x) });
    const u = h.utterances[0];
    assert.equal(u.voice.voiceURI, 'chosen');
    u.onboundary({ charIndex: u.text.indexOf('low'), name: 'word' });
    assert.equal(at, text.indexOf('LOW'));
    h.Voice.stop();
    await p;
  });
  await test('system rewind begins within long sentence at a source word boundary', async () => {
    const h = setup(),
      text = 'One two three four five six seven eight nine ten eleven twelve';
    const p = h.Voice.say(text, { startAt: 2 });
    assert(!h.utterances[0].text.startsWith('One'));
    assert(h.utterances[0].text.endsWith('twelve'));
    h.Voice.stop();
    await p;
  });
  await test('cancelled neural generation resolves immediately and clears waiters', async () => {
    const h = setup();
    await h.Voice.initNeural(true, { cacheOnly: true });
    let w = h.workers[0];
    assert(w.messages[0].cacheOnly);
    w.onmessage({ data: { type: 'ready', device: 'webgpu' } });
    const p = h.Voice.say('Waiting for generated audio.');
    await flush();
    assert(h.Voice.st.waiters.size > 0);
    h.Voice.stop();
    assert.equal(await p, false);
    assert.equal(h.Voice.st.waiters.size, 0);
    assert(w.messages.some((m) => m.type === 'drop'));
  });
  await test('reset during adapter preparation cannot revive a discarded voice worker', async () => {
    let resolve;
    const h = setup({
      navigator: {
        gpu: { requestAdapter: () => new Promise((r) => (resolve = r)) },
        mediaDevices: {}
      }
    });
    const p = h.Voice.initNeural(true);
    h.Voice.reset();
    resolve({});
    await p;
    assert.equal(h.workers.length, 0);
    assert.equal(h.Voice.st.neural, 'off');
  });
  await test('native short silence restarts within one consistent question deadline', async () => {
    const h = setup();
    let settled = false,
      p = h.Ear.listen(15000).then((x) => {
        settled = true;
        return x;
      });
    await h.clock.advance(0);
    h.recognizers[0].onend();
    await h.clock.advance(200);
    assert.equal(h.recognizers.length, 2);
    assert(!settled);
    await h.clock.advance(14800);
    assert.equal(await p, null);
    assert.equal(h.Ear.st.active, null);
  });
  await test('late speech receives time to finish instead of being cut off', async () => {
    const h = setup();
    let settled = false,
      p = h.Ear.listen(15000).then((x) => {
        settled = true;
        return x;
      });
    await h.clock.advance(14500);
    h.recognizers[0].onspeechstart();
    await h.clock.advance(1000);
    assert(!settled);
    h.recognizers[0].onresult({
      results: [Object.assign([{ transcript: 'option two' }], { isFinal: true })]
    });
    assert.deepEqual(Array.from(await p), ['option two']);
  });
  await test('cancelled recognizer cannot submit an answer to the next question', async () => {
    const h = setup();
    let p1 = h.Ear.listen(),
      oldResult = h.recognizers[0].onresult,
      p2 = h.Ear.listen();
    assert.equal(await p1, null);
    oldResult({ results: [[{ transcript: 'old answer' }]] });
    let active = h.Ear.st.active;
    assert(active);
    h.recognizers[1].onresult({ results: [[{ transcript: 'new answer' }]] });
    assert.deepEqual(Array.from(await p2), ['new answer']);
  });
  await test('local mode never uploads audio or starts an unconfirmed model download', async () => {
    const h = setup();
    h.c.settings.earMode = 'local';
    assert.equal(await h.Ear.listen(), null);
    assert.equal(h.requests.length, 0);
    assert.equal(h.workers.length, 0);
    assert.equal(h.contexts.length, 0);
    assert(h.Ear.st.lastError.includes('Download'));
  });
  await test('ending during microphone permission ignores and releases late stream', async () => {
    let allow;
    const h = setup();
    h.c.settings.earMode = 'local';
    h.Ear.st.local = 'ready';
    h.c.navigator.mediaDevices.getUserMedia = () => new Promise((r) => (allow = r));
    const p = h.Ear.listen();
    await flush();
    h.Ear.stop();
    h.Ear.release();
    assert.equal(await p, null);
    let stopped = 0;
    allow({ active: true, getTracks: () => [{ stop: () => stopped++ }] });
    await flush();
    assert.equal(stopped, 1);
    assert.equal(h.contexts.length, 0);
  });
  await test('recording starvation has a wall-clock deadline and closes its audio context', async () => {
    const h = setup();
    h.c.settings.earMode = 'local';
    h.Ear.st.local = 'ready';
    const p = h.Ear.listen(1000);
    await flush();
    assert.equal(h.contexts.length, 1);
    await h.clock.advance(1000);
    assert.equal(await p, null);
    assert(h.contexts[0].closed);
    assert.equal(h.requests.length, 0);
  });
  await test('local transcription cancelled before worker result cannot reach next turn', async () => {
    const h = setup();
    h.c.settings.earMode = 'local';
    await h.Ear.initLocal({ cacheOnly: true });
    const w = h.workers[0];
    assert(w.messages[0].cacheOnly);
    w.onmessage({ data: { type: 'ready', device: 'webgpu' } });
    const p = h.Ear.listen(1000);
    await flush();
    h.contexts[0].proc.onaudioprocess({
      inputBuffer: { getChannelData: () => new Float32Array(2048).fill(0.1) }
    });
    await h.clock.advance(1000);
    await flush();
    assert(w.messages.some((m) => m.type === 'run'));
    const run = w.messages.find((m) => m.type === 'run');
    h.Ear.stop();
    assert.equal(await p, null);
    w.onmessage({ data: { type: 'text', id: run.id, text: 'late answer' } });
    assert.equal(h.Ear.st.waiters.size, 0);
    assert.equal(h.requests.length, 0);
  });
  await test('input timeout from an older wait never stops a newer microphone', async () => {
    const h = setup(),
      f = app(h);
    h.c.settings.mic = false;
    let p1 = f.Input.get(1000, false);
    await h.clock.advance(100);
    let p2 = f.Input.get(2000, false);
    assert.equal(await p1, null);
    await h.clock.advance(1000);
    assert(f.Input.pending);
    f.Input.push({ answer: 1 });
    assert.equal((await p2).cmd.answer, 1);
    assert.equal(h.clock.jobs.size, 0);
  });
  await test('microphone-off command windows last the requested short duration', async () => {
    const h = setup(),
      f = app(h);
    h.c.settings.mic = false;
    let done = false,
      p = f.Input.get(2500, true).then(() => (done = true));
    await h.clock.advance(2499);
    assert(!done);
    await h.clock.advance(1);
    await p;
    assert(done);
  });
  await test('pause/resume resumes at saved audio position, without a fifteen-second jump', async () => {
    const h = setup(),
      f = app(h);
    let calls = [],
      finish;
    h.Voice.st.lastPos = 7;
    Object.assign(h.Voice, {
      say: (t, o) => {
        calls.push(o.startAt);
        return calls.length === 1 ? new Promise((r) => (finish = r)) : Promise.resolve(true);
      },
      stop: () => finish?.(false)
    });
    const p = f.speak('lesson');
    await flush();
    f.Session.pause();
    await flush();
    f.Session.resume();
    assert.equal(await p, true);
    assert.deepEqual(calls, [0, 7]);
    assert.equal(h.Ear.st.active, null);
  });
  await test('question rewind exits question and targets previous lesson audio', async () => {
    const h = setup(),
      f = app(h);
    Object.assign(h.Voice, { say: async () => true, stop() {}, durationOf: (t) => Number(t) });
    h.c.queue = [{ cmd: 'repeat' }];
    vm.runInContext('hear=async()=>queue.shift();', h.c);
    const segment = {
      id: 's',
      L: { course: 'DIGI210' },
      topic: 'Timing',
      check: { type: 'tf', q: 'Is this true?', answer: true }
    };
    assert.equal(await f.Lecture.quickCheck(segment, 'check'), 'rewind');
    assert.equal(f.calls.options.at(-1), null);
    const target = f.Lecture.rewindTarget([{ text: '20' }, { text: '4' }, { text: '3' }], 2, 3);
    assert.equal(target.index, 0);
    assert.equal(target.startAt, 12);
  });
  await test('lecture replays its last fifteen seconds before asking the check again', async () => {
    const h = setup(),
      f = app(h),
      said = [];
    h.c.settings.mic = false;
    const L = { course: 'DIGI210', title: 'Lesson' };
    const list = [
      { id: 'one', text: 'first lesson', L, key: 'lesson', index: 0, total: 2, title: 'First' },
      {
        id: 'two',
        text: 'second lesson',
        L,
        key: 'lesson',
        index: 1,
        total: 2,
        title: 'Second',
        check: {}
      }
    ];
    f.Lecture.playlist = () => list;
    let checks = 0;
    f.Lecture.quickCheck = async () => (++checks === 1 ? 'rewind' : undefined);
    Object.assign(h.Voice, {
      say: async (t, o) => {
        said.push({ t, startAt: o.startAt });
        return true;
      },
      stop() {},
      prefetch() {},
      durationOf: () => 30
    });
    const p = f.Lecture.run('DIGI210', { len: 20 });
    await flush();
    await h.clock.advance(300);
    await p;
    const repeats = said.filter((x) => x.t === 'second lesson');
    assert.equal(repeats.length, 2);
    assert.equal(repeats[1].startAt, 15);
    assert.equal(checks, 2);
  });
  await test('required audio gate blocks sessions outside isolated QA', async () => {
    const h = setup(),
      f = app(h);
    f.Session.running = false;
    h.c.location.search = '';
    let opened = 0;
    h.c.murmurAudioSetup = { ensureReady: () => opened++ };
    await f.Session.start('lecture', 'DIGI210');
    assert.equal(opened, 1);
    assert(!f.Session.running);
  });
  await test('cache-only worker preparation never fetches missing model files', async () => {
    for (const file of ['tts-worker.js', 'stt-worker.js']) {
      const prefix = read(file).slice(0, read(file).indexOf('// Murmur —')),
        requests = [],
        saved = { ok: true };
      const ctx = {
        URL,
        location: { href: 'https://app.example/worker.js' },
        fetch: async (...x) => {
          requests.push(x);
          return { ok: true };
        },
        caches: {
          open: async (name) => ({
            match: async (input) =>
              String(input) === 'https://huggingface.co/model/cached' ? saved : null
          })
        }
      };
      ctx.globalThis = ctx;
      vm.createContext(ctx);
      vm.runInContext(prefix + ';useCachedModelsOnly();', ctx);
      assert.equal(await ctx.fetch('https://huggingface.co/model/cached'), saved);
      await assert.rejects(() => ctx.fetch('https://huggingface.co/model/missing'), /missing/);
      assert.equal(requests.length, 0);
      await ctx.fetch('https://cdn.jsdelivr.net/npm/runtime/dist/runtime.wasm');
      assert.equal(requests.length, 1);
    }
  });

  await test('recognizer reset cancels preparation and returns to an honest off state', async () => {
    let resolve;
    const h = setup({
      navigator: {
        gpu: { requestAdapter: () => new Promise((r) => (resolve = r)) },
        mediaDevices: { getUserMedia: async () => {} }
      }
    });
    const p = h.Ear.initLocal({ cacheOnly: true });
    h.Ear.reset();
    resolve({});
    await p;
    assert.equal(h.workers.length, 0);
    assert.equal(h.Ear.st.local, 'off');
    assert.equal(h.Ear.st.waiters.size, 0);
  });
  await test('recognition worker serializes inference and drops cancelled queued turns', async () => {
    const messages = [],
      calls = [],
      pending = [];
    const c = {
      URL,
      fetch: async () => {},
      postMessage: (m) => messages.push(m),
      Float32Array,
      console,
      location: { href: 'https://example/stt-worker.js' }
    };
    c.globalThis = c;
    vm.createContext(c);
    vm.runInContext(read('stt-worker.js') + ';globalThis.setASR=f=>asr=f;', c);
    c.setASR(
      (pcm) =>
        new Promise((resolve) => {
          calls.push(pcm);
          pending.push(resolve);
        })
    );
    c.onmessage({ data: { type: 'run', id: 1, pcm: 'one' } });
    c.onmessage({ data: { type: 'run', id: 2, pcm: 'two' } });
    c.onmessage({ data: { type: 'drop', id: 2 } });
    c.onmessage({ data: { type: 'run', id: 3, pcm: 'three' } });
    assert.deepEqual(calls, ['one']);
    pending.shift()({ text: 'first' });
    await flush();
    assert.deepEqual(calls, ['one', 'three']);
    pending.shift()({ text: 'third' });
    await flush();
    assert.deepEqual(
      messages.map((m) => m.id),
      [1, 3]
    );
  });
  await test('worker runtime-import failures become visible initialization errors', async () => {
    for (const file of ['tts-worker.js', 'stt-worker.js']) {
      const messages = [],
        c = {
          URL,
          fetch: async () => {},
          postMessage: (m) => messages.push(m),
          Float32Array,
          console,
          location: { href: 'https://example/' + file }
        };
      c.globalThis = c;
      vm.createContext(c);
      vm.runInContext(read(file), c);
      c.onmessage({ data: { type: 'init', device: 'webgpu' } });
      await flush();
      assert(
        messages.some((m) => m.type === 'error' && m.id == null),
        file + ' failed to report initialization error'
      );
    }
  });
  await test('CDN audio runtime is cached offline separately from app versions and model/API files', async () => {
    const handlers = {},
      saved = new Map(),
      opened = [],
      jobs = [];
    let online = true,
      fetches = 0;
    const response = {
        ok: true,
        clone() {
          return this;
        }
      },
      c = {
        URL,
        location: { origin: 'https://app.example' },
        self: {
          addEventListener: (n, fn) => (handlers[n] = fn),
          skipWaiting() {},
          clients: { claim() {} }
        },
        caches: {
          open: async (name) => {
            opened.push(name);
            return {
              match: async (req) => saved.get(req.url),
              put: async (req, val) => saved.set(req.url, val)
            };
          }
        },
        fetch: async () => {
          fetches++;
          if (!online) throw Error('offline');
          return response;
        }
      };
    vm.createContext(c);
    vm.runInContext(read('sw.js'), c);
    const request = {
      url: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/runtime.wasm',
      method: 'GET'
    };
    let result;
    handlers.fetch({ request, respondWith: (p) => (result = p), waitUntil: (p) => jobs.push(p) });
    assert.equal(await result, response);
    await Promise.all(jobs);
    online = false;
    handlers.fetch({ request, respondWith: (p) => (result = p), waitUntil: (p) => jobs.push(p) });
    assert.equal(await result, response);
    assert.equal(fetches, 1);
    assert(opened.every((n) => n === 'murmur-audio-runtime-v1'));
    for (const url of [
      'https://huggingface.co/model/resolve/main/weights.onnx',
      'https://api.groq.com/transcribe'
    ])
      handlers.fetch({
        request: { url, method: 'GET' },
        respondWith: () => assert.fail('Must leave model/API handling to its owner')
      });
  });
  await test('double start cannot create overlapping session loops', async () => {
    const h = setup(),
      f = app(h);
    f.Session.running = false;
    let finish,
      starts = 0;
    f.Lecture.run = () => {
      starts++;
      return new Promise((r) => (finish = r));
    };
    const first = f.Session.start('lecture', 'DIGI210');
    await flush();
    await f.Session.start('lecture', 'DIGI210');
    assert.equal(starts, 1);
    assert(f.Session.busy);
    finish();
    await first;
    assert(!f.Session.busy);
    assert(!f.Session.running);
    assert.equal(h.c.progress.sessions.length, 1);
  });

  await test('topic playlists contain only that course and topic, including actual Boolean material', async () => {
    const h = setup(),
      f = app(h),
      bank = JSON.parse(read('bank.json'));
    h.c.bank = bank;
    h.c.COURSE_ORDER = Object.keys(bank.courses);
    h.c.lectureById = Object.fromEntries(bank.lectures.map((l) => [l.id, l]));
    let checked = 0;
    for (const [course, info] of Object.entries(bank.courses))
      for (const topic of info.topics) {
        const list = f.Lecture.playlist(course, {
          pick: 'topic',
          topic: course + '|' + topic,
          len: 1000
        });
        assert(list.every((s) => s.L.course === course && s.topic === topic));
        checked += list.length;
      }
    assert(checked > 100);
    assert.equal(
      f.Lecture.playlist('MATH237', {
        pick: 'topic',
        topic: 'DIGI210|Boolean algebra & simplification',
        len: 20
      }).length,
      0
    );
    assert.equal(f.Lecture.playlist('DIGI210', { pick: 'topic', len: 20 }).length, 0);
    assert.equal(
      f.Lecture.playlist('DIGI210', { pick: 'lecture', id: 'missing', len: 20 }).length,
      0
    );
    const other = bank.lectures.find((l) => l.course === 'MATH237');
    assert.equal(
      f.Lecture.playlist('DIGI210', { pick: 'lecture', id: other.id, len: 20 }).length,
      0
    );
  });
  await test('topic introduction and completion use chosen topic while source context remains visible', async () => {
    const h = setup(),
      f = app(h),
      said = [];
    h.c.settings.mic = false;
    f.Lecture.playlist = () => [
      {
        id: 's',
        topic: 'Boolean algebra & simplification',
        text: 'The Boolean rule.',
        L: { course: 'DIGI210', title: 'Schematic conventions and unused gates' },
        title: 'Boolean law',
        key: 'topic:DIGI210|Boolean algebra & simplification',
        index: 0,
        total: 1
      }
    ];
    Object.assign(h.Voice, {
      say: async (text) => {
        said.push(text);
        return true;
      },
      stop() {},
      prefetch() {}
    });
    await f.Lecture.run('DIGI210', {
      pick: 'topic',
      topic: 'DIGI210|Boolean algebra & simplification',
      len: 20
    });
    assert(said[0].startsWith('Topic: Boolean algebra & simplification.'));
    assert(said.some((t) => t === 'That is the end of Boolean algebra & simplification.'));
    assert(f.Session.ctx.title.includes('Schematic conventions and unused gates'));
    f.Lecture.playlist = () => [
      {
        id: 's',
        topic: 'Boolean algebra & simplification',
        text: 'A continuation.',
        L: { course: 'DIGI210', title: 'Source lecture' },
        title: 'Point',
        key: 'topic:key',
        index: 2,
        total: 3
      }
    ];
    said.length = 0;
    await f.Lecture.run('DIGI210', { pick: 'topic', len: 20 });
    assert(said[0].startsWith('Continuing topic: Boolean algebra & simplification.'));
  });
  await test('topic and class choices expose selection and reject stale selections after course change', () => {
    const h = setup(),
      f = app(h),
      c = h.c,
      bank = JSON.parse(read('bank.json')),
      elements = {};
    const make = () => {
      const e = {
        children: [],
        style: { setProperty() {} },
        classList: { toggle() {} },
        setAttribute(k, v) {
          this[k] = String(v);
        },
        append(x) {
          this.children.push(x);
        }
      };
      Object.defineProperty(e, 'innerHTML', {
        set(v) {
          this.html = v;
          this.children = [];
        },
        get() {
          return this.html || '';
        }
      });
      return e;
    };
    c.$ = (id) => (elements[id] ??= make());
    c.document = { createElement: make, querySelectorAll: () => [] };
    c.esc = String;
    c.bank = bank;
    c.COURSE_ORDER = Object.keys(bank.courses);
    c.lectureById = Object.fromEntries(bank.lectures.map((l) => [l.id, l]));
    c.focusLabel = () => '';
    c.coursePct = () => 0;
    c.renderVoiceChip = () => {};
    c.renderStats = () => {};
    c.renderAdaptive = () => {};
    const source = read('app.js');
    vm.runInContext(
      source.slice(
        source.indexOf('function renderHome()'),
        source.indexOf('function renderAdaptive()')
      ) +
        source.slice(
          source.indexOf('function renderPick()'),
          source.indexOf('function renderStats()')
        ),
      c
    );
    Object.assign(c.settings, {
      mode: 'lecture',
      course: 'DIGI210',
      pick: 'topic',
      pickTopic: 'DIGI210|Boolean algebra & simplification'
    });
    c.renderHome();
    c.renderPick();
    assert.equal(elements.btnStart.disabled, false);
    assert.equal(elements.pickList.children.filter((b) => b['aria-pressed'] === 'true').length, 1);
    const mathIndex = c.COURSE_ORDER.indexOf('MATH237');
    elements.courseGrid.children[mathIndex].onclick();
    assert.equal(c.settings.pickTopic, undefined);
    assert.equal(elements.btnStart.disabled, true);
    assert.equal(elements.startLabel.textContent, 'Choose a topic above');
    elements.pickList.children[0].onclick();
    assert.equal(elements.btnStart.disabled, false);
    assert.equal(elements.pickList.children.filter((b) => b['aria-pressed'] === 'true').length, 1);
    c.settings.pick = 'lecture';
    delete c.settings.pickId;
    c.renderHome();
    c.renderPick();
    assert.equal(elements.btnStart.disabled, true);
    assert.equal(elements.startLabel.textContent, 'Choose a class above');
    elements.pickList.children[0].onclick();
    assert.equal(elements.btnStart.disabled, false);
    assert.equal(elements.pickList.children.filter((b) => b['aria-pressed'] === 'true').length, 1);
    elements.courseGrid.children[0].onclick();
    assert.equal(c.settings.pickId, undefined);
    assert.equal(elements.btnStart.disabled, true);
  });
  console.log(
    tests + ' deterministic speech, microphone, playback and cache-verification tests passed'
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
