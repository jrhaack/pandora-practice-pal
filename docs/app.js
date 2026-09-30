/* Pandora Practice Pal — hands-free lecture + tutor app for the Pandora vault. */
'use strict';
const VERSION = '1.1.3';
const $ = (id) => document.getElementById(id);
const todayISO = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const DAY = 86400000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const COURSE_ORDER = ['DIGI210', 'ELTR238', 'MATH237', 'EFAB202'];
const COURSE_VAR = { DIGI210: 'var(--digi)', ELTR238: 'var(--eltr)', MATH237: 'var(--math)', EFAB202: 'var(--efab)', MIX: 'var(--mix)', FOCUS: 'var(--focus)' };

// ------------------------------------------------------------------ storage
function load(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } }
function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage may be unavailable */ } }
const settings = Object.assign({ rate: 1, voice: '', mic: true, optionsAloud: true, apiKey: '', model: '', provider: 'gemini', baseUrl: '', ghRepo: '', ghToken: '', len: 20, mode: 'lecture', course: 'FOCUS', pick: 'next' }, load('pp.settings', {}));
const progress = Object.assign({ v: 1, items: {}, lessons: {}, lectures: {}, topics: {}, sessions: [], updated: 0 }, load('pp.progress', {}));
const saveSettings = () => save('pp.settings', settings);
const saveProgress = () => { progress.updated = Date.now(); save('pp.progress', progress); };

// ------------------------------------------------------------------ bank
let bank = null, byId = {}, lessonById = {}, lectureById = {};
async function loadBank() {
  let data = null;
  try { const r = await fetch('bank.json', { cache: 'no-cache' }); if (r.ok) data = await r.json(); } catch (e) { /* offline */ }
  if (!data) data = load('pp.bank', null);
  if (!data) throw new Error('No question bank available. Open the app once while online.');
  save('pp.bank', data);
  bank = data; byId = {}; lessonById = {}; lectureById = {};
  for (const i of bank.items) byId[i.id] = i;
  for (const l of bank.lessons) lessonById[l.id] = l;
  for (const L of bank.lectures) lectureById[L.id] = L;
}
const unlocked = (x) => x.unlock <= todayISO();
const courseName = (c) => bank.courses[c] ? bank.courses[c].name : c;

// ------------------------------------------------------------------ priorities (focus pack)
function topicKey(c, t) { return c + '|' + t; }
function appWeakness(c, t) { const a = progress.topics[topicKey(c, t)]; if (!a || a.n < 2) return 0; return (a.bad / a.n); }
function focusScore(course, topic) {
  let s = 0;
  const today = todayISO();
  for (const q of (bank.focus.quizzes || [])) {
    if (q.course !== course || q.date < today) continue;
    const days = Math.round((new Date(q.date) - new Date(today)) / DAY);
    if (days <= 14) s += days <= 3 ? 4 : days <= 7 ? 3 : 2;
  }
  const pw = bank.focus.pluginWeak && bank.focus.pluginWeak[topicKey(course, topic)];
  if (pw && pw.attempts >= 2) s += (1 - pw.score) * 3;
  s += appWeakness(course, topic) * 3;
  for (const st of (bank.focus.standing || [])) if (st.course === course && st.topics.includes(topic)) s += 1;
  return s;
}

