/* Murmur — five configurable provider priorities, plus offline Explain / Expand.
   Providers without a key are skipped; the existing Murmur cloud remains an optional final backup.
   Contiguous free-provider groups are hedged: if the first provider has not answered within 3.5 s, the next one is started too and the first good answer
   wins. Every call carries the whole conversation, so a switch mid-conversation is invisible: the next model just
   continues. If every provider fails, the offline banks answer. */
'use strict';
const CLOUD = 'https://murmur-cloud.jrshaack.workers.dev';
const PROVIDERS = {
  signalcraft: { name: 'Murmur cloud (built-in backup, no key)', builtin: true },
  gemini: {
    name: 'Google Gemini',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: 'gemini-2.5-flash',
    keys: 'https://aistudio.google.com/apikey',
    prefer: (ids) => {
      const v = (id) => parseFloat((id.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]);
      const f = ids.filter(
        (id) =>
          /^gemini-\d/.test(id) &&
          /flash/.test(id) &&
          !/-\d{3,}$|image|tts|live|audio|thinking|exp/.test(id)
      );
      return [
        ...f.filter((id) => !/lite/.test(id)).sort((a, b) => v(b) - v(a)),
        ...f.filter((id) => /lite/.test(id)).sort((a, b) => v(b) - v(a))
      ];
    }
  },
  groq: {
    name: 'Groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    keys: 'https://console.groq.com/keys',
    prefer: (ids) =>
      ids.filter(
        (id) => /llama-3\.3-70b|gpt-oss-120b|llama-4/.test(id) && !/guard|whisper|tts/.test(id)
      )
  },
  cerebras: {
    name: 'Cerebras',
    url: 'https://api.cerebras.ai/v1/chat/completions',
    model: 'llama-3.3-70b',
    keys: 'https://cloud.cerebras.ai/',
    prefer: (ids) => ids.filter((id) => /llama-3\.3-70b|gpt-oss-120b|qwen-3-235b|llama-4/.test(id))
  },
  openrouter: {
    name: 'OpenRouter (free models)',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    keys: 'https://openrouter.ai/keys',
    prefer: (ids) =>
      ids.filter(
        (id) => /:free$/.test(id) && /llama-3\.3-70b|deepseek|gemma-3-27b|qwen|mistral/.test(id)
      )
  },
  mistral: {
    name: 'Mistral',
    url: 'https://api.mistral.ai/v1/chat/completions',
    model: 'mistral-small-latest',
    keys: 'https://console.mistral.ai/api-keys',
    prefer: (ids) => ids.filter((id) => /^mistral-(small|medium)-latest$/.test(id))
  },
  openai: {
    name: 'OpenAI · paid API',
    paid: true,
    url: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4.1-mini',
    keys: 'https://platform.openai.com/api-keys'
  },
  anthropic: {
    name: 'Anthropic Claude · paid API',
    paid: true,
    adapter: 'anthropic',
    url: 'https://api.anthropic.com/v1/messages',
    model: 'claude-haiku-4-5-20251001',
    keys: 'https://platform.claude.com/settings/keys'
  },
  deepseek: {
    name: 'DeepSeek · paid API',
    paid: true,
    url: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-flash',
    extra: { thinking: { type: 'disabled' } },
    keys: 'https://platform.deepseek.com/api_keys'
  },
  xai: {
    name: 'xAI Grok · browser connection unavailable',
    paid: true,
    browserAvailable: false,
    unavailableReason:
      'Grok does not currently allow this browser app to send its Authorization header. Choose another provider.',
    url: 'https://api.x.ai/v1/chat/completions',
    model: 'grok-4.7',
    maxTokens: 1024,
    extra: { reasoning_effort: 'low' },
    keys: 'https://console.x.ai/'
  }
};
const CHAIN = ['gemini', 'groq', 'cerebras', 'openrouter', 'mistral', 'signalcraft']; // your keys first, Murmur cloud last

