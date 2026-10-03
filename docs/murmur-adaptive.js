/* Murmur adaptive study policy v1. Pure/deterministic, no network or storage.
 * Evidence, not a diagnostic test: confidence describes amount/diversity of observed work.
 * A topic's first independently graded attempt per question/part/UTC day counts toward
 * retention. Immediate retries, hints, reveals, lecture checks and self-report do not
 * establish independent mastery. See POLICY for the transparent thresholds. */
(function (root) {
  'use strict';
  const DAY = 86400000,
    MINUTE = 60000;
  const POLICY = Object.freeze({
    version: 1,
    independentFloor: 6,
    distinctItemFloor: 3,
    distinctDayFloor: 2,
    minSpanHours: 20,
    strongAccuracy: 0.85,
    decayDays: 30,
    intervalDays: [1, 3, 7, 14, 30],
    sameItemCooldownMinutes: 10
  });
  const DIGI_ALIASES = {
    'Karnaugh maps': 'Boolean algebra & simplification',
    'Boolean simplification': 'Boolean algebra & simplification',
    'Boolean laws and truth tables': 'Boolean algebra & simplification',
    'De Morgan’s theorem': 'Boolean algebra & simplification',
    "De Morgan's theorem": 'Boolean algebra & simplification',
    'Bubble pushing': 'Boolean algebra & simplification',
    'Universal NOR gates': 'Boolean algebra & simplification',
    'Universal NAND gates': 'Boolean algebra & simplification',
    'AND–OR–INVERT implementation': 'Boolean algebra & simplification',
    'Logic design from requirements': 'Boolean algebra & simplification',
    'Combinational logic': 'Boolean algebra & simplification',
    'SOP truth tables': 'Boolean algebra & simplification',
    'Circuit to Boolean expression': 'Boolean algebra & simplification',
    'SOP truth-table construction': 'Boolean algebra & simplification',
    'Fast SOP evaluation': 'Boolean algebra & simplification',
    'Timing diagrams': 'Logic gates, truth tables & timing',
    'Truth tables': 'Logic gates, truth tables & timing',
    'Logic gates': 'Logic gates, truth tables & timing',
    'XOR/XNOR': 'Logic gates, truth tables & timing',
    Parity: 'Logic gates, truth tables & timing',
    'Exclusive gates': 'Logic gates, truth tables & timing',
    Comparators: 'Logic gates, truth tables & timing',
    'Universal gates': 'Boolean algebra & simplification',
    'IC pinouts and wiring': 'Logic families, TTL & ICs',
    Troubleshooting: 'Logic families, TTL & ICs',
    'Exclusive-OR and exclusive-NOR': 'Logic gates, truth tables & timing',
    'Binary arithmetic': 'Number systems & codes',
    'Number systems': 'Number systems & codes',
    'Base conversions': 'Number systems & codes',
    'Binary codes': 'Number systems & codes',
    'Decimal/binary conversion': 'Number systems & codes',
    Hexadecimal: 'Number systems & codes',
    'Gate decomposition and schematic annotation': 'Schematic drawing standards',
    'Schematic conventions': 'Schematic drawing standards',
    'Hardware construction and fault isolation': 'Switches, relays & logic inputs',
    'Explain and demonstrate circuit behavior': 'Switches, relays & logic inputs'
  };
  const DEFAULT_PREREQUISITES = {
    'DIGI210|Boolean algebra & simplification': ['DIGI210|Logic gates, truth tables & timing'],
    'DIGI210|Logic gates, truth tables & timing': ['DIGI210|Digital signals & timing'],
    'MATH237|Exponential & logarithmic equations': ['MATH237|Logarithms & exponential functions'],
    'MATH237|Trigonometric equations': ['MATH237|Trig ratios, special triangles & reference angles']
  };
  function time(v) {
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'string' && v.trim() !== '')
      return /^\d+(\.\d+)?$/.test(v) ? Number(v) : Date.parse(v);
    return typeof v === 'number' ? v : NaN;
  }
  function clock(o) {
    let n = time(o && o.now);
    return Number.isFinite(n) && n >= 0 ? n : Date.now();
  }
  function str(v) {
    return typeof v === 'string' ? v.trim() : '';
  }
  function finite(v, f = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : f;
  }
  function canonicalTopic(course, topic, aliases) {
    const c = str(course),
      t = str(topic);
    const key = c + '|' + t;
    if (aliases && Object.prototype.hasOwnProperty.call(aliases, key))
      return str(aliases[key]) || t;
    if (aliases && Object.prototype.hasOwnProperty.call(aliases, t)) return str(aliases[t]) || t;
    return c === 'DIGI210' && Object.prototype.hasOwnProperty.call(DIGI_ALIASES, t)
      ? DIGI_ALIASES[t]
      : t;
  }
  function topicKey(c, t) {
    return c + '|' + t;
  }
  function itemKey(e) {
    return [e.course, e.questionId, e.partId || ''].join('|');
  }
  function confidence(n, items, days) {
    return Math.min(1, n / 10, items / 4, days / 3);
  }
  function eventId(e, index) {
    return (
      str(e.id) ||
      [
        'legacy',
        str(e.source) || str(e.appId),
        str(e.course),
        str(e.questionId),
        str(e.partId),
        String(e.at),
        str(e.status),
        String(e.credit)
      ].join('|')
    );
  }
  function normalized(input, options) {
    const now = clock(options),
      dedup = new Map();
    let ignored = 0;
    for (const raw of Array.isArray(input) ? input : []) {
      if (!raw || typeof raw !== 'object' || raw.deleted === true) {
        ignored++;
        continue;
      }
      const at = time(raw.at),
        course = str(raw.course),
        rawTopic = str(raw.topic),
        questionId = str(raw.questionId) || str(raw.itemId);
      if (
        !Number.isFinite(at) ||
        at < 0 ||
        at > now + 5 * MINUTE ||
        !course ||
        !rawTopic ||
        !questionId
      ) {
        ignored++;
        continue;
      }
      const e = {
        ...raw,
        at: Math.min(at, now),
        course,
        rawTopic,
        topic: canonicalTopic(course, rawTopic, options && options.aliases),
        questionId,
        partId: str(raw.partId),
        id: eventId(raw),
        revision: Math.max(0, finite(raw.revision)),
        updatedAt: time(raw.updatedAt)
      };
      e.key = topicKey(course, e.topic);
      e.itemKey = itemKey(e);
      e.tags = Array.isArray(raw.tags)
        ? [
            ...new Set(
              raw.tags
                .filter((t) => typeof t === 'string')
                .map((t) => t.trim())
                .filter(Boolean)
            )
          ].slice(0, 20)
        : [];
      const s = str(raw.status).toLowerCase();
      e.status = s;
      e.credit =
        typeof raw.credit === 'number' &&
        Number.isFinite(raw.credit) &&
        raw.credit >= 0 &&
        raw.credit <= 1
          ? raw.credit
          : null;
      e.manual =
        raw.selfReported === true || ['manual', 'self-reported', 'self_reported'].includes(s);
      e.revealed = raw.revealed === true || ['revealed', 'reveal', 'shown'].includes(s);
      e.guided =
        raw.assisted === true ||
        finite(raw.hintsUsed) > 0 ||
        ['guided', 'hinted', 'retry'].includes(s) ||
        ['lecture', 'lecture-check', 'immediate-review'].includes(str(raw.mode));
      e.independent =
        raw.independent === true &&
        !e.manual &&
        !e.revealed &&
        !e.guided &&
        e.credit !== null &&
        !['skip', 'skipped', 'viewed', 'reading', 'ungraded'].includes(s);
      const prev = dedup.get(e.id);
      const rank = (x) => [
        x.revision,
        Number.isFinite(x.updatedAt) ? x.updatedAt : x.at,
        JSON.stringify(x)
      ];
      if (!prev) dedup.set(e.id, e);
      else {
        let a = rank(e),
          b = rank(prev);
        if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2]))))
          dedup.set(e.id, e);
      }
    }
    // At a clock tie, retain a real miss, apply help before a success, then apply feedback.
    const tieRank = (e) =>
      e.mode === 'answer-feedback'
        ? 3
        : e.independent && e.credit < 1
          ? 0
          : e.guided || e.revealed
            ? 1
            : 2;
    return {
      events: [...dedup.values()].sort(
        (a, b) => a.at - b.at || tieRank(a) - tieRank(b) || a.id.localeCompare(b.id)
      ),
      ignored,
      now
    };
  }
  function summarize(input, options = {}) {
    const { events, ignored, now } = normalized(input, options),
      byTopic = Object.create(null),
      items = Object.create(null),
      counted = new Set(),
      assistanceAt = new Map();
    for (const e of events) {
      const lastHelp = assistanceAt.get(e.itemKey);
      if (e.independent && lastHelp !== undefined && e.at - lastHelp < DAY) {
        e.independent = false;
        e.guided = true;
      }
      if (e.guided || e.revealed) assistanceAt.set(e.itemKey, e.at);
      let t = byTopic[e.key];
      if (!t)
        t = byTopic[e.key] = {
          key: e.key,
          course: e.course,
          topic: e.topic,
          rawTopics: [],
          attempts: 0,
          independentAttempts: 0,
          independentCorrect: 0,
          guided: 0,
          revealed: 0,
          manual: 0,
          ungraded: 0,
          errors: [],
          lastAt: 0,
          dueAt: null,
          _evidence: [],
          _items: new Set(),
          _days: new Set(),
          _errorTags: new Map()
        };
      let it = items[e.itemKey];
      if (!it)
        it = items[e.itemKey] = {
          key: e.itemKey,
          questionId: e.questionId,
          partId: e.partId,
          course: e.course,
          topic: e.topic,
          attempts: 0,
          lastAt: 0,
          dueAt: null,
          streak: 0,
          independentAttempts: 0,
          needsRepair: false,
          lastStatus: e.status
        };
      t.attempts++;
      t.lastAt = Math.max(t.lastAt, e.at);
      if (!t.rawTopics.includes(e.rawTopic)) t.rawTopics.push(e.rawTopic);
      it.attempts++;
      it.lastAt = Math.max(it.lastAt, e.at);
      it.lastStatus = e.status;
      if (e.manual) t.manual++;
      else if (e.revealed) t.revealed++;
      else if (e.guided) t.guided++;
      else if (!e.independent) t.ungraded++;
      if (
        e.credit !== null &&
        e.credit < 1 &&
        !e.manual &&
        !e.revealed &&
        (e.independent || e.guided)
      )
        for (const tag of e.tags) t._errorTags.set(tag, (t._errorTags.get(tag) || 0) + 1);
      const slot = e.itemKey + '|' + Math.floor(e.at / DAY);
      if (e.independent && !counted.has(slot)) {
        counted.add(slot);
        const good = e.credit >= 0.999;
        t.independentAttempts++;
        if (good) t.independentCorrect++;
        t._evidence.push({ at: e.at, credit: e.credit, good });
        t._items.add(e.course + '|' + e.questionId);
        t._days.add(Math.floor(e.at / DAY));
        it.independentAttempts++;
        it.streak = good ? it.streak + 1 : 0;
        it.needsRepair = !good;
        it.dueAt =
          e.at +
          (good
            ? POLICY.intervalDays[Math.min(it.streak - 1, POLICY.intervalDays.length - 1)] * DAY
            : 15 * MINUTE);
      } else if (
        e.credit !== null &&
        e.credit < 0.999 &&
        !e.manual &&
        !e.revealed &&
        (e.independent ||
          (e.guided && ['incorrect', 'missed', 'wrong', 'failed'].includes(e.status)))
      ) {
        // Graded misses prompt repair even with help; support-only events are not mistakes.
        it.needsRepair = true;
        it.streak = 0;
        const next = e.at + 15 * MINUTE;
        it.dueAt = it.dueAt === null ? next : Math.min(it.dueAt, next);
      } else if (e.guided || e.revealed) {
        // Assistance flags a need for a later fresh retrieval attempt; it never extends an interval.
        const next = e.at + DAY;
        it.dueAt = it.dueAt === null ? next : Math.min(it.dueAt, next);
      }
    }
    for (const t of Object.values(byTopic)) {
      let w = 0,
        s = 0;
      for (const e of t._evidence) {
        const ew = Math.pow(0.5, Math.max(0, now - e.at) / (POLICY.decayDays * DAY));
        w += ew;
        s += ew * e.credit;
      }
      t.distinctItems = t._items.size;
      t.distinctDays = t._days.size;
      t.accuracy = t.independentAttempts ? t.independentCorrect / t.independentAttempts : null;
      t.recentAccuracy = w ? s / w : null;
      t.estimate = w ? (s + 1) / (w + 2) : null;
      t.confidence = confidence(t.independentAttempts, t.distinctItems, t.distinctDays);
      t.confidenceLabel =
        t.confidence >= 0.7
          ? 'substantial evidence'
          : t.confidence >= 0.4
            ? 'growing evidence'
            : 'limited evidence';
      const recent = t._evidence.slice(-4),
        recentErrors = recent.filter((e) => !e.good).length;
      t.repairsNeeded = Object.values(items).filter(
        (i) => i.course === t.course && i.topic === t.topic && i.needsRepair
      ).length;
      const enough =
        t.independentAttempts >= POLICY.independentFloor &&
        t.distinctItems >= POLICY.distinctItemFloor &&
        t.distinctDays >= POLICY.distinctDayFloor &&
        t._evidence[t._evidence.length - 1].at - t._evidence[0].at >= POLICY.minSpanHours * 3600000;
      t.state = t.repairsNeeded
        ? 'needs-work'
        : !t.independentAttempts
          ? t.guided || t.revealed
            ? 'needs-work'
            : 'insufficient-evidence'
          : recentErrors >= 2 || (t.independentAttempts >= 3 && t.recentAccuracy < 0.6)
            ? 'needs-work'
            : enough &&
                t.recentAccuracy >= POLICY.strongAccuracy &&
                recent.slice(-2).every((e) => e.good)
              ? 'strong'
              : t.independentAttempts < 3
                ? 'insufficient-evidence'
                : 'developing';
      t.errors = [...t._errorTags]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
      const due = Object.values(items)
        .filter((i) => i.course === t.course && i.topic === t.topic && i.dueAt !== null)
        .map((i) => i.dueAt);
      t.dueAt = due.length ? Math.min(...due) : null;
      t.isDue = t.dueAt !== null && t.dueAt <= now;
      t.reason = t.repairsNeeded
        ? `${t.repairsNeeded} question ${t.repairsNeeded === 1 ? 'part needs' : 'parts need'} repair after a graded miss. Revisit the method, then check the same skill on a later fresh attempt. Same-day repeats do not add to accuracy evidence.`
        : t.state === 'strong'
          ? `${t.independentCorrect} of ${t.independentAttempts} independent answers were correct across ${t.distinctItems} questions and ${t.distinctDays} days. Keep checking with spaced practice.`
          : t.state === 'needs-work'
            ? t.independentAttempts
              ? `${recentErrors} of your last ${recent.length} independent checks need correction. Work through one example, then try a fresh question.`
              : 'You have used explanations or revealed answers here. A fresh answer without help will show what you can do independently.'
            : t.independentAttempts
              ? `${t.independentAttempts} independent checks so far; more varied questions on another day will make this estimate more reliable.`
              : 'No independently graded answers yet. Reading, reveals and self-ratings do not establish mastery.';
      delete t._evidence;
      delete t._items;
      delete t._days;
      delete t._errorTags;
    }
    const topics = Object.values(byTopic).sort((a, b) => a.key.localeCompare(b.key));
    return {
      generatedAt: now,
      policy: POLICY,
      topics,
      byTopic,
      items,
      totals: {
        events: events.length,
        ignored,
        independentAttempts: topics.reduce((n, t) => n + t.independentAttempts, 0),
        independentCorrect: topics.reduce((n, t) => n + t.independentCorrect, 0),
        guided: topics.reduce((n, t) => n + t.guided, 0),
        revealed: topics.reduce((n, t) => n + t.revealed, 0),
        manual: topics.reduce((n, t) => n + t.manual, 0)
      },
      recent: events
        .slice(-20)
        .map((e) => ({
          key: e.key,
          itemKey: e.itemKey,
          at: e.at,
          independent: e.independent,
          status: e.status
        }))
    };
  }
  function recommend(input, catalog, options = {}) {
    const s = summarize(input, options),
      now = s.generatedAt,
      limit = Math.max(0, Math.min(50, Math.floor(finite(options.limit, 5)))),
      seen = new Set();
    if (!limit) return [];
    const candidates = [];
    for (const item of Array.isArray(catalog) ? catalog : []) {
      if (!item || typeof item !== 'object' || item.available === false) continue;
      const course = str(item.course),
        topic = canonicalTopic(course, str(item.topic), options.aliases),
        questionId = str(item.questionId) || str(item.id),
        partId = str(item.partId);
      if (
        !course ||
        !topic ||
        !questionId ||
        (options.course && !['MIX', 'FOCUS'].includes(options.course) && course !== options.course)
      )
        continue;
      if (
        item.unlock &&
        String(item.unlock).slice(0, 10) > new Date(now).toISOString().slice(0, 10)
      )
        continue;
      const ik = [course, questionId, partId].join('|');
      if (seen.has(ik)) continue;
      seen.add(ik);
      const key = topicKey(course, topic),
        t = s.byTopic[key],
        it = s.items[ik];
      let priority = t
        ? t.state === 'needs-work'
          ? 76
          : t.state === 'developing'
            ? 47
            : t.state === 'strong'
              ? 12
              : 40
        : 32;
      const dueAt = it && it.dueAt !== null ? it.dueAt : t && t.dueAt !== null ? t.dueAt : null;
      let mode = 'independent-check',
        reason = t
          ? t.reason
          : 'Start with a short question to find out what you already know. There is no graded evidence for this topic yet.';
      if (t && t.state === 'needs-work') {
        mode = 'repair-and-retry';
        if (t.errors.length)
          reason +=
            ' Recent attempts flagged “' + t.errors[0].tag + '”; check that step carefully.';
      } else if (dueAt !== null && dueAt <= now) {
        priority += 35 + Math.min(15, (now - dueAt) / DAY);
        mode = 'spaced-review';
        reason =
          'This material is due for a fresh retrieval check. Try it without opening the solution first.';
      }
      if (!it) {
        priority += 8;
        if (t && t.independentAttempts < 6)
          reason +=
            ' This is a different question, which adds more useful evidence than repeating the same answer.';
      } else if (now - it.lastAt < POLICY.sameItemCooldownMinutes * MINUTE) {
        priority -= 40;
        reason += ' You just saw this question; prefer another question before returning.';
      }
      const prereqs =
        item.prerequisites ||
        (options.prerequisites && options.prerequisites[key]) ||
        DEFAULT_PREREQUISITES[key] ||
        [];
      const unmet = [];
      for (const p of Array.isArray(prereqs) ? prereqs : []) {
        let pk = str(p);
        if (!pk) continue;
        if (!pk.includes('|')) pk = topicKey(course, canonicalTopic(course, pk, options.aliases));
        if (pk === key) continue;
        const pt = s.byTopic[pk];
        if (!pt || !['strong', 'developing'].includes(pt.state) || pt.independentAttempts < 3)
          unmet.push(pk);
      }
      candidates.push({
        ...item,
        questionId,
        partId,
        course,
        topic,
        key,
        itemKey: ik,
        priority,
        mode,
        reason,
        confidence: t ? t.confidence : 0,
        confidenceLabel: t ? t.confidenceLabel : 'no evidence yet',
        evidence: t
          ? {
              independentAttempts: t.independentAttempts,
              correct: t.independentCorrect,
              distinctItems: t.distinctItems,
              distinctDays: t.distinctDays,
              guided: t.guided,
              revealed: t.revealed,
              manual: t.manual
            }
          : {
              independentAttempts: 0,
              correct: 0,
              distinctItems: 0,
              distinctDays: 0,
              guided: 0,
              revealed: 0,
              manual: 0
            },
        dueAt,
        unmetPrerequisites: unmet,
        state: t ? t.state : 'new'
      });
    }
    // Prioritize an available weak prerequisite, never lock out a question or recurse through a cycle.
    for (const c of candidates) {
      const available = c.unmetPrerequisites.filter((k) =>
        candidates.some((x) => x.key === k && x.key !== c.key)
      );
      if (available.length) {
        c.priority -= 18;
        for (const p of candidates)
          if (available.includes(p.key)) {
            p.priority = Math.max(p.priority, c.priority + 25);
            p.mode = 'foundation-check';
            p.reason =
              'Check ' +
              p.topic +
              ' before ' +
              c.topic +
              '. This foundation has not yet shown enough independent evidence.';
          }
      }
    }
    const chosen = [];
    let pool = candidates.slice();
    while (chosen.length < limit && pool.length) {
      const topicCounts = new Map();
      for (const c of chosen) topicCounts.set(c.key, (topicCounts.get(c.key) || 0) + 1);
      const recent = s.recent.slice(-2);
      pool.sort((a, b) => {
        const score = (c) =>
          c.priority -
          (topicCounts.get(c.key) || 0) * 30 -
          (recent.length === 2 && recent.every((e) => e.key === c.key) ? 8 : 0) +
          (limit >= 3 &&
          chosen.length === limit - 1 &&
          !chosen.some((x) => x.evidence.independentAttempts === 0) &&
          c.evidence.independentAttempts === 0
            ? 1000
            : 0);
        return score(b) - score(a) || a.itemKey.localeCompare(b.itemKey);
      });
      const c = pool.shift();
      if (chosen.length && chosen[chosen.length - 1].key !== c.key)
        c.reason += ' Switching topics also gives you practice choosing the right method.';
      chosen.push(c);
    }
    return chosen;
  }
  const api = {
    VERSION: '1.0.5',
    POLICY,
    DIGI_ALIASES,
    DEFAULT_PREREQUISITES,
    canonicalTopic,
    topicKey,
    summarize,
    recommend
  };
  root.MurmurAdaptive = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
