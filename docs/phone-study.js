/* Bridges existing phone progress to Murmur's shared private learning record. */
(function (root) {
  'use strict';
  function create(options) {
    const settings = options.settings,
      progress = options.progress;
    let client = null,
      ready = false,
      suppress = false,
      timer = null,
      paintTimer = null,
      status = 'Saved on this phone · private sync is not connected',
      capturing = Promise.resolve(),
      cachedProfile = null,
      cachedMinute = -1;
    const fingerprints = new Map(),
      off = [];
    const notify = () => {
      clearTimeout(paintTimer);
      paintTimer = setTimeout(() => options.onChange?.(), 50);
    };
    const report = (s) => {
      status = s;
      options.onStatus?.(s);
    };
    function apply(api) {
      if (!ready) return;
      cachedProfile = null;
      const resetAt = Number(api.getRecord('phone.meta', 'resetAt')) || 0;
      if (resetAt > (progress.resetAt || 0)) {
        for (const name of ['items', 'lessons', 'lectures', 'topics'])
          for (const [key, value] of Object.entries(progress[name] || {}))
            if (valueTime(name, value) <= resetAt) delete progress[name][key];
        progress.sessions = (progress.sessions || []).filter(
          (x) => valueTime('sessions', x) > resetAt
        );
        progress.resetAt = resetAt;
      }
      const incoming = { items: {}, lessons: {}, lectures: {}, topics: {}, sessions: [] };
      for (const name of ['items', 'lessons', 'lectures', 'topics', 'sessions'])
        for (const rec of api.records('phone.' + name)) {
          if (resetAt && valueTime(name, rec.value) <= resetAt) continue;
          if (name === 'sessions') incoming.sessions.push(rec.value);
          else incoming[name][rec.key] = rec.value;
        }
      suppress = true;
      try {
        options.mergeLegacy?.(incoming);
      } finally {
        suppress = false;
      }
      notify();
    }
    function valueTime(name, value) {
      return (
        Number(
          value && (name === 'sessions' ? value.t : name === 'lessons' ? value.done : value.last)
        ) || 0
      );
    }
    async function init() {
      if (!root.MurmurSync || !root.MurmurAdaptive) {
        report('Shared learning tools could not load. Existing phone progress is safe.');
        return;
      }
      client = root.MurmurSync.create({
        appId: 'murmur-phone',
        config: () => ({
          repo: settings.syncRepo || '',
          token: settings.syncToken || '',
          enabled: settings.syncEnabled === true
        }),
        onChange: apply,
        onStatus: (s) => report(s.status)
      });
      try {
        await client.ready;
        ready = true;
        apply(client);
        await capture();
        client.start();
        for (const [target, event] of [
          [root, 'pagehide'],
          [root, 'popstate'],
          [root.document, 'visibilitychange']
        ]) {
          const flush = () =>
            capture()
              .then(() => client.sync())
              .catch(() => {});
          target?.addEventListener?.(event, flush);
          off.push(() => target?.removeEventListener?.(event, flush));
        }
        notify();
      } catch (e) {
        report(
          'Shared learning storage is unavailable; export your current phone history before closing.'
        );
      }
    }
    function capture() {
      if (!ready || suppress || !client) return Promise.resolve();
      const snapshot = {};
      for (const name of ['items', 'lessons', 'lectures', 'topics'])
        snapshot[name] = JSON.parse(JSON.stringify(progress[name] || {}));
      snapshot.sessions = JSON.parse(JSON.stringify(progress.sessions || []));
      capturing = capturing
        .catch(() => {})
        .then(async () => {
          const batch = [],
            marks = [];
          for (const name of ['items', 'lessons', 'lectures', 'topics', 'sessions']) {
            const entries =
              name === 'sessions'
                ? snapshot.sessions.map((x) => [String(x.t), x])
                : Object.entries(snapshot[name]);
            for (const [key, value] of entries) {
              const fp = name + '|' + key,
                text = JSON.stringify(value);
              if (fingerprints.get(fp) === text) continue;
              batch.push({ namespace: 'phone.' + name, key, value });
              marks.push([fp, text]);
            }
          }
          if (batch.length) await client.putRecords(batch);
          for (const [fp, text] of marks) fingerprints.set(fp, text);
        });
      return capturing;
    }
    function queueProgress() {
      if (suppress) return;
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          capture().catch(() =>
            report(
              'Could not queue a progress copy; export your current phone history before closing.'
            )
          ),
        500
      );
    }
    function events() {
      return client ? client.events() : [];
    }
    function catalog() {
      const b = options.bank();
      return b
        ? (b.items || []).map((i) => ({
            id: i.id,
            course: i.course,
            topic: i.topic,
            title: i.q,
            unlock: i.unlock,
            available: options.unlocked ? options.unlocked(i) : true
          }))
        : [];
    }
    function profile() {
      const minute = Math.floor(Date.now() / 60000);
      if (cachedProfile && cachedMinute === minute) return cachedProfile;
      cachedMinute = minute;
      return (cachedProfile = root.MurmurAdaptive
        ? root.MurmurAdaptive.summarize(events())
        : {
            topics: [],
            byTopic: {},
            items: {},
            totals: {
              independentAttempts: 0,
              independentCorrect: 0,
              guided: 0,
              revealed: 0,
              manual: 0
            }
          });
    }
    function recommendations(course, limit = 3, exclude = new Set()) {
      return root.MurmurAdaptive
        ? root.MurmurAdaptive.recommend(
            events(),
            catalog().filter((i) => !exclude.has(i.id)),
            { course, limit }
          )
        : [];
    }
    async function record(item, outcome) {
      if (!client || !ready) return;
      const e = {
        id: outcome.id,
        questionId: item.id,
        course: item.course,
        topic: item.topic,
        credit: outcome.correct ? 1 : 0,
        status:
          outcome.status ||
          (outcome.revealed
            ? 'revealed'
            : outcome.correct
              ? outcome.assisted
                ? 'guided'
                : 'mastered'
              : 'missed'),
        independent: !outcome.assisted && !outcome.revealed,
        assisted: !!outcome.assisted,
        revealed: !!outcome.revealed,
        mode: outcome.mode || 'tutor',
        tags: outcome.tags || [],
        at: Date.now()
      };
      try {
        const id = await client.recordAttempt(e);
        notify();
        return id;
      } catch (err) {
        report('Could not add shared evidence. Export your current phone history before closing.');
      }
    }
    function focusBoost(course, topic) {
      if (!root.MurmurAdaptive) return 0;
      const p = profile(),
        key = course + '|' + root.MurmurAdaptive.canonicalTopic(course, topic),
        t = p.byTopic[key];
      return !t
        ? 0
        : t.state === 'needs-work'
          ? 4
          : t.isDue
            ? 3
            : t.state === 'developing'
              ? 1.5
              : 0;
    }
    async function sync() {
      if (!client) {
        await init();
      }
      if (!client) return status;
      await capture();
      return client.sync();
    }
    async function resetPhoneHistory() {
      if (client && ready) await client.putRecord('phone.meta', 'resetAt', Date.now());
      fingerprints.clear();
      cachedProfile = null;
    }
    function exportData() {
      return {
        version: 1,
        phoneProgress: progress,
        sharedLearning: client ? client.snapshot() : null
      };
    }
    async function destroy() {
      clearTimeout(timer);
      clearTimeout(paintTimer);
      await capturing;
      for (const remove of off) remove();
      if (client) await client.destroy();
    }
    return {
      init,
      record,
      events,
      profile,
      recommendations,
      focusBoost,
      queueProgress,
      capture,
      sync,
      exportData,
      resetPhoneHistory,
      destroy,
      get status() {
        return status;
      },
      get client() {
        return client;
      }
    };
  }
  root.MurmurPhoneStudy = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
})(typeof window === 'undefined' ? globalThis : window);