// Settings store provider identities, not keys by slot; reordering cannot lose credentials.
// Keep three selected provider accounts in any free/paid mix. Slot validity is
// separate from key presence; saved keys do not mean a remote account was verified.
const AIChain = {
  paidEnabled() {
    return settings.paidAI === true && settings.paidAIConsent === 1;
  },
  providers() {
    return Object.keys(PROVIDERS).filter((p) => !PROVIDERS[p].builtin);
  },
  defaults() {
    return CHAIN.filter((p) => !PROVIDERS[p].builtin).slice(0, 5);
  },
  accountProviders(slots = this.slots()) {
    return slots.filter(
      (p) =>
        p &&
        PROVIDERS[p] &&
        !PROVIDERS[p].builtin &&
        PROVIDERS[p].browserAvailable !== false &&
        (!PROVIDERS[p].paid || this.paidEnabled())
    );
  },
  keyProviders() {
    return this.accountProviders().filter(
      (p) => typeof settings.keys?.[p] === 'string' && settings.keys[p].trim()
    );
  },
  paidReady() {
    return this.paidEnabled() && this.keyProviders().length >= 3;
  },
  paidBlockReason() {
    return !this.paidEnabled()
      ? 'Paid API requests are disabled.'
      : this.keyProviders().length < 3
        ? 'Configure API keys for at least 3 selected provider accounts, in any free/paid mix, before using paid APIs.'
        : '';
  },
  // Consent permits configuring paid slots; actual usage also needs three keyed
  // selected accounts. Disabling restores eligible defaults but never erases keys.
  setPaidEnabled(enabled, confirmed = false) {
    if (enabled && !confirmed)
      return { ok: false, message: 'Confirm that API usage may charge your own provider account.' };
    settings.paidAI = !!enabled;
    if (enabled) settings.paidAIConsent = 1;
    else Brain.abortPaid();
    settings.aiSlots = this.slots();
    saveSettings();
    return {
      ok: true,
      message: enabled
        ? this.paidReady()
          ? 'Optional paid APIs enabled. Keep at least 3 selected provider account keys configured, in any free/paid mix.'
          : 'Paid options enabled for setup. Configure API keys for at least 3 selected provider accounts, in any free/paid mix, before paid use.'
        : 'Paid API requests disabled. At least 3 free providers remain selected; all saved keys are retained.'
    };
  },
  normalize(input) {
    const valid = this.providers(),
      seen = new Set();
    const slots = Array.from({ length: 5 }, (_, i) => {
      const p = Array.isArray(input) ? input[i] : this.defaults()[i];
      if (
        !valid.includes(p) ||
        seen.has(p) ||
        PROVIDERS[p].browserAvailable === false ||
        (PROVIDERS[p].paid && !this.paidEnabled())
      )
        return '';
      seen.add(p);
      return p;
    });
    // Recover old/malformed settings without displacing eligible choices. When paid
    // access is off, vacant slots regain free defaults; saved credentials stay intact.
    for (const p of this.defaults()) {
      if (this.accountProviders(slots).length >= 3) break;
      if (!slots.includes(p)) slots[slots.indexOf('')] = p;
    }
    return slots;
  },
  slots() {
    return this.normalize(settings.aiSlots);
  },
  init() {
    const slots = this.slots();
    if (JSON.stringify(settings.aiSlots) !== JSON.stringify(slots)) {
      settings.aiSlots = slots;
      saveSettings();
    }
  },
  setSlot(index, provider) {
    const slots = this.slots();
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index > 4 ||
      (provider !== '' && !this.providers().includes(provider))
    )
      return { ok: false, slots, message: 'Choose a provider from this list.' };
    if (provider && PROVIDERS[provider].browserAvailable === false)
      return { ok: false, slots, message: PROVIDERS[provider].unavailableReason };
    if (provider && PROVIDERS[provider].paid && !this.paidEnabled())
      return {
        ok: false,
        slots,
        message: 'Enable optional paid APIs before choosing this provider.'
      };
    const next = slots.map((p, i) => (i !== index && p === provider ? '' : p));
    next[index] = provider;
    if (this.accountProviders(next).length < 3)
      return {
        ok: false,
        slots,
        message:
          'Keep at least 3 providers selected, in any free/paid mix. Fill another empty slot before removing or moving a provider.'
      };
    const moved = provider && slots.includes(provider) && slots[index] !== provider;
    settings.aiSlots = next;
    if (!this.paidReady()) Brain.abortPaid();
    saveSettings();
    return {
      ok: true,
      slots: next,
      message: moved
        ? PROVIDERS[provider].name +
          ' moved to priority ' +
          (index + 1) +
          '; its previous slot is now empty.'
        : 'Provider priorities saved.'
    };
  },
  setKey(provider, value) {
    if (!this.providers().includes(provider))
      return { ok: false, message: 'Choose a provider from this list.' };
    settings.keys = settings.keys || {};
    settings.keys[provider] = String(value || '').trim();
    delete (settings.models || {})[provider];
    // Falling below three selected account keys cancels paid work and blocks later calls.
    if (!this.paidReady()) Brain.abortPaid();
    saveSettings();
    return {
      ok: true,
      message:
        this.paidEnabled() && !this.paidReady()
          ? 'Key saved. ' + this.paidBlockReason()
          : 'Key saved on this device; use Test AI to check the connection.'
    };
  },
  order() {
    return [...this.slots().filter(Boolean), ...(settings.noCloud ? [] : ['signalcraft'])];
  }
};