// ------------------------------------------------------------------ speech: output
const Voice = {
  voices: [], cancelled: false, speaking: false,
  init() { const pick = () => { this.voices = speechSynthesis.getVoices().filter(v => /^en/i.test(v.lang)); fillVoiceSelect(); }; pick(); speechSynthesis.onvoiceschanged = pick; },
  rank(v) { // higher is better: neural / network voices first, then Google, then local defaults
    let r = 0; const n = (v.name || '') + ' ' + (v.voiceURI || '');
    if (/natural|neural|premium|enhanced|wavenet|journey|studio/i.test(n)) r += 40;
    if (/network|-x-[a-z]{3}-network/i.test(n)) r += 30;
    if (/google/i.test(n)) r += 20;
    if (v.localService === false) r += 10;
    if (/en[-_](CA|US)/i.test(v.lang)) r += 6; else if (/en[-_](GB|AU|IE|NZ)/i.test(v.lang)) r += 3;
    if (/compact|espeak|eSpeak|local-lite|-x-[a-z]{3}-local$/i.test(n)) r -= 15;
    return r;
  },
  voice() { return this.voices.find(v => v.voiceURI === settings.voice) || [...this.voices].sort((a, b) => this.rank(b) - this.rank(a))[0]; },
  chunks(text) { // sentence groups of up to ~240 characters: fewer utterance boundaries = fewer robotic gaps
    const sents = String(text).replace(/\s+/g, ' ').match(/[^]+?(?:[.!?]+["”]?(?=\s|$)|$)/g) || [text];
    const out = []; let cur = '';
    for (const se of sents) { if (cur && (cur + se).length > 240) { out.push(cur.trim()); cur = ''; } cur += se.trim() + ' '; }
    if (cur.trim()) out.push(cur.trim());
    return out;
  },
  async say(text, opts = {}) {
    if (!('speechSynthesis' in window)) { await sleep(Math.min(8000, text.length * 40)); return true; }
    this.cancelled = false; this.speaking = true;
    speechSynthesis.cancel();
    const v = this.voice();
    for (const ch of this.chunks(text)) {
      if (this.cancelled) break;
      await new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(ch.trim());
        if (v) u.voice = v; u.rate = settings.rate; u.pitch = 1; u.lang = v ? v.lang : 'en-US';
        let started = false; const t0 = Date.now(); const maxMs = 3000 + ch.length * 120 / settings.rate;
        const fin = () => { clearInterval(guard); resolve(); };
        u.onstart = () => { started = true; }; u.onend = fin; u.onerror = fin;
        speechSynthesis.speak(u);
        // Chrome sometimes never fires onend (cancelled or stalled utterances)
        const guard = setInterval(() => { if (this.cancelled || (started && !speechSynthesis.speaking && !speechSynthesis.pending) || Date.now() - t0 > maxMs) fin(); }, 250);
      });
      if (opts.onChunk) opts.onChunk(ch);
    }
    this.speaking = false;
    return !this.cancelled;
  },
  stop() { this.cancelled = true; try { speechSynthesis.cancel(); } catch (e) { } this.speaking = false; },
};

// ------------------------------------------------------------------ speech: input
const Ear = {
  rec: null, available: !!(window.SpeechRecognition || window.webkitSpeechRecognition), active: null,
  listen(ms = 7000) {
    if (!settings.mic || !this.available) return Promise.resolve(null);
    return new Promise((resolve) => {
      const R = window.SpeechRecognition || window.webkitSpeechRecognition;
      const r = new R(); this.rec = r;
      r.lang = 'en-US'; r.continuous = false; r.interimResults = false; r.maxAlternatives = 5;
      let done = false;
      const finish = (val) => { if (done) return; done = true; clearTimeout(t); try { r.stop(); } catch (e) { } this.rec = null; resolve(val); };
      const t = setTimeout(() => { try { r.abort(); } catch (e) { } finish(null); }, ms);
      r.onresult = (ev) => { const alts = []; for (const res of ev.results) for (let i = 0; i < res.length; i++) alts.push(res[i].transcript); finish(alts); };
      r.onerror = (ev) => { if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') { settings.mic = false; saveSettings(); UI.note('Microphone blocked. Using buttons; allow the microphone in Chrome site settings to use voice.'); } finish(null); };
      r.onend = () => finish(null);
      try { r.start(); } catch (e) { finish(null); }
    });
  },
  stop() { if (this.rec) { try { this.rec.abort(); } catch (e) { } } },
};

// ------------------------------------------------------------------ session machinery
// A waiter that resolves on: spoken alternatives (array), a button/command string, or timeout (null).
const Input = {
  pending: null,
  async get(ms = 7000, listen = true) {
    return new Promise(async (resolve) => {
      let settled = false;
      const done = (v) => { if (settled) return; settled = true; this.pending = null; Ear.stop(); resolve(v); };
      this.pending = done;
      if (listen && settings.mic && Ear.available) { const alts = await Ear.listen(ms); if (!settled) done(alts); }
      else setTimeout(() => done(null), listen ? Math.max(ms, 20000) : ms);
    });
  },
  push(cmd) {
    if (cmd === 'stop') Session.end();
    if (cmd === 'pause') Session.pause();
    if (cmd === 'resume') Session.resume();
    if (this.pending) this.pending({ cmd }); else Session.queueCmd(cmd);
  },
};

const Session = {
  running: false, paused: false, silent: 0, mode: 'tutor', course: 'FOCUS', asked: 0, right: 0, log: [], startedAt: 0, queuedCmd: null, wake: null, pendingResume: null,
  queueCmd(c) { this.queuedCmd = c; if (c === 'repeat' || c === 'skip' || c === 'expand' || typeof c === 'object') Voice.stop(); },
  takeCmd() { const c = this.queuedCmd; this.queuedCmd = null; return c; },
  pause() { if (!this.running || this.paused) return; this.paused = true; Voice.stop(); Ear.stop(); UI.status('Paused', 'paused'); UI.toggleCtl('cPause', true); setTimeout(() => this.pausedEar(), 400); },
  async pausedEar() { // keep one ear open while paused so "resume" and "stop" still work by voice
    while (this.running && this.paused) {
      const alts = await Ear.listen(12000); if (!this.paused) break;
      if (!alts) { await sleep(300); continue; }
      const c = Parse.command(alts[0]);
      if (c === 'resume') this.resume(); else if (c === 'stop') this.end();
    }
  },
  resume() { if (!this.paused) return; this.paused = false; UI.toggleCtl('cPause', false); UI.status('Speaking'); if (this.pendingResume) { const r = this.pendingResume; this.pendingResume = null; r(); } },
  async waitIfPaused() { if (this.paused) await new Promise(r => { this.pendingResume = r; }); },
  async autoPause() { this.silent = 0; await Voice.say('I have not heard you for a while, so I will pause. Say resume, or tap pause, when you are ready.'); this.pause(); await this.waitIfPaused(); },
  async wakeLock() { try { this.wake = await navigator.wakeLock.request('screen'); } catch (e) { } },
  async start(mode, course, opts = {}) {
    this.running = true; this.paused = false; this.silent = 0; this.mode = mode; this.course = course; this.asked = 0; this.right = 0; this.log = []; this.startedAt = Date.now(); this.queuedCmd = null;
    UI.show('session'); $('sessCourse').textContent = course === 'MIX' ? 'Mix' : course === 'FOCUS' ? 'Focus' : courseName(course);
    $('sessCourse').style.borderColor = COURSE_VAR[course] || 'var(--line)';
    this.wakeLock(); Media.start();
    try {
      if (mode === 'tutor') await Tutor.run(course);
      else await Lecture.run(course, opts);
    } catch (e) { if (e && e.message !== 'ended') console.error(e); }
    this.finish();
  },
  end() { if (!this.running) return; this.running = false; Voice.stop(); Ear.stop(); if (this.pendingResume) { this.paused = false; const r = this.pendingResume; this.pendingResume = null; r(); } },
  check() { if (!this.running) throw new Error('ended'); },
  finish() {
    if (this.wake) { try { this.wake.release(); } catch (e) { } this.wake = null; }
    Media.stop(); Voice.stop(); Ear.stop();
    const minutes = Math.round((Date.now() - this.startedAt) / 60000);
    progress.sessions.push({ t: Date.now(), mode: this.mode, course: this.course, asked: this.asked, right: this.right, minutes });
    progress.sessions = progress.sessions.slice(-200);
    saveProgress();
    UI.summary(this); Sync.pushSoon();
  },
};

// Media Session: lets headset / steering-wheel buttons drive the app. play-pause = pause/resume, next = next, previous = repeat.
const Media = {
  el: null,
  start() {
    this.el = $('silence');
    if (!this.el.src) this.el.src = silentWav();
    this.el.play().catch(() => { });
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: 'Pandora Practice Pal', artist: 'Lecture and tutor', album: 'Pandora vault' });
      const map = { play: 'resume', pause: 'pause', nexttrack: 'skip', previoustrack: 'repeat', seekforward: 'skip', seekbackward: 'repeat' };
      for (const k in map) { try { navigator.mediaSession.setActionHandler(k, () => { Session.paused && map[k] !== 'resume' ? Session.resume() : null; Input.push(map[k]); }); } catch (e) { } }
    }
  },
  stop() { try { this.el && this.el.pause(); } catch (e) { } },
};
function silentWav() { // 1 s of silence, 8 kHz mono
  const n = 8000, buf = new ArrayBuffer(44 + n), v = new DataView(buf); const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

// Speak with live highlighting; returns false if interrupted by a command.
async function speak(text, kicker) {
  Session.check(); await Session.waitIfPaused(); Session.check();
  UI.status('Speaking'); UI.stage(text, kicker);
  const ok = await Voice.say(text, { onChunk: (ch) => UI.highlight(ch) });
  Session.check();
  return ok;
}
// Listen for an utterance or a command; returns {cmd} | {alts:[...]} | null.
async function hear(ms = 7000) {
  Session.check(); await Session.waitIfPaused(); Session.check();
  const q = Session.takeCmd(); if (q) return { cmd: q };
  UI.status('Listening', 'listen');
  const v = await Input.get(ms, true);
  UI.status('Speaking');
  if (!v) { Session.silent++; if (Session.silent >= 3) await Session.autoPause(); return null; }
  Session.silent = 0;
  if (v.cmd) return v;
  const c = Parse.command(v[0]);
  if (c === 'stop') { Session.end(); Session.check(); }
  if (c === 'pause') Session.pause();
  if (c) return { cmd: c };
  return { alts: v };
}
// Speak, then take a short command window (used between lecture segments).
async function speakThenWindow(text, kicker, ms = 2500) {
  const ok = await speak(text, kicker);
  if (!ok) { const c = Session.takeCmd(); return c ? { cmd: c } : { cmd: 'repeat' }; }
  const q = Session.takeCmd(); if (q) return { cmd: q };
  const v = await Input.get(ms, true);
  if (!v) return null;
  if (v.cmd) return v;
  const c = Parse.command(v[0]);
  if (c === 'stop') { Session.end(); Session.check(); }
  if (c === 'pause') Session.pause();
  return c ? { cmd: c } : null;
}

// ------------------------------------------------------------------ TUTOR
const Tutor = {
  pool(course) {
    const cs = course === 'MIX' || course === 'FOCUS' ? COURSE_ORDER : [course];
    return bank.lessons.filter(l => cs.includes(l.course) && unlocked(l));
  },
  dueItems(course) {
    const cs = course === 'MIX' || course === 'FOCUS' ? COURSE_ORDER : [course]; const now = Date.now();
    return Object.entries(progress.items).filter(([id, p]) => byId[id] && cs.includes(byId[id].course) && p.due && p.due <= now).sort((a, b) => a[1].due - b[1].due).map(([id]) => id);
  },
  nextLesson(course, done) {
    const cands = this.pool(course).filter(l => !progress.lessons[l.id] && !done.has(l.id));
    if (!cands.length) return null;
    if (course === 'FOCUS') cands.sort((a, b) => (focusScore(b.course, b.topic) - focusScore(a.course, a.topic)) || a.unlock.localeCompare(b.unlock));
    else cands.sort((a, b) => a.unlock.localeCompare(b.unlock));
    if (course === 'MIX' || course === 'FOCUS') {
      // weighted course balance: pick the course most behind its share this session
      const asked = {}; for (const e of Session.log) asked[e.course] = (asked[e.course] || 0) + 1;
      const total = Session.log.length || 1;
      const avail = [...new Set(cands.map(l => l.course))];
      avail.sort((a, b) => ((asked[a] || 0) / total - bank.courses[a].weight) - ((asked[b] || 0) / total - bank.courses[b].weight));
      const c = avail[0]; const first = cands.find(l => l.course === c); if (first) return first;
    }
    return cands[0];
  },
  async run(course) {
    const done = new Set(); const retry = []; let reviewBudget = 4;
    await speak(course === 'FOCUS' ? 'Focused tutoring. I will start with what is due for review and your weakest topics.' : 'Tutor mode. Say repeat, hint, or I do not know at any time. Say explain to talk a point through.');
    while (Session.running) {
      // 1. retries from this session
      if (retry.length && retry[0].after <= Session.asked) { const r = retry.shift(); await this.ask(byId[r.id], true); continue; }
      // 2. due spaced review
      const due = this.dueItems(course).filter(id => !done.has(id));
      if (due.length && reviewBudget > 0) { reviewBudget--; done.add(due[0]); const res = await this.ask(byId[due[0]]); if (res === 'wrong') retry.push({ id: due[0], after: Session.asked + 4 }); continue; }
      // 3. a new lesson
      const lesson = this.nextLesson(course, done);
      if (!lesson) {
        if (retry.length) { const r = retry.shift(); await this.ask(byId[r.id], true); continue; }
        await speak('You have covered every lesson available right now. New material arrives after each class. Let us review instead.');
        const all = this.pool(course).flatMap(l => l.items).filter(id => !done.has(id)); if (!all.length) break;
        const pick = all.sort((a, b) => ((progress.items[a] || {}).streak || 0) - ((progress.items[b] || {}).streak || 0))[0];
        done.add(pick); const res = await this.ask(byId[pick]); if (res === 'wrong') retry.push({ id: pick, after: Session.asked + 4 });
        continue;
      }
      done.add(lesson.id);
      const r = await speakThenWindow(lesson.teach, courseName(lesson.course) + ' · ' + lesson.title, 1500);
      if (r && r.cmd) { const again = await this.handleLessonCmd(r.cmd, lesson); if (again === 'repeat') { await speak(lesson.teach, courseName(lesson.course) + ' · ' + lesson.title); } }
      let wrongs = 0;
      for (const id of lesson.items) { if (!byId[id] || !unlocked(byId[id])) continue; done.add(id); const res = await this.ask(byId[id]); if (res === 'wrong') { wrongs++; retry.push({ id, after: Session.asked + 4 }); } }
      progress.lessons[lesson.id] = { done: Date.now(), wrongs }; saveProgress();
      reviewBudget = Math.min(reviewBudget + 2, 4);
    }
  },
  async handleLessonCmd(cmd, lesson) {
    if (cmd === 'expand') { await Expand.converse({ course: lesson.course, title: lesson.title, text: lesson.teach, expand: 'Give a second example and the reason behind the idea.' }); return null; }
    if (cmd === 'repeat') return 'repeat';
    return null;
  },
  readOptions(item) { return item.options.map((o, i) => 'Option ' + ['one', 'two', 'three', 'four'][i] + ': ' + o + '.').join(' '); },
  answerText(item) {
    if (item.type === 'choice') return 'The answer is option ' + ['one', 'two', 'three', 'four'][item.answer] + ', ' + item.options[item.answer] + '.';
    if (item.type === 'tf') return 'That statement is ' + (item.answer ? 'true.' : 'false.');
    if (item.type === 'number') return 'The answer is ' + item.answer.value + (item.answer.unit ? ' ' + item.answer.unit : '') + '.';
    return 'The answer is ' + item.answer[0] + '.';
  },
  evaluate(item, alts) {
    for (const a of alts) {
      if (item.type === 'choice') { const i = Parse.choice(a, item.options); if (i != null) return { idx: i, ok: i === item.answer, said: a }; }
      else if (item.type === 'tf') { const v = Parse.tf(a); if (v != null) return { ok: v === item.answer, said: a }; }
      else if (item.type === 'number') { const v = Parse.matchNumber(a, item.answer); if (v != null) return { ok: v, said: a, value: Parse.numberValue(a, item.answer) }; }
      else if (item.type === 'word') { if (Parse.word(a, item.answer)) return { ok: true, said: a }; }
    }
    if (item.type === 'word' && alts.length) return { ok: false, said: alts[0] };
    return null;
  },
  wrongText(item, ev) {
    if (item.type === 'choice' && ev && ev.idx != null && item.wrong[ev.idx]) return item.wrong[ev.idx];
    if (item.type === 'number' && ev && ev.value != null && item.slips) { for (const s of item.slips) if (Math.abs(ev.value - s.value) <= Math.abs(s.value) * 0.03 + 1e-9) return s.why; }
    return typeof item.wrong === 'string' ? item.wrong : item.wrong.filter(Boolean)[0] || item.concept;
  },
  shuffled(item) { // returns a copy with options in random order and answer/wrong remapped
    if (item.type !== 'choice') return item;
    const idx = item.options.map((_, i) => i); for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    return { ...item, options: idx.map(i => item.options[i]), wrong: idx.map(i => item.wrong[i]), answer: idx.indexOf(item.answer), _orig: item };
  },
  async ask(item0, isRetry = false) {
    Session.check();
    const item = this.shuffled(item0);
    const kicker = courseName(item.course) + ' · ' + item.topic + (isRetry ? ' · again' : '');
    let qtext = item.q + (item.type === 'choice' && settings.optionsAloud ? ' ' + this.readOptions(item) : '') + (item.type === 'tf' ? ' True or false?' : '');
    UI.options(item);
    let hinted = false, misses = 0, nulls = 0;
    await speak(qtext, kicker);
    while (true) {
      Session.check();
      const r = await hear(item.type === 'choice' ? 9000 : 8000);
      if (!r) { nulls++; if (nulls === 1) { await speak(item.type === 'choice' ? 'Say the option number, or say hint.' : 'Say your answer, or say hint.', kicker); continue; } return await this.reveal(item, null, kicker, isRetry); }
      if (r.cmd) {
        const c = r.cmd;
        if (c === 'repeat') { await speak(qtext, kicker); continue; }
        if (c === 'hint') { hinted = true; await speak(item.hint, kicker); continue; }
        if (c === 'dontknow') { if (!hinted) { hinted = true; await speak('Here is a hint. ' + item.hint, kicker); continue; } return await this.reveal(item, null, kicker, isRetry); }
        if (c === 'skip') { UI.options(null); return 'skip'; }
        if (c === 'expand') { await Expand.converse({ course: item.course, title: item.topic, text: item.concept + ' ' + item.hint, expand: 'Explain the underlying concept without giving away the answer to the current question.' }); await speak(qtext, kicker); continue; }
        if (c === 'status') { await speak(`${Session.right} right out of ${Session.asked} so far.`, kicker); continue; }
        if (c === 'resume' || c === 'pause') continue;
        if (typeof c === 'object' && c.answer != null) { return await this.grade(item, { idx: c.answer, ok: c.answer === item.answer, said: 'tap' }, kicker, isRetry); }
        if (typeof c === 'object' && c.tf != null) { return await this.grade(item, { ok: c.tf === item.answer, said: 'tap' }, kicker, isRetry); }
        if (typeof c === 'object' && c.reveal) { return await this.reveal(item, null, kicker, isRetry); }
        continue;
      }
      UI.heard(r.alts[0]);
      const ev = this.evaluate(item, r.alts);
      if (!ev) {
        misses++;
        if (misses >= 2) { await speak('I could not match that to an answer.', kicker); return await this.reveal(item, null, kicker, isRetry); }
        await speak('I heard: ' + r.alts[0] + '. ' + (item.type === 'choice' ? 'Say option one, two or three.' : item.type === 'tf' ? 'Say true or false.' : item.type === 'number' ? 'Say the number and its unit.' : 'Try a shorter answer, or say I do not know.'), kicker);
        continue;
      }
      return await this.grade(item, ev, kicker, isRetry);
    }
  },
  async grade(item, ev, kicker, isRetry) {
    UI.mark(item, ev);
    if (ev.ok) {
      this.record(item, true, isRetry);
      await speak(pickOne(['Correct.', 'Yes.', 'Right.', 'Good.']) + ' ' + item.right, kicker);
      UI.options(null); return 'right';
    }
    this.record(item, false, isRetry);
    await speak('Not quite. ' + this.wrongText(item, ev) + ' ' + this.answerText(item) + ' Remember: ' + item.concept, kicker);
    return await this.afterWrong(item, kicker);
  },
  async reveal(item, ev, kicker, isRetry) {
    UI.mark(item, { idx: item.answer, ok: true });
    this.record(item, false, isRetry);
    await speak(this.answerText(item) + ' ' + item.right + ' ' + item.concept, kicker);
    return await this.afterWrong(item, kicker);
  },
  async afterWrong(item, kicker) {
    // offer a deeper explanation without stalling: short window for "explain"
    const r = await speakThenWindow('Say explain to go deeper, or we move on.', kicker, 2500);
    if (r && r.cmd === 'expand') await Expand.converse({ course: item.course, title: item.topic, text: 'Question: ' + item.q + ' Correct answer: ' + this.answerText(item) + ' Why: ' + item.right + ' Concept: ' + item.concept, expand: 'The student answered this wrongly. Rebuild the concept from the ground up with a fresh example.' });
    UI.options(null); return 'wrong';
  },
  record(item, ok, isRetry) {
    item = item._orig || item;
    const p = progress.items[item.id] || { n: 0, ok: 0, bad: 0, streak: 0, due: 0 };
    if (!isRetry) { p.n++; ok ? p.ok++ : p.bad++; Session.asked++; if (ok) Session.right++; Session.log.push({ id: item.id, course: item.course, topic: item.topic, ok }); }
    p.streak = ok ? p.streak + 1 : 0; p.last = Date.now();
    const days = ok ? [1, 3, 7, 14, 30, 60][Math.min(p.streak, 5)] : 1;
    p.due = Date.now() + days * DAY;
    progress.items[item.id] = p;
    if (!isRetry) { const k = topicKey(item.course, item.topic); const t = progress.topics[k] || { n: 0, bad: 0 }; t.n++; if (!ok) t.bad++; t.last = Date.now(); progress.topics[k] = t; }
    saveProgress(); UI.count();
  },
};
function pickOne(a) { return a[Math.floor(Math.random() * a.length)]; }

// ------------------------------------------------------------------ LECTURE
const Lecture = {
  lecturesFor(course) { const cs = course === 'MIX' || course === 'FOCUS' ? COURSE_ORDER : [course]; return bank.lectures.filter(L => cs.includes(L.course)); },
  pos(key) { return (progress.lectures[key] || {}).seg || 0; },
  // Build the playlist of segments for this session
  playlist(course, opts) {
    const budget = (opts.len || settings.len) * 150; // words
    let segs = [];
    if (opts.pick === 'lecture' && opts.id) { const L = lectureById[opts.id]; segs = L.segments.map(s => ({ ...s, L, key: L.id })); }
    else if (opts.pick === 'topic' && opts.topic) {
      const [c, t] = opts.topic.split('|');
      for (const L of this.lecturesFor(c).filter(unlocked).sort((a, b) => a.unlock.localeCompare(b.unlock))) for (const s of L.segments) if (s.topic === t) segs.push({ ...s, L, key: 'topic:' + opts.topic });
    } else {
      // next up: continue the last unfinished lecture, else the newest unlocked lecture not yet finished (focus: weakest topics first)
      let Ls = this.lecturesFor(course).filter(unlocked);
      const unfinished = Ls.filter(L => !(progress.lectures[L.id] || {}).done);
      if (course === 'FOCUS') unfinished.sort((a, b) => (Math.max(...b.segments.map(s => focusScore(b.course, s.topic))) - Math.max(...a.segments.map(s => focusScore(a.course, s.topic)))) || b.unlock.localeCompare(a.unlock));
      else unfinished.sort((a, b) => ((this.pos(b.id) > 0) - (this.pos(a.id) > 0)) || a.unlock.localeCompare(b.unlock));
      Ls = unfinished.length ? unfinished : Ls;
      for (const L of Ls) for (const s of L.segments) segs.push({ ...s, L, key: L.id });
    }
    // resume position
    const key = segs.length ? segs[0].key : null;
    const start = key ? this.pos(key) : 0;
    let words = 0, out = [];
    for (let i = start; i < segs.length; i++) { out.push({ ...segs[i], index: i, total: segs.length }); words += segs[i].text.split(' ').length; if (words >= budget) break; }
    if (!out.length) out = segs.slice(0, 1).map((s, i) => ({ ...s, index: 0, total: segs.length }));
    return out;
  },
  async run(course, opts) {
    const list = this.playlist(course, opts);
    if (!list.length) { await speak('There is no lecture available for that choice yet.'); return; }
    const first = list[0];
    await speak((first.index === 0 ? 'Lecture: ' : 'Continuing: ') + first.L.title + '. ' + courseName(first.L.course) + '. Tap explain during any point to talk it through, or say explain at a quick check.');
    let sinceCheck = 0;
    for (let k = 0; k < list.length; k++) {
      const s = list[k]; Session.check();
      $('sessCount').textContent = (s.index + 1) + ' / ' + s.total;
      const kicker = courseName(s.L.course) + ' · ' + s.L.title + ' · ' + s.title;
      // speak the point; a button or headset press during it is picked up right after
      let ok = await speak(s.text, kicker);
      let cmd = ok ? Session.takeCmd() : (Session.takeCmd() || 'repeat');
      while (cmd) {
        if (cmd === 'repeat') { ok = await speak(s.text, kicker); cmd = ok ? Session.takeCmd() : (Session.takeCmd() || 'repeat'); continue; }
        if (cmd === 'expand') { await Expand.converse({ course: s.L.course, title: s.L.title + ' — ' + s.title, text: s.text, expand: s.expand }); await speak('Back to the lecture.', kicker); }
        cmd = null;
      }
      sinceCheck++;
      const isLast = s.index + 1 >= s.total;
      // quick check on what was just said: after every second point, and always at the end of a lecture
      if (s.check && (sinceCheck >= 2 || isLast)) { sinceCheck = 0; await this.quickCheck(s, kicker); }
      progress.lectures[s.key] = { seg: s.index + 1, done: isLast, last: Date.now() }; saveProgress();
      if (isLast) { await speak('That is the end of ' + s.L.title + '.', kicker); progress.lectures[s.key] = { seg: 0, done: true, last: Date.now() }; saveProgress(); }
    }
    await speak('That is your ' + (opts.len || settings.len) + ' minutes. Start tutor mode any time for more questions on this.');
  },
  // One spoken question about the point just made. Wrong: re-explain and move on. Right: move on.
  async quickCheck(s, kicker) {
    const c = s.check; const words = ['one', 'two', 'three'];
    let options = c.options || [], answer = c.answer;
    if (c.type === 'choice') { const idx = options.map((_, i) => i); for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; } options = idx.map(i => c.options[i]); answer = idx.indexOf(c.answer); }
    const fake = { id: 'check:' + s.id, course: s.L.course, topic: s.topic, type: c.type, q: c.q, options, answer, right: '', wrong: c.type === 'choice' ? options.map(() => '') : '', concept: '', hint: '' };
    const qtext = 'Quick check. ' + c.q + (c.type === 'choice' ? ' ' + options.map((o, i) => 'Option ' + words[i] + ': ' + o + '.').join(' ') : ' True or false?');
    UI.options(fake);
    await speak(qtext, kicker);
    let tries = 0;
    while (true) {
      Session.check();
      const r = await hear(9000);
      if (!r) { tries++; if (tries >= 2) { await this.checkWrong(s, fake, kicker, true); return; } await speak(c.type === 'choice' ? 'Say the option number.' : 'Say true or false.', kicker); continue; }
      if (r.cmd) {
        const k = r.cmd;
        if (k === 'repeat') { await speak(qtext, kicker); continue; }
        if (k === 'expand') { await Expand.converse({ course: s.L.course, title: s.L.title + ' — ' + s.title, text: s.text, expand: s.expand }); await speak(qtext, kicker); continue; }
        if (k === 'dontknow' || k === 'hint') { await this.checkWrong(s, fake, kicker, true); return; }
        if (k === 'skip') { UI.options(null); return; }
        if (typeof k === 'object' && k.answer != null) { return await this.checkGrade(s, fake, k.answer === answer, { idx: k.answer }, kicker); }
        if (typeof k === 'object' && k.tf != null) { return await this.checkGrade(s, fake, k.tf === answer, {}, kicker); }
        if (typeof k === 'object' && k.reveal) { await this.checkWrong(s, fake, kicker, true); return; }
        continue;
      }
      UI.heard(r.alts[0]);
      const ev = Tutor.evaluate(fake, r.alts);
      if (!ev) { tries++; if (tries >= 2) { await this.checkWrong(s, fake, kicker, true); return; } await speak('I heard ' + r.alts[0] + '. ' + (c.type === 'choice' ? 'Say option one, two or three.' : 'Say true or false.'), kicker); continue; }
      return await this.checkGrade(s, fake, ev.ok, ev, kicker);
    }
  },
  async checkGrade(s, fake, ok, ev, kicker) {
    UI.mark(fake, ev);
    const k = topicKey(s.L.course, s.topic); const t = progress.topics[k] || { n: 0, bad: 0 }; t.n++; if (!ok) t.bad++; t.last = Date.now(); progress.topics[k] = t;
    Session.asked++; if (ok) Session.right++; Session.log.push({ id: 'check:' + s.id, course: s.L.course, topic: s.topic, ok, q: s.check.q }); saveProgress(); UI.count();
    if (ok) { await speak(pickOne(['Right.', 'Correct.', 'Yes, that is it.', 'Good.']), kicker); UI.options(null); return; }
    await this.checkWrong(s, fake, kicker, false);
  },
  async checkWrong(s, fake, kicker, reveal) {
    const c = s.check;
    UI.mark(fake, { idx: fake.answer, ok: true });
    const ans = c.type === 'choice' ? 'The answer is ' + fake.options[fake.answer] + '.' : 'That statement is ' + (c.answer ? 'true.' : 'false.');
    await speak((reveal ? '' : 'Not quite. ') + ans + ' Let me go over that again. ' + c.again, kicker);
    UI.options(null);
  },
};

