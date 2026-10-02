/* Murmur — AI with a five-provider chain, plus offline Explain / Expand.
   Order: Gemini → Groq → Cerebras → OpenRouter → Mistral (every one has a free tier; any without a key is skipped).
   Hedged: if the first provider has not answered within 3.5 s, the next one is started too and the first good answer
   wins. Every call carries the whole conversation, so a switch mid-conversation is invisible: the next model just
   continues. If every provider fails, the offline banks answer. */
'use strict';
const CLOUD = 'https://murmur-cloud.jrshaack.workers.dev';
const PROVIDERS = {
  signalcraft: { name: 'Murmur cloud (built in, no key)', builtin: true },
  gemini: { name: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-2.5-flash', keys: 'https://aistudio.google.com/apikey', prefer: (ids) => { const v = id => parseFloat((id.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]); const f = ids.filter(id => /^gemini-\d/.test(id) && /flash/.test(id) && !/-\d{3,}$|image|tts|live|audio|thinking|exp/.test(id)); return [...f.filter(id => !/lite/.test(id)).sort((a, b) => v(b) - v(a)), ...f.filter(id => /lite/.test(id)).sort((a, b) => v(b) - v(a))]; } },
  groq: { name: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile', keys: 'https://console.groq.com/keys', prefer: (ids) => ids.filter(id => /llama-3\.3-70b|gpt-oss-120b|llama-4/.test(id) && !/guard|whisper|tts/.test(id)) },
  cerebras: { name: 'Cerebras', url: 'https://api.cerebras.ai/v1/chat/completions', model: 'llama-3.3-70b', keys: 'https://cloud.cerebras.ai/', prefer: (ids) => ids.filter(id => /llama-3\.3-70b|gpt-oss-120b|qwen-3-235b|llama-4/.test(id)) },
  openrouter: { name: 'OpenRouter (free models)', url: 'https://openrouter.ai/api/v1/chat/completions', model: 'meta-llama/llama-3.3-70b-instruct:free', keys: 'https://openrouter.ai/keys', prefer: (ids) => ids.filter(id => /:free$/.test(id) && /llama-3\.3-70b|deepseek|gemma-3-27b|qwen|mistral/.test(id)) },
  mistral: { name: 'Mistral', url: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-small-latest', keys: 'https://console.mistral.ai/api-keys', prefer: (ids) => ids.filter(id => /^mistral-(small|medium)-latest$/.test(id)) },
};
const CHAIN = ['signalcraft', 'gemini', 'groq', 'cerebras', 'openrouter', 'mistral'];

const Brain = {
  status: {}, // provider -> {ok, ms, err, model}
  key(p) { if (PROVIDERS[p].builtin) return settings.noCloud ? '' : 'builtin'; return (settings.keys && settings.keys[p]) || ''; },
  active() { return CHAIN.filter(p => this.key(p)); },
  clean(t) { return String(t || '').replace(/[*_#`>|]/g, '').replace(/\s+/g, ' ').trim(); },
  async model(p) {
    const P = PROVIDERS[p]; settings.models = settings.models || {};
    if (settings.models[p]) return settings.models[p];
    try {
      const ctl = new AbortController(); setTimeout(() => ctl.abort(), 5000);
      const r = await fetch(P.url.replace(/\/chat\/completions$/, '/models'), { headers: { Authorization: 'Bearer ' + this.key(p) }, signal: ctl.signal });
      if (r.ok) { const j = await r.json(); const ids = (j.data || []).map(m => String(m.id).replace(/^models\//, '')); const pick = P.prefer(ids)[0]; if (pick) { settings.models[p] = pick; saveSettings(); return pick; } }
    } catch (e) { }
    return P.model;
  },
  async one(p, system, messages, signal) {
    const P = PROVIDERS[p]; const t0 = performance.now();
    if (P.builtin) {
      const r = await fetch(CLOUD + '/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, signal, body: JSON.stringify({ system, messages, max_tokens: 420 }) });
      if (!r.ok) throw new Error(P.name + ' ' + r.status);
      const j = await r.json(); const text = this.clean(j.text); if (!text) throw new Error(P.name + ' returned nothing');
      this.status[p] = { ok: true, ms: Math.round(performance.now() - t0), model: j.model }; return { text, provider: p };
    }
    const model = await this.model(p);
    const headers = { 'content-type': 'application/json', Authorization: 'Bearer ' + this.key(p) };
    if (p === 'openrouter') { headers['HTTP-Referer'] = location.origin; headers['X-Title'] = 'Murmur'; }
    const r = await fetch(P.url, { method: 'POST', headers, signal, body: JSON.stringify({ model, max_tokens: 420, temperature: 0.5, messages: [{ role: 'system', content: system }, ...messages] }) });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 160);
      if (r.status === 404 || /model/i.test(body)) { delete (settings.models || {})[p]; saveSettings(); }
      throw new Error(P.name + ' ' + r.status + ' ' + body);
    }
    const j = await r.json(); const text = this.clean((((j.choices || [])[0] || {}).message || {}).content);
    if (!text) throw new Error(P.name + ' returned nothing');
    this.status[p] = { ok: true, ms: Math.round(performance.now() - t0), model };
    return { text, provider: p };
  },
  // hedged chain: start provider 1; at 3.5 s (or on its failure) start the next; first success wins
  async chat(system, messages, { hedgeMs = 3500, totalMs = 20000 } = {}) {
    const list = this.active(); if (!list.length) throw new Error('no AI keys');
    return await new Promise((resolve, reject) => {
      let idx = 0, running = 0, settled = false; const ctls = []; const errs = [];
      const finish = (ok, v) => { if (settled) return; settled = true; clearTimeout(hedge); clearTimeout(total); ctls.forEach(c => { try { c.abort(); } catch (e) { } }); ok ? resolve(v) : reject(new Error(errs.join(' · ') || 'all providers failed')); };
      let hedge = null;
      const launch = () => {
        if (settled || idx >= list.length) { if (!running && !settled) finish(false); return; }
        const p = list[idx++]; running++; const ctl = new AbortController(); ctls.push(ctl);
        clearTimeout(hedge); hedge = setTimeout(launch, hedgeMs);
        this.one(p, system, messages, ctl.signal).then(v => finish(true, v)).catch(e => { running--; this.status[p] = { ok: false, err: String(e.message || e).slice(0, 120) }; errs.push(String(e.message || e).slice(0, 80)); launch(); });
      };
      const total = setTimeout(() => finish(false), totalMs);
      launch();
    });
  },
};

// ---------------------------------------------------------------- offline help: Explain (analogy / ELI5) and Expand (mechanism)
const Help = {
  // ctx: {course, title, text, eli5, deep, expand}
  async explain(ctx, kicker) {
    if (ctx.eli5) return speak(ctx.eli5, kicker + ' · explain');
    const ai = await this.askOnce(ctx, 'Explain the point below like I am five: one everyday analogy, the plainest correct words, under 110 words, and end by tying the analogy back to the real idea.');
    return speak(ai || ('Here is the idea again, more simply. ' + (ctx.expand || ctx.text)), kicker + ' · explain');
  },
  async expand(ctx, kicker) {
    if (ctx.deep) return speak(ctx.deep, kicker + ' · expand');
    const ai = await this.askOnce(ctx, 'Expand on the point below: the mechanism behind it, what it depends on, one worked example with units said in words, and the common misconception. Under 200 words.');
    return speak(ai || ('A little more on that. ' + (ctx.expand || ctx.text)), kicker + ' · expand');
  },
  async askOnce(ctx, instruction) {
    if (!Brain.active().length) return null;
    try { UI.status('Thinking'); return (await Brain.chat(Tutorbot.system(ctx), [{ role: 'user', content: instruction + '\n\nPoint: ' + ctx.text }])).text; } catch (e) { return null; }
  },
  // last-resort offline answer: find the lecture point that best matches the question
  offlineAnswer(q, course) {
    const words = new Set(Parse.norm(q).split(' ').filter(w => w.length > 3)); if (!words.size) return null;
    let best = null, score = 0;
    for (const L of bank.lectures) { if (course && L.course !== course) continue; if (!unlocked(L)) continue;
      for (const s of L.segments) { const t = Parse.norm(s.title + ' ' + s.text); let n = 0; for (const w of words) if (t.includes(w)) n++; if (n > score) { score = n; best = s; } } }
    return score >= 2 ? best : null;
  },
};

const Tutorbot = {
  system(ctx) {
    const c = bank.courses[ctx.course] || {};
    return `You are a spoken tutor for a first-term Electronics Engineering Technology student at SAIT. Course: ${c.name || ctx.course} (${c.long || ''}).
The student is DRIVING and hears you through text-to-speech:
- plain spoken English, no symbols, no lists, no markdown, no notation; say formulas in words and name each quantity and its unit before using numbers;
- short turns: under 90 words unless asked for more; ask one short question back when it helps the student think;
- stay at the level of the material below; if asked beyond it, say so in one clause and answer at an introductory level;
- never invent course rules, dates or marking.
You may be continuing a conversation another assistant started: continue naturally from the last turn, never greet again or restart.
Point being studied — "${ctx.title}": ${ctx.text}
${ctx.deep ? 'Background: ' + ctx.deep : ''}`;
  },
  // full back-and-forth by voice; returns when the student says resume / goes quiet
  async converse(ctx, kicker) {
    kicker = (kicker || courseName(ctx.course)) + ' · AI';
    const turns = [];
    if (!Brain.active().length) {
      await speak('The AI needs at least one free key in settings. Here is the offline explanation instead. ' + (ctx.eli5 || ctx.expand || ctx.text), kicker);
      return;
    }
    await speak('Go ahead, ask me anything about this.', kicker);
    let quiet = 0;
    while (Session.running) {
      const r = await hear(10000);
      if (!r) { quiet++; if (quiet >= 2) break; await speak('Ask a question, or say resume.', kicker); continue; }
      quiet = 0;
      if (r.cmd) {
        if (['resume', 'skip', 'stop'].includes(r.cmd)) break;
        if (r.cmd === 'repeat' && turns.length) { await speak(turns[turns.length - 1].content, kicker); continue; }
        if (r.cmd === 'explain') { await Help.explain(ctx, kicker); continue; }
        if (r.cmd === 'expand') { await Help.expand(ctx, kicker); continue; }
        continue;
      }
      const q = r.alts[0]; UI.heard(q);
      if (/^(no|nope|nothing|that'?s (all|it)|i'?m good|resume|continue|go on|carry on|back to (the )?(lecture|lesson))\b/i.test(q.trim())) break;
      turns.push({ role: 'user', content: q });
      UI.status('Thinking'); UI.stage('…', kicker);
      try {
        const { text } = await Brain.chat(this.system(ctx), turns);
        turns.push({ role: 'assistant', content: text });
        await speak(text, kicker);
      } catch (e) {
        turns.pop();
        const s = Help.offlineAnswer(q, ctx.course);
        await speak(s ? 'I cannot reach the AI right now, but your notes cover this. ' + s.text : 'I cannot reach the AI right now. Let us carry on, and you can ask again later.', kicker);
        if (!s) break;
      }
    }
  },
};