const Brain = {
  paidController: null,
  abortPaid() {
    this.paidController?.abort();
  },
  status: {}, // provider -> {ok, ms, err, model}
  // Eligibility is recalculated from current settings for every request; key
  // presence is configuration evidence, never a successful connection check.
  key(p) {
    if (
      !PROVIDERS[p] ||
      PROVIDERS[p].browserAvailable === false ||
      (PROVIDERS[p].paid && !AIChain.paidReady())
    )
      return '';
    if (PROVIDERS[p].builtin) return settings.noCloud ? '' : 'builtin';
    return typeof settings.keys?.[p] === 'string' ? settings.keys[p].trim() : '';
  },
  active() {
    return AIChain.order().filter((p) => this.key(p));
  },
  clean(t) {
    return String(t || '')
      .replace(/[*_#`>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  },
  async model(p, signal) {
    const P = PROVIDERS[p];
    if (P.browserAvailable === false) throw new Error(P.unavailableReason);
    if (P.paid) {
      if (!AIChain.paidReady()) throw new Error(AIChain.paidBlockReason());
      return P.model;
    }
    settings.models = settings.models || {};
    if (settings.models[p]) return settings.models[p];
    const ctl = new AbortController(),
      abort = () => ctl.abort(),
      timeout = setTimeout(abort, 5000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) ctl.abort();
    try {
      const r = await fetch(P.url.replace(/\/chat\/completions$/, '/models'), {
        headers: { Authorization: 'Bearer ' + this.key(p) },
        signal: ctl.signal
      });
      if (r.ok) {
        const j = await r.json();
        const ids = (j.data || []).map((m) => String(m.id).replace(/^models\//, ''));
        const pick = P.prefer(ids)[0];
        if (pick) {
          settings.models[p] = pick;
          saveSettings();
          return pick;
        }
      }
    } catch (e) {
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
    return P.model;
  },
  // Send one provider request. The paid mutex spans model selection and network
  // completion; caller cancellation and policy changes share its AbortController.
  async one(p, system, messages, signal) {
    const P = PROVIDERS[p];
    if (P?.browserAvailable === false) throw new Error(P.unavailableReason);
    if (P?.paid && !AIChain.paidReady()) throw new Error(AIChain.paidBlockReason());
    if (!P || !this.key(p))
      throw new Error(P?.paid ? 'Paid API is disabled or has no key.' : 'Provider has no key.');
    if (!P.paid) return this.request(p, system, messages, signal);
    if (this.paidController)
      throw new Error('Another paid request is still running. Wait before trying again.');
    const ctl = new AbortController(),
      abort = () => ctl.abort();
    this.paidController = ctl;
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) ctl.abort();
    try {
      return await this.request(p, system, messages, ctl.signal);
    } finally {
      signal?.removeEventListener('abort', abort);
      this.paidController = null;
    }
  },
  async request(p, system, messages, signal) {
    const P = PROVIDERS[p];
    const t0 = performance.now();
    if (P?.browserAvailable === false) throw new Error(P.unavailableReason);
    if (P?.paid && !AIChain.paidReady()) throw new Error(AIChain.paidBlockReason());
    if (signal?.aborted) throw new Error('AI request cancelled before sending.');
    if (P.builtin) {
      const r = await fetch(CLOUD + '/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({ system, messages, max_tokens: 420 })
      });
      if (!r.ok) throw new Error(P.name + ' ' + r.status);
      const j = await r.json();
      const text = this.clean(j.text);
      if (!text) throw new Error(P.name + ' returned nothing');
      this.status[p] = { ok: true, ms: Math.round(performance.now() - t0), model: j.model };
      return { text, provider: p };
    }
    const model = await this.model(p, signal);
    if (signal?.aborted) throw new Error('AI request cancelled before sending.');
    // Settings can change while model selection is awaiting: recheck immediately before POST.
    if (P.paid && (!AIChain.paidReady() || !this.key(p) || signal?.aborted))
      throw new Error(AIChain.paidBlockReason() || 'Paid request cancelled before sending.');
    const headers = { 'content-type': 'application/json', Authorization: 'Bearer ' + this.key(p) };
    if (P.adapter === 'anthropic') {
      delete headers.Authorization;
      headers['x-api-key'] = this.key(p);
      headers['anthropic-version'] = '2023-06-01';
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    }
    if (p === 'openrouter') {
      headers['HTTP-Referer'] = location.origin;
      headers['X-Title'] = 'Murmur';
    }
    const body =
      P.adapter === 'anthropic'
        ? { model, max_tokens: 420, system, messages }
        : {
            model,
            max_tokens: P.maxTokens || 420,
            ...(P.paid ? {} : { temperature: 0.5 }),
            messages: [{ role: 'system', content: system }, ...messages],
            ...P.extra
          };
    const r = await fetch(P.url, { method: 'POST', headers, signal, body: JSON.stringify(body) });
    if (!r.ok) {
      if (P.paid) {
        const error = new Error(P.name + ' returned HTTP ' + r.status);
        error.safeToFallback = [400, 401, 402, 403, 404, 422, 429].includes(r.status);
        throw error;
      }
      const body = (await r.text()).slice(0, 160);
      if (r.status === 404 || /model/i.test(body)) {
        delete (settings.models || {})[p];
        saveSettings();
      }
      throw new Error(P.name + ' ' + r.status + ' ' + body);
    }
    const j = await r.json();
    const text = this.clean(
      P.adapter === 'anthropic'
        ? (j.content || [])
            .filter((x) => x.type === 'text')
            .map((x) => x.text)
            .join(' ')
        : (((j.choices || [])[0] || {}).message || {}).content
    );
    if (!text) throw new Error(P.name + ' returned nothing');
    this.status[p] = { ok: true, ms: Math.round(performance.now() - t0), model };
    return { text, provider: p };
  },
  // Mixed chains preserve configured order. Free groups race at the usual hedge
  // interval; paid requests start only after that group's requests have settled.
  // A paid timeout/network error may already have been processed: stop, do not charge twice.
  async sequential(list, system, messages, totalMs, hedgeMs, signal) {
    const ctl = new AbortController(),
      deadline = performance.now() + totalMs;
    let stop;
    const abort = () => ctl.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const aborted = new Promise((_, reject) => {
      stop = () => reject(new Error('AI request timed out or was cancelled.'));
      ctl.signal.addEventListener('abort', stop, { once: true });
    });
    const timer = setTimeout(abort, totalMs),
      errors = [];
    try {
      if (signal?.aborted) throw new Error('AI request cancelled.');
      for (let index = 0; index < list.length; ) {
        if (ctl.signal.aborted || performance.now() >= deadline)
          throw new Error('AI request timed out.');
        const p = list[index];
        if (!this.key(p)) {
          index++;
          continue;
        }
        if (!PROVIDERS[p].paid) {
          const group = [];
          while (index < list.length && !PROVIDERS[list[index]].paid) {
            if (this.key(list[index])) group.push(list[index]);
            index++;
          }
          const remaining = Math.max(0, deadline - performance.now());
          // Give every free priority a hedge window, while retaining the one overall deadline.
          const budget = Math.min(remaining, Math.max(1, hedgeMs) * group.length);
          try {
            return await Promise.race([
              this.hedged(group, system, messages, {
                hedgeMs,
                totalMs: budget,
                signal: ctl.signal,
                waitForAbort: true
              }),
              aborted
            ]);
          } catch (e) {
            errors.push(String(e.message || e));
            if (ctl.signal.aborted) throw e;
          }
          continue;
        }
        index++;
        try {
          return await Promise.race([this.one(p, system, messages, ctl.signal), aborted]);
        } catch (e) {
          this.status[p] = { ok: false, err: String(e.message || e).slice(0, 120) };
          errors.push(this.status[p].err);
          if (ctl.signal.aborted || !e.safeToFallback)
            throw new Error(
              'Paid request interrupted. It may have been processed; no automatic second paid request was sent.'
            );
        }
      }
      throw new Error(errors.join(' · ') || 'No AI provider is ready.');
    } finally {
      clearTimeout(timer);
      ctl.signal.removeEventListener('abort', stop);
      signal?.removeEventListener('abort', abort);
      ctl.abort();
    }
  },
  // Internal free-only race. Cancelling aborts both model discovery and generation.
  // Mixed routing additionally waits for request settlement before entering a paid slot.
  hedged(list, system, messages, { hedgeMs, totalMs, signal, waitForAbort = false }) {
    return new Promise((resolve, reject) => {
      let idx = 0,
        running = 0,
        settled = false;
      const ctls = [],
        pending = [],
        errs = [];
      const parentAbort = () => {
        errs.push('AI request cancelled.');
        finish(false);
      };
      const finish = (ok, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(hedge);
        clearTimeout(total);
        signal?.removeEventListener('abort', parentAbort);
        ctls.forEach((c) => {
          try {
            c.abort();
          } catch (e) {}
        });
        const deliver = () =>
          ok ? resolve(v) : reject(new Error(errs.join(' · ') || 'all providers failed'));
        if (waitForAbort) Promise.allSettled(pending).then(deliver);
        else deliver();
      };
      let hedge = null;
      const launch = () => {
        if (settled || idx >= list.length) {
          if (!running && !settled) finish(false);
          return;
        }
        const p = list[idx++];
        running++;
        const ctl = new AbortController();
        ctls.push(ctl);
        clearTimeout(hedge);
        hedge = setTimeout(launch, hedgeMs);
        const task = this.one(p, system, messages, ctl.signal);
        pending.push(task);
        task
          .then((v) => finish(true, v))
          .catch((e) => {
            running--;
            this.status[p] = { ok: false, err: String(e.message || e).slice(0, 120) };
            errs.push(String(e.message || e).slice(0, 80));
            launch();
          });
      };
      const total = setTimeout(() => finish(false), totalMs);
      signal?.addEventListener('abort', parentAbort, { once: true });
      if (signal?.aborted) parentAbort();
      else launch();
    });
  },
  // Public contract: whole conversation in, first usable response out. One 20-second
  // default deadline covers all priorities. Optional AbortSignal cancels the entire chain.
  // All-free routing retains its original 3.5-second hedging; sync never calls this API.
  async chat(system, messages, { hedgeMs = 3500, totalMs = 20000, signal } = {}) {
    const list = this.active();
    if (!list.length) throw new Error('no AI keys');
    if (list.some((p) => PROVIDERS[p].paid))
      return this.sequential(list, system, messages, totalMs, hedgeMs, signal);
    return this.hedged(list, system, messages, { hedgeMs, totalMs, signal });
  }
};

// ---------------------------------------------------------------- offline help: Explain (analogy / ELI5) and Expand (mechanism)
const Help = {
  // ctx: {course, title, text, eli5, deep, expand}
  async explain(ctx, kicker) {
    if (ctx.eli5) return speak(ctx.eli5, kicker + ' · explain');
    const ai = await this.askOnce(
      ctx,
      'Explain the point below like I am five: one everyday analogy, the plainest correct words, under 110 words, and end by tying the analogy back to the real idea.'
    );
    return speak(
      ai || 'Here is the idea again, more simply. ' + (ctx.expand || ctx.text),
      kicker + ' · explain'
    );
  },
  async expand(ctx, kicker) {
    if (ctx.deep) return speak(ctx.deep, kicker + ' · expand');
    const ai = await this.askOnce(
      ctx,
      'Expand on the point below: the mechanism behind it, what it depends on, one worked example with units said in words, and the common misconception. Under 200 words.'
    );
    return speak(ai || 'A little more on that. ' + (ctx.expand || ctx.text), kicker + ' · expand');
  },
  async askOnce(ctx, instruction) {
    if (!Brain.active().length) return null;
    try {
      UI.status('Thinking');
      return (
        await Brain.chat(Tutorbot.system(ctx), [
          { role: 'user', content: instruction + '\n\nPoint: ' + ctx.text }
        ])
      ).text;
    } catch (e) {
      return null;
    }
  },
  // last-resort offline answer: find the lecture point that best matches the question
  offlineAnswer(q, course) {
    const words = new Set(
      Parse.norm(q)
        .split(' ')
        .filter((w) => w.length > 3)
    );
    if (!words.size) return null;
    let best = null,
      score = 0;
    for (const L of bank.lectures) {
      if (course && L.course !== course) continue;
      if (!unlocked(L)) continue;
      for (const s of L.segments) {
        const t = Parse.norm(s.title + ' ' + s.text);
        let n = 0;
        for (const w of words) if (t.includes(w)) n++;
        if (n > score) {
          score = n;
          best = s;
        }
      }
    }
    return score >= 2 ? best : null;
  }
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
      await speak(
        'No AI provider is ready in settings. Here is the offline explanation instead. ' +
          (ctx.eli5 || ctx.expand || ctx.text),
        kicker
      );
      return;
    }
    await speak('Go ahead, ask me anything about this.', kicker);
    let quiet = 0;
    while (Session.running) {
      const r = await hear(10000);
      if (!r) {
        quiet++;
        if (quiet >= 2) break;
        await speak('Ask a question, or say resume.', kicker);
        continue;
      }
      quiet = 0;
      if (r.cmd) {
        if (['resume', 'skip', 'stop'].includes(r.cmd)) break;
        if (r.cmd === 'repeat' && turns.length) {
          await speak(turns[turns.length - 1].content, kicker);
          continue;
        }
        if (r.cmd === 'explain') {
          await Help.explain(ctx, kicker);
          continue;
        }
        if (r.cmd === 'expand') {
          await Help.expand(ctx, kicker);
          continue;
        }
        continue;
      }
      const q = r.alts[0];
      UI.heard(q);
      if (
        /^(no|nope|nothing|that'?s (all|it)|i'?m good|resume|continue|go on|carry on|back to (the )?(lecture|lesson))\b/i.test(
          q.trim()
        )
      )
        break;
      turns.push({ role: 'user', content: q });
      UI.status('Thinking');
      UI.stage('…', kicker);
      try {
        const { text } = await Brain.chat(this.system(ctx), turns);
        turns.push({ role: 'assistant', content: text });
        await speak(text, kicker);
      } catch (e) {
        turns.pop();
        const s = Help.offlineAnswer(q, ctx.course);
        await speak(
          s
            ? 'I cannot reach the AI right now, but your notes cover this. ' + s.text
            : 'I cannot reach the AI right now. Let us carry on, and you can ask again later.',
          kicker
        );
        if (!s) break;
      }
    }
  }
};