// ------------------------------------------------------------------ EXPLAIN (AI conversation)
const Expand = {
  async converse(ctx) {
    const kicker = courseName(ctx.course) + ' · explain';
    if (!settings.apiKey || settings.provider === 'none') {
      await speak('A little more on that. ' + (ctx.expand || ctx.text) + ' For a real back-and-forth, add a free AI key in settings.', kicker);
      return;
    }
    const sys = `You are a spoken tutor for a first-term Electronics Engineering Technology student. Course: ${courseName(ctx.course)} (${bank.courses[ctx.course].long}). The student is DRIVING and hears you through text-to-speech, so: plain spoken English only, no symbols, no lists, no markdown, no equations in notation. Say formulas in words and name each quantity and its unit before using numbers. Keep each reply under 120 words unless asked for more. Stay within the level of the material given; if a question goes beyond it, say so briefly and answer at an introductory level. Never invent course rules or dates.
Lecture point just heard: "${ctx.title}": ${ctx.text}
Note for going deeper: ${ctx.expand || ''}`;
    const turns = [];
    await speak('What would you like to know about that?', kicker);
    let silence = 0;
    while (Session.running) {
      const r = await hear(9000);
      if (!r) { silence++; if (silence >= 2) break; await speak('Ask a question, or say resume.', kicker); continue; }
      if (r.cmd) { if (r.cmd === 'resume' || r.cmd === 'skip' || r.cmd === 'stop') break; if (r.cmd === 'repeat' && turns.length) { await speak(turns[turns.length - 1].content, kicker); } continue; }
      const q = r.alts[0]; UI.heard(q);
      if (/^(no|nothing|that'?s all|i'?m good|resume|continue|go on|carry on)\b/i.test(q.trim())) break;
      turns.push({ role: 'user', content: q });
      UI.status('Thinking'); UI.stage('…', kicker);
      let reply;
      try { reply = await this.ask(sys, turns); } catch (e) { reply = 'The AI did not answer. ' + this.explain(e) + ' Let us carry on.'; turns.pop(); await speak(reply, kicker); break; }
      turns.push({ role: 'assistant', content: reply });
      await speak(reply, kicker);
      await speak('Anything else, or resume?', kicker);
    }
  },
  // With no model set, ask the provider which models exist and pick a current, fast, free-tier one.
  async pickModel(P) {
    if (settings.model) return settings.model;
    if (settings.modelAuto && settings.modelAutoFor === settings.provider) return settings.modelAuto;
    const list = await this.candidates(P); if (list.length) { settings.modelAuto = list[0]; settings.modelAutoFor = settings.provider; saveSettings(); return list[0]; }
    return P.model;
  },
  // ordered list of usable model ids from the provider's /models endpoint
  async candidates(P) {
    if (this._cands && this._candsFor === settings.provider) return this._cands;
    const base = settings.provider === 'custom' ? settings.baseUrl.replace(/\/+$/, '') : P.url.replace(/\/chat\/completions$/, '');
    try {
      const r = await fetch(base + '/models', { headers: { Authorization: 'Bearer ' + settings.apiKey } });
      if (r.ok) {
        const j = await r.json(); const ids = (j.data || []).map(m => String(m.id).replace(/^models\//, ''));
        const good = ids.filter(id => !/embed|image|tts|audio|live|vision-only|whisper|guard|moderation|realtime|preview-\d|exp\b|thinking/i.test(id));
        let pref;
        if (settings.provider === 'gemini') { const flash = good.filter(id => /^gemini-\d/.test(id) && /flash/i.test(id) && !/-\d{3,}$/.test(id)); const ver = id => parseFloat((id.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]); const main = flash.filter(id => !/lite|8b/i.test(id)).sort((a, b) => ver(b) - ver(a) || a.length - b.length); const lite = flash.filter(id => /lite|8b/i.test(id)).sort((a, b) => ver(b) - ver(a) || a.length - b.length); pref = [...main, ...lite]; }
        else if (settings.provider === 'groq') pref = good.filter(id => /llama.*versatile|llama-3\.\d-70b|llama-3\.\d-8b/i.test(id)).sort().reverse();
        else if (settings.provider === 'openrouter') pref = good.filter(id => /:free$/.test(id) && /gemma|llama|qwen|mistral/i.test(id));
        else pref = good.filter(id => /mini|flash|small/i.test(id)).sort().reverse();
        this._cands = [...new Set([...pref, ...good])].slice(0, 8); this._candsFor = settings.provider; return this._cands;
      }
    } catch (e) { /* fall through to the default */ }
    this._cands = P.model ? [P.model] : []; this._candsFor = settings.provider; return this._cands;
  },
  explain(e) {
    const m = String(e && e.message || e);
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Could not reach the AI service from this phone (no data, or the request was blocked).';
    if (/401|403|API_KEY_INVALID|invalid.*key/i.test(m)) return 'The AI service rejected the key. Check it was pasted completely and belongs to the chosen provider.';
    if (/404|not found|does not exist/i.test(m)) return 'The AI service says that model does not exist (' + m.slice(0, 140) + '). Clear the Model box so the app picks one automatically, or type a current model id.';
    if (/limit: 0|limit":0|limit: "0"/i.test(m)) return 'This key has no free quota for that model (Google reports a limit of 0). ' + m.slice(0, 200);
    if (/429|quota|rate/i.test(m)) return 'Rate limit or quota hit; wait a minute and try again. ' + m.slice(0, 220);
    if (/503|UNAVAILABLE|high demand|overloaded/i.test(m)) return 'The AI service is overloaded right now on every model it tried; try again in a minute. ' + m.slice(0, 160);
    return m;
  },
  async ask(system, messages) {
    const P = PROVIDERS[settings.provider] || PROVIDERS.gemini; const model = settings.provider === 'anthropic' ? (settings.model || P.model) : await this.pickModel(P);
    if (settings.provider !== 'anthropic') {
      // try the chosen model, then the next candidates when a model is missing (404) or has no free quota (429)
      const tried = [model]; let lastErr = null;
      const cands = settings.model ? [] : (await this.candidates(P)).filter(m => m !== model);
      for (const m of [model, ...cands.slice(0, 4)]) {
        try { const r = await this._chat(P, m, system, messages); if (m !== model) { settings.modelAuto = m; saveSettings(); } return r; }
        catch (e) { lastErr = e; if (!/API (404|429|500|502|503|529)/.test(String(e.message))) throw e; tried.push(m); }
      }
      throw new Error(String(lastErr && lastErr.message) + ' [tried: ' + [...new Set(tried)].join(', ') + ']');
    }
    let res, text;
    res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify({ model, max_tokens: 400, system, messages }) });
    if (!res.ok) throw new Error('API ' + res.status + ' ' + (await res.text()).slice(0, 160));
    const j = await res.json(); text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join(' ');
    return this.clean(text);
  },
  clean(text) { return String(text).replace(/[*_#`>|]/g, '').replace(/\s+/g, ' ').trim() || 'No answer came back.'; },
  // OpenAI-compatible chat; on a 404 (model gone) with an auto-picked model, forget the pick and retry once with a fresh list
  async _chat(P, model, system, messages) {
    const url = settings.provider === 'custom' ? settings.baseUrl.replace(/\/+$/, '') + '/chat/completions' : P.url;
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + settings.apiKey, ...(settings.provider === 'openrouter' ? { 'HTTP-Referer': location.origin, 'X-Title': 'Pandora Practice Pal' } : {}) },
      body: JSON.stringify({ model, max_tokens: 400, messages: [{ role: 'system', content: system }, ...messages] }) });
    if (!res.ok) throw new Error('API ' + res.status + ' ' + (await res.text()).slice(0, 200));
    const j = await res.json();
    return this.clean((((j.choices || [])[0] || {}).message || {}).content || '');
  },
};
const PROVIDERS = {
  gemini: { name: 'Google Gemini (free tier)', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-2.5-flash', keys: 'https://aistudio.google.com/apikey' },
  groq: { name: 'Groq (free tier)', url: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile', keys: 'https://console.groq.com/keys' },
  openrouter: { name: 'OpenRouter (free models)', url: 'https://openrouter.ai/api/v1/chat/completions', model: 'google/gemma-3-27b-it:free', keys: 'https://openrouter.ai/keys' },
  openai: { name: 'OpenAI', url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', keys: 'https://platform.openai.com/api-keys' },
  anthropic: { name: 'Anthropic', url: '', model: 'claude-haiku-4-5', keys: 'https://console.anthropic.com/' },
  custom: { name: 'Custom (OpenAI-compatible)', url: '', model: '', keys: '' },
  none: { name: 'Off (read the prepared note)', url: '', model: '', keys: '' },
};

// ------------------------------------------------------------------ SYNC (GitHub contents API)
const Sync = {
  timer: null,
  pushSoon() { if (!settings.ghToken || !settings.ghRepo) return; clearTimeout(this.timer); this.timer = setTimeout(() => this.push().catch(e => console.warn(e)), 4000); },
  headers() { return { Authorization: 'Bearer ' + settings.ghToken, Accept: 'application/vnd.github+json' }; },
  explain(e) {
    const m = String(e && e.message || e);
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Could not reach api.github.com from this phone (blocked request or no data). Progress is still saved on the phone.';
    if (/401/.test(m)) return 'GitHub rejected the token (401). Check it was pasted completely.';
    if (/403|404/.test(m)) return 'GitHub refused (' + (m.match(/40[34]/) || [''])[0] + '). The token must be a fine-grained token with this repository selected and Contents: Read and write.';
    if (/409|422/.test(m)) return 'GitHub reported a conflict; try Sync now again.';
    return m;
  },
  url() { return 'https://api.github.com/repos/' + settings.ghRepo + '/contents/progress.json'; },
  async pull() {
    if (!settings.ghToken || !settings.ghRepo) return null;
    const r = await fetch(this.url(), { headers: this.headers(), cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('GitHub ' + r.status + ' on read');
    const j = await r.json();
    const remote = JSON.parse(decodeURIComponent(escape(atob(j.content.replace(/\n/g, '')))));
    this.merge(remote); return j.sha;
  },
  merge(remote) {
    if (!remote || !remote.items) return;
    for (const [id, rp] of Object.entries(remote.items)) { const lp = progress.items[id]; if (!lp || (rp.last || 0) > (lp.last || 0)) progress.items[id] = rp; }
    for (const [id, rp] of Object.entries(remote.lessons || {})) if (!progress.lessons[id]) progress.lessons[id] = rp;
    for (const [id, rp] of Object.entries(remote.lectures || {})) { const lp = progress.lectures[id]; if (!lp || (rp.last || 0) > (lp.last || 0)) progress.lectures[id] = rp; }
    for (const [k, rt] of Object.entries(remote.topics || {})) { const lt = progress.topics[k]; if (!lt || (rt.last || 0) > (lt.last || 0)) progress.topics[k] = rt; }
    const seen = new Set(progress.sessions.map(s => s.t)); for (const s of (remote.sessions || [])) if (!seen.has(s.t)) progress.sessions.push(s);
    progress.sessions.sort((a, b) => a.t - b.t); progress.sessions = progress.sessions.slice(-200);
    saveProgress();
  },
  async push() {
    if (!settings.ghToken || !settings.ghRepo) return 'No GitHub token set.';
    let sha = null; try { sha = await this.pull(); } catch (e) { if (!/404/.test(String(e.message))) throw e; }
    const body = { message: 'progress from Pandora Practice Pal ' + new Date().toISOString(), content: btoa(unescape(encodeURIComponent(JSON.stringify(progress)))) };
    if (sha) body.sha = sha;
    const r = await fetch(this.url(), { method: 'PUT', headers: { ...this.headers(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('GitHub ' + r.status + ' on write: ' + (await r.text()).slice(0, 100));
    return 'Synced ' + new Date().toLocaleTimeString();
  },
};

// ------------------------------------------------------------------ UI
const UI = {
  show(id) { for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id; window.scrollTo(0, 0); },
  status(text, cls) { const el = $('sessStatus'); el.textContent = text; el.className = 'status' + (cls ? ' ' + cls : ''); },
  toggleCtl(id, on) { $(id).classList.toggle('on', !!on); },
  stage(text, kicker) { $('stageKicker').textContent = kicker || ''; $('spoken').textContent = text; $('heard').textContent = ''; this._full = text; },
  highlight(chunk) { const full = this._full || ''; const i = full.indexOf(chunk.trim()); if (i < 0) return; const el = $('spoken'); el.textContent = ''; el.append(full.slice(0, i)); const b = document.createElement('span'); b.className = 'now'; b.textContent = chunk.trim(); el.append(b, full.slice(i + chunk.trim().length)); try { b.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { } },
  heard(t) { $('heard').textContent = t ? 'Heard: “' + t + '”' : ''; },
  count() { $('sessCount').textContent = Session.right + ' / ' + Session.asked; },
  note(t) { $('heard').textContent = t; },
  options(item) {
    const box = $('optionBtns'); box.innerHTML = ''; if (!item) return;
    const add = (label, cmd, cls = '') => { const b = document.createElement('button'); b.className = 'opt ' + cls; b.innerHTML = label; b.onclick = () => Input.push(cmd); box.append(b); return b; };
    if (item.type === 'choice') item.options.forEach((o, i) => add('<em>' + (i + 1) + '</em>' + esc(o), { answer: i }));
    else if (item.type === 'tf') { add('True', { tf: true }, 'wide'); add('False', { tf: false }, 'wide'); }
    else { add('Hint', 'hint', 'wide'); add('Show me the answer', { reveal: true }, 'wide'); }
  },
  mark(item, ev) { const bs = $('optionBtns').querySelectorAll('.opt'); if (item.type === 'choice') { bs.forEach((b, i) => { if (i === item.answer) b.classList.add('good'); else if (ev && ev.idx === i) b.classList.add('bad'); }); } },
  summary(S) {
    const wrong = S.log.filter(e => !e.ok); const byTopic = {};
    for (const e of wrong) byTopic[topicKey(e.course, e.topic)] = (byTopic[topicKey(e.course, e.topic)] || 0) + 1;
    const weakest = Object.entries(byTopic).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const mins = Math.max(1, Math.round((Date.now() - S.startedAt) / 60000));
    let html = `<div class="stats"><div class="stat"><b>${mins}</b><small>minutes</small></div><div class="stat"><b>${S.asked}</b><small>asked</small></div><div class="stat"><b>${S.asked ? Math.round(100 * S.right / S.asked) : 0}%</b><small>right</small></div></div>`;
    if (weakest.length) html += '<h2 class="label" style="margin-top:16px">Review in Obsidian</h2><div class="weak">' + weakest.map(([k, n]) => { const [c, t] = k.split('|'); const page = bank.courses[c].topicPages[t]; return `<a href="obsidian://open?vault=Pandora&file=${encodeURIComponent(page)}"><span>${esc(courseName(c))} · ${esc(t)}</span><small>${n} missed →</small></a>`; }).join('') + '</div>';
    if (S.log.length) html += '<ul class="summary-list">' + S.log.map(e => `<li class="${e.ok ? 'good' : 'bad'}">${esc(e.q || (byId[e.id] || {}).q || '')}<small>${esc(courseName(e.course))} · ${esc(e.topic)}</small></li>`).join('') + '</ul>';
    $('summaryBody').innerHTML = html; this.show('summary');
    if (S.asked) Voice.say(`Session done. ${S.right} right out of ${S.asked}.` + (weakest.length ? ' Weakest today: ' + weakest.map(([k]) => k.split('|')[1]).join(', ') + '.' : ''));
  },
};
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ------------------------------------------------------------------ HOME wiring
function renderHome() {
  const asOf = bank.asOf; const n = bank.items.filter(unlocked).length;
  $('bankInfo').textContent = `${n} questions · ${bank.lectures.filter(unlocked).length} lectures · updated ${asOf}`;
  const grid = $('courseGrid'); grid.innerHTML = '';
  const cards = [...COURSE_ORDER.map(c => ({ id: c, b: bank.courses[c].name, s: bank.courses[c].long })), { id: 'MIX', b: 'Mix', s: 'All four, weighted' }, { id: 'FOCUS', b: 'Focus pack', s: focusLabel() }];
  for (const c of cards) {
    const b = document.createElement('button'); b.className = 'course' + (settings.course === c.id ? ' on' : ''); b.style.setProperty('--c', COURSE_VAR[c.id]);
    const pct = coursePct(c.id);
    b.innerHTML = `<b>${esc(c.b)}</b><small>${esc(c.s)}</small><div class="prog"><i style="width:${pct}%"></i></div>`;
    b.onclick = () => { settings.course = c.id; saveSettings(); renderHome(); renderPick(); };
    grid.append(b);
  }
  document.querySelectorAll('[data-mode]').forEach(b => { b.classList.toggle('on', b.dataset.mode === settings.mode); b.setAttribute('aria-selected', b.dataset.mode === settings.mode); });
  document.querySelectorAll('[data-len]').forEach(b => b.classList.toggle('on', +b.dataset.len === settings.len));
  document.querySelectorAll('[data-pick]').forEach(b => b.classList.toggle('on', b.dataset.pick === settings.pick));
  $('lectureOpts').hidden = settings.mode !== 'lecture'; $('tutorOpts').hidden = settings.mode !== 'tutor';
  $('modeHint').textContent = settings.mode === 'lecture' ? 'Lecture mode plays a spoken lecture. Say “explain” after any point to talk it through, then “resume”.' : 'Tutor mode teaches a short point, then asks. Say the option number, true or false, or the value with its unit.';
  if (settings.mode === 'tutor') { const due = Tutor.dueItems(settings.course).length; const next = Tutor.nextLesson(settings.course, new Set()); $('tutorPlan').textContent = `${due} due for review` + (next ? ` · next new lesson: ${courseName(next.course)} — ${next.title}` : ' · no new lessons left; review only'); }
  $('btnStart').disabled = false;
  renderStats();
}
function focusLabel() { const q = (bank.focus.quizzes || []).filter(q => q.date >= todayISO())[0]; return q ? `Quiz ${q.date}: ${courseName(q.course)}` : 'Weak topics first'; }
function coursePct(id) { const cs = id === 'MIX' || id === 'FOCUS' ? COURSE_ORDER : [id]; const ls = bank.lessons.filter(l => cs.includes(l.course) && unlocked(l)); if (!ls.length) return 0; return Math.round(100 * ls.filter(l => progress.lessons[l.id]).length / ls.length); }
function renderPick() {
  const box = $('pickList'); box.innerHTML = ''; box.hidden = settings.pick === 'next';
  if (settings.pick === 'next') return;
  const cs = settings.course === 'MIX' || settings.course === 'FOCUS' ? COURSE_ORDER : [settings.course];
  if (settings.pick === 'lecture') {
    for (const L of bank.lectures.filter(L => cs.includes(L.course))) {
      const b = document.createElement('button'); const lock = !unlocked(L); const p = progress.lectures[L.id] || {};
      b.className = 'pick' + (settings.pickId === L.id ? ' on' : '') + (lock ? ' locked' : ''); b.disabled = lock;
      b.innerHTML = `<span>${esc(courseName(L.course))} · ${esc(L.class)}: ${esc(L.title)}</span><small>${lock ? 'after class' : p.done ? 'done' : p.seg ? 'at ' + p.seg + '/' + L.segments.length : Math.round(L.words / 150) + ' min'}</small>`;
      b.onclick = () => { settings.pickId = L.id; saveSettings(); renderPick(); }; box.append(b);
    }
  } else {
    for (const c of cs) for (const t of bank.courses[c].topics) {
      const segs = bank.lectures.filter(L => L.course === c && unlocked(L)).flatMap(L => L.segments).filter(s => s.topic === t); if (!segs.length) continue;
      const key = c + '|' + t; const b = document.createElement('button'); b.className = 'pick' + (settings.pickTopic === key ? ' on' : '');
      const words = segs.reduce((a, s) => a + s.text.split(' ').length, 0); const fs = focusScore(c, t);
      b.innerHTML = `<span>${esc(courseName(c))} · ${esc(t)}</span><small>${Math.round(words / 150)} min${fs >= 2 ? ' · priority' : ''}</small>`;
      b.onclick = () => { settings.pickTopic = key; saveSettings(); renderPick(); }; box.append(b);
    }
  }
}
function renderStats() {
  const s = progress.sessions.slice(-30); const asked = s.reduce((a, x) => a + x.asked, 0), right = s.reduce((a, x) => a + x.right, 0), mins = s.reduce((a, x) => a + (x.minutes || 0), 0);
  const weak = Object.entries(progress.topics).filter(([, t]) => t.n >= 3).map(([k, t]) => [k, t.bad / t.n, t.n]).sort((a, b) => b[1] - a[1]).slice(0, 4);
  let html = `<h2 class="label">Your record</h2><div class="stats"><div class="stat"><b>${mins}</b><small>minutes</small></div><div class="stat"><b>${asked}</b><small>answered</small></div><div class="stat"><b>${asked ? Math.round(100 * right / asked) : 0}%</b><small>right</small></div></div>`;
  if (weak.length) html += '<div class="weak">' + weak.map(([k, r, n]) => { const [c, t] = k.split('|'); return `<span>${esc(courseName(c))} · ${esc(t)}<small>${Math.round(100 * (1 - r))}% of ${n}</small></span>`; }).join('') + '</div>';
  $('statsBlock').innerHTML = html;
}
function fillVoiceSelect() { const sel = $('voiceSel'); if (!sel) return; sel.innerHTML = '<option value="">Automatic</option>' + Voice.voices.map(v => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === settings.voice ? 'selected' : ''}>${esc(v.name)} (${v.lang})</option>`).join(''); }

function wire() {
  document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { settings.mode = b.dataset.mode; saveSettings(); renderHome(); renderPick(); });
  document.querySelectorAll('[data-len]').forEach(b => b.onclick = () => { settings.len = +b.dataset.len; saveSettings(); renderHome(); });
  document.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => { settings.pick = b.dataset.pick; saveSettings(); renderHome(); renderPick(); });
  $('btnStart').onclick = () => {
    if (settings.mode === 'lecture') Session.start('lecture', settings.course, { len: settings.len, pick: settings.pick, id: settings.pickId, topic: settings.pickTopic });
    else Session.start('tutor', settings.course);
  };
  $('btnHome').onclick = () => { renderHome(); renderPick(); UI.show('home'); };
  $('cRepeat').onclick = () => Input.push('repeat');
  $('cExplain').onclick = () => Input.push('expand');
  $('cNext').onclick = () => Input.push('skip');
  $('cPause').onclick = () => { Session.paused ? Session.resume() : Session.pause(); };
  $('cEnd').onclick = () => Input.push('stop');
  // settings
  $('btnSettings').onclick = () => { UI.show('settings'); };
  $('btnCloseSettings').onclick = () => { renderHome(); UI.show('home'); };
  $('rate').value = settings.rate; $('rateOut').textContent = settings.rate.toFixed(2) + '×';
  $('rate').oninput = (e) => { settings.rate = +e.target.value; $('rateOut').textContent = settings.rate.toFixed(2) + '×'; saveSettings(); };
  $('voiceSel').onchange = (e) => { settings.voice = e.target.value; saveSettings(); };
  $('micOn').checked = settings.mic; $('micOn').onchange = (e) => { settings.mic = e.target.checked; saveSettings(); };
  $('optionsAloud').checked = settings.optionsAloud; $('optionsAloud').onchange = (e) => { settings.optionsAloud = e.target.checked; saveSettings(); };
  const prov = $('provider'); prov.innerHTML = Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join(''); prov.value = settings.provider || 'gemini';
  const provHint = () => { const P = PROVIDERS[settings.provider] || PROVIDERS.gemini; $('model').placeholder = P.model || 'model id'; $('keyLink').innerHTML = P.keys ? `Get a key: <a href="${P.keys}" target="_blank" rel="noopener">${P.keys.replace(/^https?:\/\//, '')}</a>` : ''; $('baseUrlRow').hidden = settings.provider !== 'custom'; };
  prov.onchange = (e) => { settings.provider = e.target.value; settings.model = ''; settings.modelAuto = ''; $('model').value = ''; saveSettings(); provHint(); }; provHint();
  $('apiKey').value = settings.apiKey; $('apiKey').onchange = (e) => { settings.apiKey = e.target.value.trim(); saveSettings(); };
  $('model').value = settings.model; $('model').onchange = (e) => { settings.model = e.target.value.trim(); saveSettings(); };
  $('baseUrl').value = settings.baseUrl || ''; $('baseUrl').onchange = (e) => { settings.baseUrl = e.target.value.trim(); saveSettings(); };
  $('btnTestAI').onclick = async () => { $('aiOut').textContent = 'Asking…'; try { const reply = await Expand.ask('Reply in one short spoken sentence.', [{ role: 'user', content: 'Say hello and name yourself.' }]); $('aiOut').textContent = 'Reply: ' + reply + (settings.model ? '' : ' (model: ' + (settings.modelAuto || '') + ')'); } catch (e) { $('aiOut').textContent = Expand.explain(e); } };
  $('ghRepo').value = settings.ghRepo; $('ghRepo').onchange = (e) => { settings.ghRepo = e.target.value.trim(); saveSettings(); };
  $('ghToken').value = settings.ghToken; $('ghToken').onchange = (e) => { settings.ghToken = e.target.value.trim(); saveSettings(); };
  $('btnTestVoice').onclick = async () => {
    $('testOut').textContent = 'Speaking…'; await Voice.say('Testing. Say: option two.');
    if (!Ear.available) { $('testOut').textContent = 'Voice works. This browser has no speech recognition; use the buttons.'; return; }
    $('testOut').textContent = 'Listening…'; const alts = await Ear.listen(6000);
    $('testOut').textContent = alts ? 'Heard: “' + alts[0] + '” → ' + (Parse.choice(alts[0], ['a', 'b', 'c']) === 1 ? 'understood as option two. Voice and microphone work.' : 'not understood as option two, but the microphone works.') : 'Nothing heard. Check the microphone permission for this site.';
  };
  $('btnSync').onclick = async () => { $('syncOut').textContent = 'Syncing…'; try { $('syncOut').textContent = await Sync.push(); renderStats(); } catch (e) { $('syncOut').textContent = Sync.explain(e); } };
  $('btnRefresh').onclick = async () => { $('syncOut').textContent = 'Checking…'; try { const before = bank.built; await loadBank(); $('syncOut').textContent = bank.built === before ? 'Already up to date (' + bank.asOf + ').' : 'New material loaded: ' + bank.asOf + '.'; renderHome(); } catch (e) { $('syncOut').textContent = e.message; } };
  $('btnExport').onclick = async () => { try { await navigator.clipboard.writeText(JSON.stringify(progress)); $('dataOut').textContent = 'Copied.'; } catch (e) { $('dataOut').textContent = 'Clipboard blocked.'; } };
  $('btnReset').onclick = () => { if ($('btnReset').dataset.armed) { for (const k of ['items', 'lessons', 'lectures', 'topics']) progress[k] = {}; progress.sessions = []; saveProgress(); $('dataOut').textContent = 'Progress reset.'; delete $('btnReset').dataset.armed; $('btnReset').textContent = 'Reset progress'; } else { $('btnReset').dataset.armed = '1'; $('btnReset').textContent = 'Tap again to confirm'; } };
  $('ver').textContent = VERSION;
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Session.running) Session.wakeLock(); });
  // keyboard shortcuts for desktop testing
  document.addEventListener('keydown', (e) => { if (!Session.running) return; if (e.key === ' ') { e.preventDefault(); Session.paused ? Session.resume() : Session.pause(); } if (e.key === 'ArrowRight') Input.push('skip'); if (e.key === 'r') Input.push('repeat'); if (e.key === 'e') Input.push('expand'); if (e.key === 'Escape') Input.push('stop'); if (/^[1-4]$/.test(e.key)) Input.push({ answer: +e.key - 1 }); });
}

(async function main() {
  Voice.init(); wire();
  try { await loadBank(); } catch (e) { $('bankInfo').textContent = e.message; return; }
  try { await Sync.pull(); } catch (e) { console.warn('sync pull', e); }
  renderHome(); renderPick();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
})();
