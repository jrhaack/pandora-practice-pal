/* Murmur shared learner sync v3. No credentials are stored in this document. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MurmurSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = 3,
    FILE = 'murmur-sync.json';
  // Local-only budgeting: one changed upload per minute, idle pulls every five minutes.
  // These are per-client limits; GitHub may also limit the account's unrelated activity.
  const SYNC_POLICY = Object.freeze({
    activeMs: 60000,
    idleMs: 300000,
    retryMinMs: 60000,
    retryMaxMs: 3600000,
    conflictPasses: 3
  });
  const plain = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
  const copy = (x) => JSON.parse(JSON.stringify(x));
  const stable = (x) => JSON.stringify(sort(x));
  function sort(x) {
    if (Array.isArray(x)) return x.map(sort);
    if (!plain(x)) return x;
    const r = {};
    for (const k of Object.keys(x).sort())
      if (!['__proto__', 'constructor', 'prototype'].includes(k)) r[k] = sort(x[k]);
    return r;
  }
  const fresh = () => ({ schema: VERSION, events: {}, records: {} });
  const uuid = () =>
    globalThis.crypto?.randomUUID?.() ||
    'm' +
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2) +
      '-' +
      Math.random().toString(36).slice(2);
  const safeKey = (k) =>
    typeof k === 'string' &&
    k.length > 0 &&
    k.length <= 512 &&
    !['__proto__', 'constructor', 'prototype'].includes(k);
  const str = (x, n = 300) => String(x ?? '').slice(0, n);
  function validate(raw) {
    if (!plain(raw) || raw.schema !== VERSION || !plain(raw.events) || !plain(raw.records))
      throw new Error('Unsupported or damaged Murmur sync file. No cloud data was overwritten.');
    const doc = fresh();
    for (const [id, e] of Object.entries(raw.events)) {
      if (
        !safeKey(id) ||
        !plain(e) ||
        e.id !== id ||
        !Number.isFinite(e.credit) ||
        e.credit < 0 ||
        e.credit > 1 ||
        !Number.isFinite(e.updatedAt) ||
        !Number.isFinite(Date.parse(e.at)) ||
        !e.course ||
        !e.topic
      )
        continue;
      doc.events[id] = {
        id,
        source: str(e.source, 50),
        device: str(e.device, 100),
        questionId: str(e.questionId, 200),
        partId: str(e.partId, 200),
        course: str(e.course, 50),
        topic: str(e.topic, 200),
        credit: e.credit,
        at: e.at,
        updatedAt: e.updatedAt,
        rev: Math.max(1, Math.trunc(e.rev) || 1),
        revision: Math.max(1, Math.trunc(e.revision) || 1),
        tags: Array.isArray(e.tags) ? e.tags.slice(0, 30).map((t) => str(t, 100)) : []
      };
      for (const k of ['status', 'mode'])
        if (typeof e[k] === 'string') doc.events[id][k] = str(e[k], 40);
      for (const k of ['independent', 'assisted', 'revealed', 'selfReported'])
        if (typeof e[k] === 'boolean') doc.events[id][k] = e[k];
      if (Number.isFinite(e.hintsUsed)) doc.events[id].hintsUsed = Math.max(0, e.hintsUsed);
      if (e.deleted === true) doc.events[id].deleted = true;
    }
    for (const [key, r] of Object.entries(raw.records))
      if (
        safeKey(key) &&
        plain(r) &&
        safeKey(r.namespace) &&
        safeKey(r.key) &&
        Number.isFinite(r.updatedAt) &&
        r.value !== undefined
      )
        doc.records[key] = {
          namespace: r.namespace,
          key: r.key,
          value: copy(r.value),
          updatedAt: r.updatedAt,
          rev: Math.max(1, Math.trunc(r.rev) || 1),
          device: str(r.device, 100)
        };
    return doc;
  }
  function winner(a, b) {
    if (!a) return b;
    if (!b) return a;
    for (const k of ['updatedAt', 'rev']) {
      if ((a[k] || 0) !== (b[k] || 0)) return (a[k] || 0) > (b[k] || 0) ? a : b;
    }
    return stable(a) >= stable(b) ? a : b;
  }
  function merge(a, b) {
    a = validate(a);
    b = validate(b);
    const r = fresh();
    for (const k of ['events', 'records'])
      for (const id of new Set([...Object.keys(a[k]), ...Object.keys(b[k])]))
        r[k][id] = copy(winner(a[k][id], b[k][id]));
    return r;
  }
  function summaries(events) {
    const out = {};
    for (const e of events) {
      if (e.deleted) continue;
      const k = e.course + '|' + e.topic;
      const t =
        out[k] ||
        (out[k] = {
          course: e.course,
          topic: e.topic,
          n: 0,
          credit: 0,
          bad: 0,
          independentCorrect: 0,
          guided: 0,
          manual: 0,
          last: 0,
          tags: {}
        });
      t.n++;
      t.credit += e.credit;
      t.bad += 1 - e.credit;
      t.last = Math.max(t.last, Date.parse(e.at) || 0);
      if (e.credit === 1 && e.independent === true && !e.assisted && !e.revealed && !e.selfReported)
        t.independentCorrect++;
      if (e.assisted || e.revealed || e.status === 'guided') t.guided++;
      if (e.selfReported || e.status === 'manual') t.manual++;
      for (const tag of e.tags || []) t.tags[tag] = (t.tags[tag] || 0) + 1;
    }
    for (const t of Object.values(out)) t.score = t.n ? t.credit / t.n : 0;
    return out;
  }
  function encode(s) {
    if (typeof Buffer !== 'undefined') return Buffer.from(s, 'utf8').toString('base64');
    const b = new TextEncoder().encode(s);
    let raw = '';
    for (let i = 0; i < b.length; i += 8192) raw += String.fromCharCode(...b.subarray(i, i + 8192));
    return btoa(raw);
  }
  function decode(s) {
    if (typeof Buffer !== 'undefined') return Buffer.from(s, 'base64').toString('utf8');
    const raw = atob(s.replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0)));
  }
  function create(opts = {}) {
    const appId = str(opts.appId || 'murmur', 50),
      key = 'murmur.sync.v3.' + appId;
    const storage = opts.storage || {
      read: () => {
        try {
          return localStorage.getItem(key);
        } catch {
          return null;
        }
      },
      write: (v) => localStorage.setItem(key, v)
    };
    let doc = fresh(),
      device = uuid(),
      lastSync = 0,
      status = 'Saved on this device',
      dirty = false,
      closed = false,
      revision = 0,
      persistQueue = Promise.resolve(),
      running = null,
      again = false,
      timer = null,
      timerDue = 0,
      interval = null;
    // Persist deadlines beside local data (never in the shared document or with a token).
    let network = {
        repo: '',
        branch: '',
        lastAttempt: 0,
        backoffUntil: 0,
        failures: 0,
        failureKind: ''
      },
      configSeen = '';
    const visible = () => globalThis.document?.visibilityState !== 'hidden',
      online = () => globalThis.navigator?.onLine !== false;
    const off = [];
    const conf = () => {
      const c = typeof opts.config === 'function' ? opts.config() : opts.config || {};
      return { ...c, repo: String(c.repo || '').trim() };
    };
    const emit = () => {
      try {
        opts.onChange?.(api);
      } catch (e) {
        console.warn('Murmur view update failed', e);
      }
    };
    const report = (s) => {
      status = s;
      try {
        opts.onStatus?.({
          status: s,
          lastSync,
          pending: dirty,
          configured: !!(conf().token && conf().enabled !== false)
        });
      } catch {}
    };
    function readSaved(raw) {
      if (!raw) return null;
      const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (j.doc) return { ...j, doc: validate(j.doc) };
      return { doc: validate(j) };
    }
    const ready = (async () => {
      try {
        const x = readSaved(await storage.read());
        if (x) {
          doc = x.doc;
          device = x.device || device;
          lastSync = x.lastSync || 0;
          dirty = !!x.dirty;
          if (plain(x.network))
            network = {
              repo: str(x.network.repo),
              branch: str(x.network.branch),
              lastAttempt: Math.max(0, Number(x.network.lastAttempt) || 0),
              backoffUntil: Math.max(0, Number(x.network.backoffUntil) || 0),
              failures: Math.max(0, Number(x.network.failures) || 0),
              failureKind: str(x.network.failureKind, 20)
            };
        }
      } catch (e) {
        report('Local sync data could not be read; original practice progress is unchanged.');
        throw e;
      }
      emit();
      return api;
    })();
    function persist() {
      const work = async () => {
        const save = async () => {
          try {
            const disk = readSaved(await storage.read());
            if (disk) doc = merge(doc, disk.doc);
          } catch (e) {
            if (e && /Unsupported|damaged/.test(String(e.message))) throw e;
          }
          await storage.write(JSON.stringify({ device, lastSync, dirty, network, doc }));
        };
        if (!opts.storage && globalThis.navigator?.locks?.request)
          await navigator.locks.request(key, save);
        else await save();
      };
      persistQueue = persistQueue.catch(() => {}).then(work);
      return persistQueue;
    }
    async function changed() {
      dirty = true;
      revision++;
      await persist();
      emit();
      schedule();
    }
    // Keep the earliest pending wakeup; repeated answers/focus events cannot create a storm.
    function schedule(ms = 2000) {
      if (closed || !visible() || !online()) return;
      const due = Date.now() + Math.max(0, ms);
      if (timer && timerDue <= due) return;
      clearTimeout(timer);
      timerDue = due;
      timer = setTimeout(
        () => {
          timer = null;
          timerDue = 0;
          sync().catch(() => {});
        },
        Math.min(2147483647, Math.max(0, ms))
      );
    }
    function resetConfig(c) {
      const branch = String(c.branch || ''),
        signature = c.repo + '\n' + branch + '\n' + String(c.token || '');
      if (network.repo !== c.repo || network.branch !== branch) {
        network = {
          repo: c.repo,
          branch,
          lastAttempt: 0,
          backoffUntil: 0,
          failures: 0,
          failureKind: ''
        };
      } else if (configSeen && configSeen !== signature && network.failureKind !== 'rate') {
        network.failures = 0;
        network.backoffUntil = 0;
        network.lastAttempt = 0;
      }
      configSeen = signature;
    }
    function nextSync() {
      return Math.max(
        network.backoffUntil,
        network.lastAttempt
          ? network.lastAttempt + (dirty ? SYNC_POLICY.activeMs : SYNC_POLICY.idleMs)
          : 0
      );
    }
    function limitError(until) {
      const e = new Error('GitHub rate limit · progress queued locally');
      e.rateLimited = true;
      e.retryAt = until;
      return e;
    }
    function stageAttempt(input) {
      const id = input.id || device + ':' + uuid();
      if (!safeKey(id)) throw new Error('Invalid attempt ID');
      const old = doc.events[id];
      const at = input.at ? new Date(input.at).toISOString() : old?.at || new Date().toISOString();
      const e = {
        id,
        source: input.source || appId,
        device,
        questionId: str(input.questionId, 200),
        partId: str(input.partId, 200),
        course: str(input.course, 50),
        topic: str(input.topic, 200),
        credit: Number(input.credit),
        at,
        updatedAt: Math.max(Date.now(), (old?.updatedAt || 0) + 1),
        rev: (old?.rev || 0) + 1,
        revision: input.revision || old?.revision || 1,
        tags: input.tags || []
      };
      for (const k of [
        'status',
        'mode',
        'independent',
        'assisted',
        'revealed',
        'selfReported',
        'hintsUsed',
        'deleted'
      ])
        if (input[k] !== undefined) e[k] = input[k];
      if (old) {
        const comparable = (x) => {
          const y = { ...x };
          delete y.updatedAt;
          delete y.rev;
          delete y.device;
          return stable(y);
        };
        const normalized = validate({ schema: 3, events: { [id]: e }, records: {} }).events[id];
        if (normalized && comparable(old) === comparable(normalized)) return { id, changed: false };
      }
      const clean = validate({ schema: 3, events: { [id]: e }, records: {} }).events[id];
      if (!clean) throw new Error('Attempt requires a course, topic, date and credit from 0 to 1.');
      doc.events[id] = clean;
      return { id, changed: true };
    }
    async function recordAttempt(input) {
      await ready;
      const r = stageAttempt(input);
      if (r.changed) await changed();
      return r.id;
    }
    async function recordAttempts(inputs) {
      await ready;
      let any = false;
      const ids = [];
      for (const input of inputs) {
        const r = stageAttempt(input);
        ids.push(r.id);
        any = any || r.changed;
      }
      if (any) await changed();
      return ids;
    }
    async function putRecords(inputs) {
      await ready;
      if (!Array.isArray(inputs)) throw new Error('Records must be an array');
      const staged = Object.create(null),
        results = [];
      // Validate and stage the whole batch before changing the document; one durable write/notification.
      for (const input of inputs) {
        const { namespace, key: rkey, value } = input || {};
        if (!safeKey(namespace) || !safeKey(rkey)) throw new Error('Invalid record key');
        const k = namespace + '|' + rkey;
        if (!safeKey(k)) throw new Error('Record key is too long');
        const old = staged[k] || doc.records[k];
        if (old && stable(old.value) === stable(value)) {
          results.push(old);
          continue;
        }
        const r = {
          namespace,
          key: rkey,
          value: copy(value),
          updatedAt: Math.max(Date.now(), (old?.updatedAt || 0) + 1),
          rev: (old?.rev || 0) + 1,
          device
        };
        staged[k] = r;
        results.push(r);
      }
      if (Object.keys(staged).length) {
        Object.assign(doc.records, staged);
        await changed();
      }
      return results;
    }
    async function putRecord(namespace, rkey, value) {
      return (await putRecords([{ namespace, key: rkey, value }]))[0];
    }

    function headers(c) {
      return {
        Authorization: 'Bearer ' + c.token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      };
    }
    function base(c) {
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(c.repo))
        throw new Error('Use repository format owner/name.');
      return 'https://api.github.com/repos/' + c.repo;
    }
    // Apply server backoff before every request, including reads within a transaction.
    // A successful final-quota response also blocks the next request until the reset.
    async function req(url, init) {
      if (network.backoffUntil > Date.now()) throw limitError(network.backoffUntil);
      const transport = opts.fetch || globalThis.fetch;
      if (!transport) throw new Error('Network requests are unavailable');
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const tid = setTimeout(() => ctl?.abort(), 20000);
      try {
        const r = await transport(url, { ...init, signal: ctl?.signal });
        const h = (n) => r.headers?.get?.(n),
          retry = h('retry-after'),
          remaining = h('x-ratelimit-remaining'),
          reset = Number(h('x-ratelimit-reset')) * 1000;
        let secondary = false;
        if (r.status === 403 && !retry && remaining !== '0')
          try {
            secondary = /rate limit|secondary|abuse/i.test(String((await r.json()).message || ''));
          } catch {}
        const limited =
          r.status === 429 || (r.status === 403 && (!!retry || secondary)) || remaining === '0';
        if (limited) {
          const now = Date.now(),
            seconds = Number(retry),
            retryAt = retry
              ? Number.isFinite(seconds)
                ? now + Math.max(0, seconds) * 1000
                : Date.parse(retry)
              : 0;
          const until = Math.max(
            now + SYNC_POLICY.retryMinMs,
            Number.isFinite(retryAt) ? retryAt : 0,
            remaining === '0' && Number.isFinite(reset) ? reset + 1000 : 0
          );
          network.backoffUntil = Math.max(network.backoffUntil, until);
          network.failureKind = 'rate';
          if (!r.ok) throw limitError(until);
        }
        return r;
      } finally {
        clearTimeout(tid);
      }
    }
    async function privateRepository(c) {
      const r = await req(base(c), { headers: headers(c), cache: 'no-store' });
      if (!r.ok) throw new Error('GitHub ' + r.status + ' checking repository');
      const info = await r.json();
      if (info.private !== true)
        throw new Error(
          'Murmur requires a private repository for learning records. Choose a private data repository; no progress was uploaded.'
        );
    }
    async function remote(c, path = FILE) {
      const url =
        base(c) + '/contents/' + path + (c.branch ? '?ref=' + encodeURIComponent(c.branch) : '');
      const r = await req(url, { headers: headers(c), cache: 'no-store' });
      if (r.status === 404) return { doc: null, sha: null };
      if (!r.ok) throw new Error('GitHub ' + r.status + ' on read');
      const j = await r.json();
      let content = j.content;
      if (!content && j.sha) {
        const blob = await req(base(c) + '/git/blobs/' + encodeURIComponent(j.sha), {
          headers: headers(c),
          cache: 'no-store'
        });
        if (!blob.ok) throw new Error('GitHub ' + blob.status + ' on blob read');
        content = (await blob.json()).content;
      }
      if (typeof content !== 'string')
        throw new Error('GitHub did not return a readable progress file');
      return { doc: JSON.parse(decode(content)), sha: j.sha };
    }
    // Coalesce concurrent calls. Dirty writes bypass the idle interval, never the active
    // cooldown or a server deadline. All answers are already durable before networking.
    async function sync() {
      await ready;
      if (closed) return status;
      if (running) return running;
      const c = conf();
      if (c.enabled === false || !c.token) {
        report('Saved on this device · connect GitHub to sync');
        return status;
      }
      resetConfig(c);
      if (!visible() || !online()) {
        if (dirty) report('Saved locally · sync resumes when this app is active and online');
        return status;
      }
      const wait = nextSync() - Date.now();
      if (wait > 0) {
        if (dirty)
          report(
            network.backoffUntil > Date.now()
              ? 'GitHub is resting · progress queued locally'
              : 'Saved locally · sync queued'
          );
        schedule(wait);
        return status;
      }
      clearTimeout(timer);
      timer = null;
      timerDue = 0;
      network.lastAttempt = Date.now();
      running = (async () => {
        report('Syncing…');
        try {
          await persist();
          await privateRepository(c);
          // Re-read and union after a conflicting SHA; bound retries and space writes.
          for (let pass = 0; pass < SYNC_POLICY.conflictPasses; pass++) {
            const before = revision;
            const r = await remote(c);
            const rd = r.doc ? validate(r.doc) : fresh();
            const merged = merge(doc, rd);
            const didChange = stable(doc) !== stable(merged);
            doc = merged;
            await persist();
            if (didChange) emit();
            const payload = stable(doc);
            if (r.doc && payload === stable(rd)) {
              dirty = false;
              lastSync = Date.now();
              network.failures = 0;
              await persist();
              report('Synced · ' + new Date(lastSync).toLocaleTimeString());
              return status;
            }
            const body = { message: 'Murmur learner progress [skip ci]', content: encode(payload) };
            if (r.sha) body.sha = r.sha;
            if (c.branch) body.branch = c.branch;
            const w = await req(base(c) + '/contents/' + FILE, {
              method: 'PUT',
              headers: { ...headers(c), 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            });
            if (w.status === 409 || w.status === 422) {
              if (pass + 1 < SYNC_POLICY.conflictPasses)
                await new Promise((resolve) => setTimeout(resolve, 1000 * (pass + 1)));
              continue;
            }
            if (!w.ok) throw new Error('GitHub ' + w.status + ' on write');
            dirty = revision !== before;
            lastSync = Date.now();
            network.failures = 0;
            await persist();
            report(
              dirty
                ? 'Saved · latest answer queued'
                : 'Synced · ' + new Date(lastSync).toLocaleTimeString()
            );
            if (dirty) again = true;
            return status;
          }
          throw new Error('Concurrent changes are still arriving; retrying shortly');
        } catch (e) {
          dirty = true;
          network.failures++;
          network.failureKind = e.rateLimited
            ? 'rate'
            : /private repository|401|403|404/.test(String(e.message))
              ? 'auth'
              : 'network';
          const now = Date.now(),
            delay = Math.min(
              SYNC_POLICY.retryMaxMs,
              SYNC_POLICY.retryMinMs * 2 ** Math.min(network.failures - 1, 6)
            );
          network.backoffUntil = Math.max(network.backoffUntil, now + delay);
          if (/private repository|401|403|404/.test(String(e.message)))
            network.backoffUntil = Math.max(network.backoffUntil, now + SYNC_POLICY.retryMaxMs);
          await persist();
          const msg = e.rateLimited
            ? 'GitHub rate limit · progress queued locally'
            : /private repository/.test(String(e.message))
              ? 'Choose a private data repository · nothing uploaded'
              : /401|403|404/.test(String(e.message))
                ? 'GitHub connection needs attention · progress is saved locally'
                : 'Offline or sync interrupted · progress queued locally';
          report(msg);
          schedule(network.backoffUntil - now);
          throw e;
        }
      })();
      try {
        return await running;
      } finally {
        running = null;
        if (again && !closed) {
          again = false;
          schedule(Math.max(2000, nextSync() - Date.now()));
        }
      }
    }
    // Lifecycle listeners only request a budgeted sync; hidden/offline apps stay local.
    function start() {
      if (interval || closed) return api;
      interval = setInterval(
        () => {
          if (visible() && online()) sync().catch(() => {});
        },
        Math.max(SYNC_POLICY.activeMs, Number(opts.intervalMs) || SYNC_POLICY.activeMs)
      );
      const add = (o, n, f) => {
        o?.addEventListener?.(n, f);
        off.push(() => o?.removeEventListener?.(n, f));
      };
      const go = () => {
        if (visible() && online()) sync().catch(() => {});
      };
      add(globalThis, 'online', go);
      add(globalThis, 'focus', go);
      add(globalThis, 'popstate', go);
      add(globalThis, 'pagehide', () => {
        persist().catch(() => {});
        clearTimeout(timer);
        timer = null;
        timerDue = 0;
      });
      add(globalThis.document, 'visibilitychange', () => {
        if (visible()) go();
        else {
          persist().catch(() => {});
          clearTimeout(timer);
          timer = null;
          timerDue = 0;
        }
      });
      if (!opts.storage)
        add(globalThis, 'storage', (e) => {
          if (e.key === key && e.newValue)
            try {
              const disk = readSaved(e.newValue);
              doc = merge(doc, disk.doc);
              emit();
            } catch {}
        });
      ready.then(() => schedule(200)).catch(() => {});
      return api;
    }
    async function importDocument(x) {
      await ready;
      doc = merge(doc, validate(x));
      await changed();
    }
    function events() {
      return Object.values(doc.events)
        .filter((e) => !e.deleted)
        .map(copy)
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
    }
    function records(namespace) {
      return Object.values(doc.records)
        .filter((r) => !namespace || r.namespace === namespace)
        .map(copy);
    }
    async function readLegacyProgress() {
      await ready;
      const c = conf();
      if (!c.token || c.enabled === false) return null;
      return (await remote(c, 'progress.json')).doc;
    }
    function destroy() {
      closed = true;
      for (const t of [timer, interval]) {
        clearTimeout(t);
        clearInterval(t);
      }
      for (const f of off) f();
      return persist();
    }
    const api = {
      ready,
      recordAttempt,
      recordAttempts,
      putRecord,
      putRecords,
      events,
      records,
      getRecord: (n, k) => copy(doc.records[n + '|' + k]?.value ?? null),
      getRecordMeta: (n, k) => copy(doc.records[n + '|' + k] ?? null),
      topics: () => summaries(events()),
      snapshot: () => copy(doc),
      importDocument,
      sync,
      start,
      destroy,
      readLegacyProgress,
      flushLocal: persist,
      get status() {
        return status;
      },
      get lastSync() {
        return lastSync;
      },
      get pending() {
        return dirty;
      },
      get deviceId() {
        return device;
      }
    };
    return api;
  }
  return { VERSION, FILE, SYNC_POLICY, create, merge, validate, summaries, encode, decode };
});
