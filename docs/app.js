/* Pandora Practice Pal — hands-free lecture + tutor app for the Pandora vault. */
'use strict';
const VERSION = '2.1.0';
const $ = (id) => document.getElementById(id);
const todayISO = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const DAY = 86400000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const COURSE_ORDER = ['DIGI210', 'ELTR238', 'MATH237', 'EFAB202'];
const COURSE_VAR = { DIGI210: 'var(--digi)', ELTR238: 'var(--eltr)', MATH237: 'var(--math)', EFAB202: 'var(--efab)', MIX: 'var(--mix)', FOCUS: 'var(--focus)' };

// ------------------------------------------------------------------ storage
function load(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } }
function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage may be unavailable */ } }
const settings = Object.assign({ rate: 1, voice: '', mic: true, optionsAloud: true, apiKey: '', model: '', provider: 'gemini', baseUrl: '', keys: {}, models: {}, neuralVoice: false, earMode: 'auto', pick: 'resume', ghRepo: '', ghToken: '', len: 20, mode: 'lecture', course: 'FOCUS', pick: 'next' }, load('pp.settings', {}));
const progress = Object.assign({ v: 1, items: {}, lessons: {}, lectures: {}, topics: {}, sessions: [], updated: 0 }, load('pp.progress', {}));
const saveSettings = () => save('pp.settings', settings);
if (settings.apiKey && !settings.keys[settings.provider || 'gemini']) { settings.keys[settings.provider || 'gemini'] = settings.apiKey; saveSettings(); } // carry the 1.x key over
if (settings.pick === 'next') settings.pick = 'resume';
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
// Voice → voice.js · Ear → ear.js · Brain/Help/Tutorbot → ai.js

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
  queueCmd(c) { this.queuedCmd = c; if (['repeat', 'skip', 'explain', 'expand', 'ai'].includes(c) || typeof c === 'object') Voice.stop(); },
  takeCmd() { const c = this.queuedCmd; this.queuedCmd = null; return c; },
  pause() { if (!this.running || this.paused) return; this.paused = true; Voice.stop(); Ear.stop(); UI.status('Paused', 'paused'); UI.setPause(true); setTimeout(() => this.pausedEar(), 400); },
  async pausedEar() { // keep one ear open while paused so "resume" and "stop" still work by voice
    while (this.running && this.paused) {
      const alts = await Ear.listen(12000); if (!this.paused) break;
      if (!alts) { await sleep(300); continue; }
      const c = Parse.command(alts[0]);
      if (c === 'resume') this.resume(); else if (c === 'stop') this.end();
    }
  },
  resume() { if (!this.paused) return; this.paused = false; UI.setPause(false); UI.status('Speaking'); if (this.pendingResume) { const r = this.pendingResume; this.pendingResume = null; r(); } },
  async waitIfPaused() { if (this.paused) await new Promise(r => { this.pendingResume = r; }); },
  async autoPause() { this.silent = 0; await Voice.say('I have not heard you for a while, so I will pause. Say resume, or tap pause, when you are ready.'); this.pause(); await this.waitIfPaused(); },
  async wakeLock() { try { this.wake = await navigator.wakeLock.request('screen'); } catch (e) { } },
  async start(mode, course, opts = {}) {
    this.running = true; this.paused = false; this.silent = 0; this.mode = mode; this.course = course; this.asked = 0; this.right = 0; this.log = []; this.startedAt = Date.now(); this.queuedCmd = null;
    UI.show('session'); $('sessCourse').textContent = course === 'MIX' ? 'Mix' : course === 'FOCUS' ? 'Focus' : courseName(course);
    $('sessCourse').style.borderColor = COURSE_VAR[course] || 'var(--line)';
    this.wakeLock(); Media.start(); Voice.unlock(); UI.setPause(false);
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
    Media.stop(); Voice.stop(); Ear.stop(); Ear.release();
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
async function speak(text, kicker, opts = {}) {
  Session.check(); await Session.waitIfPaused(); Session.check();
  UI.status('Speaking'); UI.stage(text, kicker);
  const ok = await Voice.say(text, { startAt: opts.startAt || 0, onProgress: (at, len, cs, cl) => UI.highlightAt(at, len, cs, cl), onWait: (w) => UI.status(w ? 'Preparing voice' : 'Speaking') });
  Session.check();
  return ok;
}
// Explain / Expand / AI — available from every screen; ctx = {course,title,text,eli5,deep,expand}
async function helpCmd(cmd, ctx, kicker) {
  if (!ctx) return false;
  if (cmd === 'explain') { await Help.explain(ctx, kicker); return true; }
  if (cmd === 'expand') { await Help.expand(ctx, kicker); return true; }
  if (cmd === 'ai') { await Tutorbot.converse(ctx, kicker); return true; }
  return false;
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
      const lk = courseName(lesson.course) + ' · ' + lesson.title;
      Session.ctx = { course: lesson.course, title: lesson.title, text: lesson.teach, eli5: lesson.eli5, deep: lesson.deep };
      let ok = await speak(lesson.teach, lk); let cmd = ok ? Session.takeCmd() : (Session.takeCmd() || 'repeat');
      while (cmd) {
        if (cmd === 'repeat') { const at = Math.max(0, Voice.lastPos - 15); ok = await speak(lesson.teach, lk, { startAt: ok ? 0 : at }); }
        else if (await helpCmd(cmd, Session.ctx, lk)) { ok = true; }
        else break;
        cmd = ok ? Session.takeCmd() : (Session.takeCmd() || 'repeat');
      }
      let wrongs = 0;
      for (const id of lesson.items) { if (!byId[id] || !unlocked(byId[id])) continue; done.add(id); const res = await this.ask(byId[id]); if (res === 'wrong') { wrongs++; retry.push({ id, after: Session.asked + 4 }); } }
      progress.lessons[lesson.id] = { done: Date.now(), wrongs }; saveProgress();
      reviewBudget = Math.min(reviewBudget + 2, 4);
    }
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
        if (['explain', 'expand', 'ai'].includes(c)) { const L = lessonById[item.lesson] || {}; await helpCmd(c, { course: item.course, title: item.topic, text: L.teach || item.concept, eli5: L.eli5, deep: L.deep }, kicker); await speak(qtext, kicker); continue; }
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
    const L = lessonById[(item._orig || item).lesson] || {};
    Session.ctx = { course: item.course, title: item.topic, text: 'Question: ' + item.q + ' Correct answer: ' + this.answerText(item) + ' Why: ' + item.right + ' Concept: ' + item.concept, eli5: L.eli5, deep: L.deep };
    const r = await speakThenWindow('Say explain, expand, or A I for more, or we move on.', kicker, 2500);
    if (r && r.cmd) await helpCmd(r.cmd, Session.ctx, kicker);
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
  resumable(course) { // the lecture part-way through, most recent first
    return this.lecturesFor(course).filter(unlocked).filter(L => { const p = progress.lectures[L.id]; return p && p.seg > 0 && !p.done; }).sort((a, b) => (progress.lectures[b.id].last || 0) - (progress.lectures[a.id].last || 0))[0] || null;
  },
  // Build the playlist of segments for this session
  playlist(course, opts) {
    const budget = (opts.len || settings.len) * 150; // words
    let segs = [];
    if (opts.pick === 'lecture' && opts.id) { const L = lectureById[opts.id]; segs = L.segments.map(s => ({ ...s, L, key: L.id })); }
    else if (opts.pick === 'topic' && opts.topic) {
      const [c, t] = opts.topic.split('|');
      for (const L of this.lecturesFor(c).filter(unlocked).sort((a, b) => a.unlock.localeCompare(b.unlock))) for (const s of L.segments) if (s.topic === t) segs.push({ ...s, L, key: 'topic:' + opts.topic });
    } else if (opts.pick === 'random' || (opts.pick === 'resume' && !this.resumable(course))) {
      let Ls = this.lecturesFor(course).filter(unlocked); const fresh = Ls.filter(L => !(progress.lectures[L.id] || {}).done && !this.pos(L.id));
      const pool = course === 'FOCUS' ? (fresh.length ? fresh : Ls).sort((a, b) => Math.max(...b.segments.map(s => focusScore(b.course, s.topic))) - Math.max(...a.segments.map(s => focusScore(a.course, s.topic)))).slice(0, 4) : (fresh.length ? fresh : Ls);
      const L = pool[Math.floor(Math.random() * pool.length)]; if (L) { progress.lectures[L.id] = { seg: 0, last: Date.now() }; segs = L.segments.map(s => ({ ...s, L, key: L.id })); }
    } else {
      // resume: the lecture you were most recently part-way through
      let Ls = this.lecturesFor(course).filter(unlocked);
      const unfinished = Ls.filter(L => !(progress.lectures[L.id] || {}).done);
      if (course === 'FOCUS') unfinished.sort((a, b) => (Math.max(...b.segments.map(s => focusScore(b.course, s.topic))) - Math.max(...a.segments.map(s => focusScore(a.course, s.topic)))) || b.unlock.localeCompare(a.unlock));
      else unfinished.sort((a, b) => ((this.pos(b.id) > 0) - (this.pos(a.id) > 0)) || (((progress.lectures[b.id] || {}).last || 0) - ((progress.lectures[a.id] || {}).last || 0)) || a.unlock.localeCompare(b.unlock));
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
    await speak((first.index === 0 ? 'Lecture: ' : 'Continuing: ') + first.L.title + '. ' + courseName(first.L.course) + '. Use repeat to go back fifteen seconds, and explain, expand or A I whenever you want more.');
    let sinceCheck = 0; let startAt = 0; const durs = [];
    for (let k = 0; k < list.length; k++) {
      const s = list[k]; Session.check();
      $('sessCount').textContent = (s.index + 1) + ' / ' + s.total;
      const kicker = courseName(s.L.course) + ' · ' + s.L.title + ' · ' + s.title;
      Session.ctx = { course: s.L.course, title: s.L.title + ' — ' + s.title, text: s.text, eli5: s.eli5, deep: s.deep, expand: s.expand };
      if (list[k + 1]) Voice.prefetch(list[k + 1].text);
      if (k > 0) await sleep(900);
      let ok = await speak(s.text, kicker, { startAt }); startAt = 0;
      let cmd = ok ? Session.takeCmd() : (Session.takeCmd() || 'repeat');
      let jumpedBack = false;
      while (cmd) {
        if (cmd === 'repeat') {                                        // back 15 seconds, into the previous point if needed
          const back = (ok ? Voice.durationOf(s.text) : Voice.lastPos) - 15;
          if (back >= 0 || k === 0) { ok = await speak(s.text, kicker, { startAt: Math.max(0, back) }); cmd = ok ? Session.takeCmd() : (Session.takeCmd() || 'repeat'); continue; }
          startAt = Math.max(0, Voice.durationOf(list[k - 1].text) + back); k -= 2; jumpedBack = true; break;
        }
        if (await helpCmd(cmd, Session.ctx, kicker)) { await speak('Back to the lecture.', kicker); }
        cmd = null;
      }
      if (jumpedBack) continue;
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
        if (['explain', 'expand', 'ai'].includes(k)) { await helpCmd(k, Session.ctx, kicker); await speak(qtext, kicker); continue; }
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
  stage(text, kicker) {
    $('stageKicker').textContent = kicker || ''; $('heard').textContent = '';
    if (this._full === text && $('spoken').childNodes.length) return;   // same block (rewind): keep the layout, just move the highlight
    this._full = text; const el = $('spoken'); el.textContent = ''; el.scrollTop = 0; this._words = [];
    const re = /\S+/g; let m, last = 0, prev = '', ph = 0, inPh = 0;
    while ((m = re.exec(text))) {
      if (m.index > last) { const gap = text.slice(last, m.index); const pw = this._words[this._words.length - 1]; if (pw) pw.el.textContent += gap; else el.append(gap); }   // spaces belong to the word before, so a phrase highlights as one band
      const sp = document.createElement('span'); sp.className = 'w'; sp.textContent = SpeechText.display(m[0], prev); el.append(sp);
      this._words.push({ at: m.index, el: sp, ph }); last = m.index + m[0].length; prev = m[0];
      inPh++; if (/[,;:.!?)]$/.test(m[0]) && inPh >= 3 || inPh >= 8) { ph++; inPh = 0; }   // phrases: clause-sized chunks of 3–8 words
    }
    this._cur = -1; this._sent = []; this._ph = -1;
  },
  highlightAt(at, len, cStart, cLen) {
    const ws = this._words || []; let i = this._cur;
    if (i < 0 || !ws[i] || ws[i].at > at) i = 0;
    while (i + 1 < ws.length && ws[i + 1].at <= at) i++;
    if (i === this._cur && this._sentKey === cStart) return;
    if (this._sentKey !== cStart && (settings.hl || 'phrase') !== 'off') { for (const s of this._sent) s.classList.remove('s'); this._sent = ws.filter(w => w.at >= cStart && w.at < cStart + cLen).map(w => w.el); for (const s of this._sent) s.classList.add('s'); this._sentKey = cStart; }
    this._cur = i; const w = ws[i]; if (!w) return;
    const hl = settings.hl || 'phrase';
    if (hl === 'phrase' && w.ph !== this._ph) {                   // the whole phrase being spoken
      this._ph = w.ph;
      for (const x of ws) { x.el.classList.toggle('now', x.ph === w.ph); x.el.classList.toggle('past', x.ph < w.ph); }
    } else if (hl === 'word') {                                   // one word at a time
      for (let j = 0; j < ws.length; j++) { ws[j].el.classList.toggle('now', j === i); ws[j].el.classList.toggle('past', j < i); }
    } else if (hl === 'off') { for (const x of ws) x.el.classList.remove('now', 'past', 's'); }
    $('spoken').dataset.hl = hl;
    const box = $('spoken'); const target = w.el.offsetTop - box.offsetTop - box.clientHeight * 0.38;
    if (Math.abs(box.scrollTop - target) > 8) box.scrollTo({ top: Math.max(0, target), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  },
  setPause(p) { const b = $('cPause'); b.classList.toggle('on', !!p); b.innerHTML = (p ? ICON.play + '<span>Play</span>' : ICON.pause + '<span>Pause</span>'); b.setAttribute('aria-label', p ? 'Play' : 'Pause'); },
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
const ICON = {
  back15: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5V2L6 6l5 4V7a6 6 0 1 1-6 6H3a8 8 0 1 0 8-8z"/><text x="12" y="16.2" text-anchor="middle" font-size="6.6" font-weight="700" font-family="Atkinson Hyperlegible,system-ui">15</text></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.2v13.6a1 1 0 0 0 1.5.86l11-6.8a1 1 0 0 0 0-1.72l-11-6.8A1 1 0 0 0 8 5.2z"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6.2v11.6a1 1 0 0 0 1.55.83L15 13v4.8a1 1 0 0 0 2 0V6.2a1 1 0 0 0-2 0V11L6.55 5.37A1 1 0 0 0 5 6.2z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  explain: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a7 7 0 0 0-4 12.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26A7 7 0 0 0 12 2zm-2 18h4v1a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-1z"/></svg>',
  expand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v2H4zm0 4h16v2H4zm0 4h10v2H4zm0 4h10v2H4zm13-3 4 3-4 3z"/></svg>',
  ai: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm4 6.5a1.5 1.5 0 1 0 0 .01zm4 0a1.5 1.5 0 1 0 0 .01zm4 0a1.5 1.5 0 1 0 0 .01z"/></svg>',
  gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4z"/></svg>',
};

function renderHome() {
  const n = bank.items.filter(unlocked).length;
  $('bankInfo').textContent = `${n} questions · ${bank.lectures.filter(unlocked).length} lectures · ${bank.asOf}`;
  const grid = $('courseGrid'); grid.innerHTML = '';
  const cards = [...COURSE_ORDER.map(c => ({ id: c, b: bank.courses[c].name, s: bank.courses[c].long })), { id: 'MIX', b: 'Mix', s: 'All four, weighted' }, { id: 'FOCUS', b: 'Focus', s: focusLabel() }];
  for (const c of cards) {
    const b = document.createElement('button'); b.className = 'course' + (settings.course === c.id ? ' on' : ''); b.style.setProperty('--c', COURSE_VAR[c.id]);
    b.setAttribute('aria-pressed', settings.course === c.id);
    b.innerHTML = `<b>${esc(c.b)}</b><small>${esc(c.s)}</small><span class="ring" style="--p:${coursePct(c.id)}"></span>`;
    b.onclick = () => { settings.course = c.id; saveSettings(); renderHome(); renderPick(); };
    grid.append(b);
  }
  document.querySelectorAll('[data-mode]').forEach(b => { b.classList.toggle('on', b.dataset.mode === settings.mode); b.setAttribute('aria-selected', b.dataset.mode === settings.mode); });
  document.querySelectorAll('[data-len]').forEach(b => b.classList.toggle('on', +b.dataset.len === settings.len));
  document.querySelectorAll('[data-pick]').forEach(b => b.classList.toggle('on', b.dataset.pick === settings.pick));
  $('lectureOpts').hidden = settings.mode !== 'lecture'; $('tutorOpts').hidden = settings.mode !== 'tutor';
  $('modeHint').textContent = settings.mode === 'lecture' ? 'A spoken lecture with a quick question every two points. Repeat goes back 15 seconds.' : 'A short point, then questions. Answer with the option number, true or false, or the value and its unit.';
  if (settings.mode === 'tutor') { const due = Tutor.dueItems(settings.course).length; const next = Tutor.nextLesson(settings.course, new Set()); $('tutorPlan').textContent = `${due} due for review` + (next ? ` · next: ${courseName(next.course)} — ${next.title}` : ' · review only'); }
  // resume card
  const R = settings.mode === 'lecture' ? Lecture.resumable(settings.course) : null;
  $('resumeCard').hidden = !R;
  if (R) { const p = progress.lectures[R.id]; $('resumeTitle').textContent = R.title; $('resumeSub').textContent = `${courseName(R.course)} · ${R.class} · point ${p.seg + 1} of ${R.segments.length}`; $('resumeBar').style.width = Math.round(100 * p.seg / R.segments.length) + '%'; }
  $('startLabel').textContent = settings.mode === 'tutor' ? 'Start tutoring' : settings.pick === 'resume' ? (R ? 'Resume lecture' : 'Start a lecture') : settings.pick === 'random' ? 'Start a new lecture' : 'Start';
  $('btnStart').disabled = false;
  renderVoiceChip(); renderStats();
}
function renderVoiceChip() {
  const st = Voice.st; const chip = $('voiceChip');
  if (st.neural === 'ready') { chip.hidden = true; return; }
  chip.hidden = false;
  if (st.neural === 'loading') { chip.textContent = 'Downloading the natural voice · ' + Math.round(st.progress) + '%'; chip.disabled = true; }
  else if (st.why === 'nogpu') { chip.textContent = 'Natural voice needs Chrome or the installed app · using the phone voice'; chip.disabled = true; }
  else { chip.textContent = 'Get the natural voice (330 MB, once, on Wi-Fi)'; chip.disabled = false; }
}
function focusLabel() { const q = (bank.focus.quizzes || []).filter(q => q.date >= todayISO())[0]; return q ? `Quiz ${q.date.slice(5)} · ${courseName(q.course)}` : 'Weak topics first'; }
function coursePct(id) { const cs = id === 'MIX' || id === 'FOCUS' ? COURSE_ORDER : [id]; const ls = bank.lessons.filter(l => cs.includes(l.course) && unlocked(l)); if (!ls.length) return 0; return Math.round(100 * ls.filter(l => progress.lessons[l.id]).length / ls.length); }
function renderPick() {
  const box = $('pickList'); box.innerHTML = ''; box.hidden = !(settings.pick === 'lecture' || settings.pick === 'topic');
  if (box.hidden) return;
  const cs = settings.course === 'MIX' || settings.course === 'FOCUS' ? COURSE_ORDER : [settings.course];
  if (settings.pick === 'lecture') {
    for (const L of bank.lectures.filter(L => cs.includes(L.course))) {
      const b = document.createElement('button'); const lock = !unlocked(L); const p = progress.lectures[L.id] || {};
      b.className = 'pick' + (settings.pickId === L.id ? ' on' : '') + (lock ? ' locked' : ''); b.disabled = lock;
      b.innerHTML = `<span>${esc(courseName(L.course))} · ${esc(L.class)}: ${esc(L.title)}</span><small>${lock ? 'after class' : p.done ? 'done' : p.seg ? 'point ' + p.seg + '/' + L.segments.length : Math.round(L.words / 150) + ' min'}</small>`;
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
function renderSettings() {
  const st = Voice.st;
  $('voiceState').textContent = st.neural === 'ready' ? 'Natural voice ready' : st.neural === 'loading' ? 'Downloading the natural voice' : 'Using the phone’s voice';
  $('voiceWhy').textContent = st.neural === 'ready' ? 'Kokoro · generated on this phone (' + (st.device || 'webgpu') + ')' : st.why === 'nogpu' ? 'This browser has no WebGPU. Use Chrome or the installed app for the natural voice.' : st.neural === 'failed' ? 'It could not load: ' + String(st.why || '').slice(0, 120) : '';
  $('voiceMeter').hidden = st.neural !== 'loading'; $('voiceMeterBar').style.width = Math.round(st.progress) + '%';
  $('btnVoice').hidden = st.neural === 'ready' || st.why === 'nogpu'; $('btnVoice').disabled = st.neural === 'loading';
  renderMic();
}
function platform() { const u = navigator.userAgent; return /Android/.test(u) ? 'android' : /iPhone|iPad/.test(u) ? 'ios' : /Mac/.test(u) ? 'mac' : 'desktop'; }
function browserName() { const u = navigator.userAgent; return /Firefox/.test(u) ? 'firefox' : /Edg\//.test(u) ? 'edge' : /Chrome/.test(u) ? 'chrome' : /Safari/.test(u) ? 'safari' : 'other'; }
function permSteps(state) {
  const pf = platform(), br = browserName(), standalone = matchMedia('(display-mode: standalone)').matches;
  const steps = [];
  if (pf === 'android' && standalone) steps.push('Open Android Settings → Apps → Practice Pal (or Chrome) → Permissions → Microphone → Allow only while using the app.');
  else if (pf === 'android' && br === 'firefox') steps.push('In Firefox tap the lock icon left of the address → Permissions → Microphone → Allowed.', 'Also check Android Settings → Apps → Firefox → Permissions → Microphone → Allow.');
  else if (pf === 'android') steps.push('Tap the tune/lock icon left of the address → Permissions → Microphone → Allow.', 'Also check Android Settings → Apps → Chrome → Permissions → Microphone → Allow.');
  else if (pf === 'mac') steps.push('Click the icon left of the address bar → Microphone → Allow.', 'Then Apple menu → System Settings → Privacy & Security → Microphone → turn on your browser (or the Claude app).', 'Pick your built-in microphone in "Microphone to use" below if headphones are taking over.');
  else steps.push('Click the icon left of the address bar → Microphone → Allow, then reload.');
  if (state === 'denied') steps.push('After changing it, come back here and press “Allow the microphone” again.');
  return '<ol>' + steps.map(x => '<li>' + esc(x) + '</li>').join('') + '</ol>';
}
async function renderMic() {
  const perm = await Ear.permission();
  const dot = $('permDot'); dot.className = 'dot ' + (perm === 'granted' ? 'ok' : perm === 'denied' ? 'bad' : 'ask');
  $('permState').textContent = perm === 'granted' ? 'Microphone allowed' : perm === 'denied' ? 'Microphone blocked' : 'Microphone not allowed yet';
  $('permWhy').textContent = perm === 'denied' ? 'The browser will not ask again until you change the setting — follow the steps below.' : perm === 'granted' ? '' : 'Press the button and choose Allow.';
  $('btnPerm').hidden = perm === 'granted'; $('permSteps').innerHTML = permSteps(perm); $('permHelp').open = perm === 'denied';
  // device list (labels appear once permission is granted)
  const devs = await Ear.devices(); const sel = $('micSel'); const cur = settings.micId || '';
  sel.innerHTML = '<option value="">System default</option>' + devs.filter(d => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || 'Microphone ' + (i + 1))}</option>`).join('');
  sel.value = devs.some(d => d.deviceId === cur) ? cur : '';
  $('micSelHint').hidden = !Ear.st.nativeOk;
  $('earMode').value = settings.earMode || 'auto';
  $('micState').textContent = 'Using: ' + Ear.label;
  $('micWhy').textContent = Ear.st.lastError || (!Ear.st.nativeOk ? 'This browser has no built-in speech recognition, so answers are transcribed by Whisper.' : '');
  const ls = Ear.st.local; $('btnLocalStt').hidden = ls === 'ready'; $('btnLocalStt').disabled = ls === 'loading';
  $('sttMeter').hidden = ls !== 'loading'; $('sttMeterBar').style.width = Math.round(Ear.st.localProgress) + '%';
}
let meterStop = null;
async function runMeter(sec = 10) {
  if (meterStop) { meterStop(); return; }
  let s; try { s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: settings.micId ? { exact: settings.micId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); } catch (e) { $('testOut').textContent = 'Could not open the microphone: ' + (e.name === 'NotAllowedError' ? 'permission blocked.' : e.message); renderMic(); return; }
  const ac = new AudioContext(); const an = ac.createAnalyser(); an.fftSize = 1024; ac.createMediaStreamSource(s).connect(an); const buf = new Float32Array(an.fftSize);
  const label = s.getAudioTracks()[0].label; $('testOut').textContent = 'Listening on: ' + label + '. Talk and watch the bar.'; $('btnMeter').textContent = 'Stop';
  let on = true; meterStop = () => { on = false; };
  const t0 = performance.now(); let peak = 0;
  while (on && performance.now() - t0 < sec * 1000) { an.getFloatTimeDomainData(buf); let e = 0; for (const x of buf) e += x * x; const r = Math.sqrt(e / buf.length); peak = Math.max(peak, r); $('levelBar').style.width = Math.min(100, r * 400) + '%'; await sleep(60); }
  s.getTracks().forEach(t => t.stop()); ac.close(); meterStop = null; $('btnMeter').textContent = 'Watch the level'; $('levelBar').style.width = '0';
  $('testOut').textContent = peak < 0.01 ? 'Almost no sound reached the app from “' + label + '”. Pick another microphone above or check that it is not muted.' : peak < 0.04 ? 'Sound is coming through from “' + label + '” but quietly. Speak up or move the phone closer.' : 'Good level from “' + label + '”.';
}
renderMic.renderMicSoon = () => { if (!$('settings').hidden) renderMic(); };
function renderKeys() {
  const box = $('keyRows'); box.innerHTML = '';
  CHAIN.forEach((p, i) => {
    const P = PROVIDERS[p]; const row = document.createElement('div'); row.className = 'keyrow';
    row.innerHTML = `<div class="keyhead"><span class="n">${i + 1}</span><b>${esc(P.name)}</b><a href="${P.keys}" target="_blank" rel="noopener">Get a free key</a></div><input type="password" id="key_${p}" autocomplete="off" placeholder="paste the ${esc(P.name)} key">`;
    box.append(row);
    const inp = row.querySelector('input'); inp.value = (settings.keys || {})[p] || '';
    inp.onchange = () => { settings.keys = settings.keys || {}; settings.keys[p] = inp.value.trim(); delete (settings.models || {})[p]; saveSettings(); renderSettings(); };
  });
}

function wire() {
  $('btnSettings').innerHTML = ICON.gear; $('btnCloseSettings').innerHTML = ICON.close;
  $('cRepeat').innerHTML = ICON.back15 + '<span>Back 15 s</span>'; $('cNext').innerHTML = ICON.next + '<span>Next</span>'; $('cEnd').innerHTML = ICON.stop + '<span>End</span>';
  $('cExplain').innerHTML = ICON.explain + '<span>Explain</span>'; $('cExpand').innerHTML = ICON.expand + '<span>Expand</span>'; $('cAI').innerHTML = ICON.ai + '<span>AI</span>';
  UI.setPause(false);
  document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { settings.mode = b.dataset.mode; saveSettings(); renderHome(); renderPick(); });
  document.querySelectorAll('[data-len]').forEach(b => b.onclick = () => { settings.len = +b.dataset.len; saveSettings(); renderHome(); });
  document.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => { settings.pick = b.dataset.pick; saveSettings(); renderHome(); renderPick(); });
  const go = (pick) => { Voice.unlock(); if (settings.mode === 'lecture') Session.start('lecture', settings.course, { len: settings.len, pick: pick || settings.pick, id: settings.pickId, topic: settings.pickTopic }); else Session.start('tutor', settings.course); };
  $('btnStart').onclick = () => go();
  $('btnResume').onclick = () => go('resume');
  $('btnNew').onclick = () => go('random');
  $('voiceChip').onclick = () => { Voice.initNeural(true); };
  $('btnHome').onclick = () => { renderHome(); renderPick(); UI.show('home'); };
  $('cRepeat').onclick = () => Input.push('repeat');
  $('cExplain').onclick = () => Input.push('explain');
  $('cExpand').onclick = () => Input.push('expand');
  $('cAI').onclick = () => Input.push('ai');
  $('cNext').onclick = () => Input.push('skip');
  $('cPause').onclick = () => { Session.paused ? Session.resume() : Session.pause(); };
  $('cEnd').onclick = () => Input.push('stop');
  // settings
  $('btnSettings').onclick = () => { renderSettings(); renderKeys(); UI.show('settings'); };
  $('btnCloseSettings').onclick = () => { renderHome(); UI.show('home'); };
  $('btnVoice').onclick = () => { Voice.initNeural(true); renderSettings(); };
  Voice.onChange(() => { renderVoiceChip(); if (!$('settings').hidden) renderSettings(); });
  const hlPaint = () => document.querySelectorAll('[data-hl]').forEach(b => b.classList.toggle('on', b.dataset.hl === (settings.hl || 'phrase')));
  document.querySelectorAll('[data-hl]').forEach(b => b.onclick = () => { settings.hl = b.dataset.hl; saveSettings(); hlPaint(); }); hlPaint();
  $('rate').value = settings.rate; $('rateOut').textContent = (+settings.rate).toFixed(2) + '×';
  $('rate').oninput = (e) => { settings.rate = +e.target.value; $('rateOut').textContent = settings.rate.toFixed(2) + '×'; saveSettings(); };
  $('micOn').checked = settings.mic; $('micOn').onchange = (e) => { settings.mic = e.target.checked; saveSettings(); renderMic(); };
  $('earMode').value = settings.earMode || 'auto'; $('earMode').onchange = (e) => { settings.earMode = e.target.value; saveSettings(); if (e.target.value === 'local') Ear.initLocal(); renderMic(); };
  $('micSel').onchange = (e) => { settings.micId = e.target.value; saveSettings(); Ear.release(); if (settings.micId && (settings.earMode || 'auto') === 'auto') Ear.initLocal(); renderMic(); };
  $('btnPerm').onclick = async () => { const ok = await Ear.request(); $('testOut').textContent = ok ? 'Microphone allowed.' : 'Still blocked — follow the steps below.'; Ear.release(); renderMic(); };
  $('btnLocalStt').onclick = () => { Ear.initLocal(); renderMic(); };
  $('btnMeter').onclick = () => runMeter(12);
  Ear.onChange(() => renderMic.renderMicSoon());
  try { navigator.mediaDevices.addEventListener('devicechange', () => renderMic.renderMicSoon()); } catch (e) { }
  if (settings.localStt || (!Ear.st.nativeOk && navigator.mediaDevices)) Ear.initLocal();   // Firefox etc.: get the on-device recogniser ready
  $('optionsAloud').checked = settings.optionsAloud; $('optionsAloud').onchange = (e) => { settings.optionsAloud = e.target.checked; saveSettings(); };
  $('btnTestAI').onclick = async () => {
    const out = $('aiOut'); out.innerHTML = '';
    if (!Brain.active().length) { out.textContent = 'Add at least one key first.'; return; }
    for (const p of CHAIN) {
      const row = document.createElement('div'); row.className = 'kst'; row.innerHTML = `<b>${esc(PROVIDERS[p].name)}</b><span>…</span>`; out.append(row);
      if (!Brain.key(p)) { row.querySelector('span').textContent = 'no key · skipped'; row.classList.add('off'); continue; }
      try { const ctl = new AbortController(); setTimeout(() => ctl.abort(), 15000); const t0 = performance.now(); const r = await Brain.one(p, 'Reply in at most eight words.', [{ role: 'user', content: 'Say hello.' }], ctl.signal); row.querySelector('span').textContent = `ok · ${Math.round(performance.now() - t0)} ms · ${Brain.status[p].model}`; row.classList.add('ok'); }
      catch (e) { row.querySelector('span').textContent = String(e.message || e).slice(0, 110); row.classList.add('bad'); }
    }
  };
  $('ghRepo').value = settings.ghRepo; $('ghRepo').onchange = (e) => { settings.ghRepo = e.target.value.trim(); saveSettings(); };
  $('ghToken').value = settings.ghToken; $('ghToken').onchange = (e) => { settings.ghToken = e.target.value.trim(); saveSettings(); };
  $('btnTestVoice').onclick = async () => {
    Voice.unlock(); $('testOut').textContent = 'Speaking…'; await Voice.say('Testing. Say: option two.');
    if (!Ear.available) { $('testOut').textContent = 'The microphone is turned off above, or no recogniser is available.'; return; }
    $('testOut').textContent = 'Listening (' + Ear.label + ')… say “option two”.'; const alts = await Ear.listen(7000);
    $('testOut').textContent = alts ? 'Heard: “' + alts[0] + '” → ' + (Parse.choice(alts[0], ['a', 'b', 'c']) === 1 ? 'understood as option two. Voice and microphone work.' : 'not option two, but the microphone works.') : ('Nothing heard. ' + (Ear.st.lastError || 'Check the microphone permission for this app.'));
    renderSettings();
  };
  $('btnSync').onclick = async () => { $('syncOut').textContent = 'Syncing…'; try { $('syncOut').textContent = await Sync.push(); renderStats(); } catch (e) { $('syncOut').textContent = Sync.explain(e); } };
  $('btnRefresh').onclick = async () => { $('syncOut').textContent = 'Checking…'; try { const before = bank.built; await loadBank(); $('syncOut').textContent = bank.built === before ? 'Already up to date (' + bank.asOf + ').' : 'New material loaded: ' + bank.asOf + '.'; renderHome(); } catch (e) { $('syncOut').textContent = e.message; } };
  $('btnExport').onclick = async () => { try { await navigator.clipboard.writeText(JSON.stringify(progress)); $('dataOut').textContent = 'Copied.'; } catch (e) { $('dataOut').textContent = 'Clipboard blocked.'; } };
  $('btnReset').onclick = () => { if ($('btnReset').dataset.armed) { for (const k of ['items', 'lessons', 'lectures', 'topics']) progress[k] = {}; progress.sessions = []; saveProgress(); $('dataOut').textContent = 'Progress reset.'; delete $('btnReset').dataset.armed; $('btnReset').textContent = 'Reset progress'; } else { $('btnReset').dataset.armed = '1'; $('btnReset').textContent = 'Tap again to confirm'; } };
  $('ver').textContent = VERSION;
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Session.running) Session.wakeLock(); });
  document.addEventListener('keydown', (e) => { if (!Session.running) return; if (e.key === ' ') { e.preventDefault(); Session.paused ? Session.resume() : Session.pause(); } if (e.key === 'ArrowRight') Input.push('skip'); if (e.key === 'ArrowLeft' || e.key === 'r') Input.push('repeat'); if (e.key === 'e') Input.push('explain'); if (e.key === 'x') Input.push('expand'); if (e.key === 'a') Input.push('ai'); if (e.key === 'Escape') Input.push('stop'); if (/^[1-4]$/.test(e.key)) Input.push({ answer: +e.key - 1 }); });
}

(async function main() {
  wire(); Voice.init();
  try { await loadBank(); } catch (e) { $('bankInfo').textContent = e.message; return; }
  try { await Sync.pull(); } catch (e) { console.warn('sync pull', e); }
  renderHome(); renderPick();
  // ?start=lecture|tutor (home-screen shortcuts)
  const q = new URLSearchParams(location.search).get('start'); if (q === 'lecture' || q === 'tutor') { settings.mode = q; saveSettings(); renderHome(); }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
})();
