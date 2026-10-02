/* Pandora Practice Pal — spoken-answer parser. Pure functions, no DOM (also unit-tested in node). */
(function (root) {
  const SMALL = { zero: 0, oh: 0, o: 0, one: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, ate: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
    twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
  const SCALE = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9 };
  const ORD = { first: 0, second: 1, third: 2, fourth: 3, '1st': 0, '2nd': 1, '3rd': 2, '4th': 3 };
  const LETTER = { a: 0, b: 1, c: 2, d: 3, alpha: 0, bravo: 1, charlie: 2, delta: 3 };
  const PREFIX = { kilo: 1e3, k: 1e3, milli: 1e-3, m: 1e-3, micro: 1e-6, u: 1e-6, mega: 1e6, meg: 1e6, nano: 1e-9, n: 1e-9, pico: 1e-12, giga: 1e9 };
  // unit word -> [base unit, multiplier]
  const UNITS = { '': ['', 1], volt: ['V', 1], volts: ['V', 1], v: ['V', 1], amp: ['A', 1], amps: ['A', 1], ampere: ['A', 1], amperes: ['A', 1], a: ['A', 1],
    ohm: ['O', 1], ohms: ['O', 1], watt: ['W', 1], watts: ['W', 1], joule: ['J', 1], joules: ['J', 1], coulomb: ['C', 1], coulombs: ['C', 1],
    siemens: ['S', 1], second: ['s', 1], seconds: ['s', 1], sec: ['s', 1], hertz: ['Hz', 1], hz: ['Hz', 1], percent: ['%', 1], degree: ['deg', 1], degrees: ['deg', 1],
    bit: ['bit', 1], bits: ['bit', 1], hour: ['h', 1], hours: ['h', 1], minute: ['min', 1], minutes: ['min', 1],
    millivolts: ['V', 1e-3], millivolt: ['V', 1e-3], milliamps: ['A', 1e-3], milliamp: ['A', 1e-3], milliamperes: ['A', 1e-3], microamps: ['A', 1e-6], microamp: ['A', 1e-6],
    kilohms: ['O', 1e3], kilohm: ['O', 1e3], kilo: ['O', 1e3], megohms: ['O', 1e6], megohm: ['O', 1e6], milliwatts: ['W', 1e-3], milliwatt: ['W', 1e-3],
    millisiemens: ['S', 1e-3], milliseconds: ['s', 1e-3], millisecond: ['s', 1e-3], microseconds: ['s', 1e-6], microsecond: ['s', 1e-6],
    nanoseconds: ['s', 1e-9], nanosecond: ['s', 1e-9], kilohertz: ['Hz', 1e3], megahertz: ['Hz', 1e6], milliseimens: ['S', 1e-3] };

  function norm(s) {
    return String(s || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9.%\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // ---- commands -----------------------------------------------------------------------------
  const CMDS = [
    ['stop', /\b(stop|end (the )?(session|lesson|lecture)|finish|quit|thats enough|that is enough|im done|i am done)\b/],
    ['pause', /\b(pause|hold on|wait|hang on|one moment)\b/],
    ['resume', /\b(resume|continue|carry on|go on|back to (the )?(lesson|lecture)|keep going|next point|thats all|that is all|no more questions|im good|no thanks)\b/],
    ['repeat', /\b(repeat|go back|back up|rewind|say (that |it )?again|again please|pardon|what was that|come again|one more time)\b/],
    ['ai', /\b(a ?i|ai|ask (the )?ai|talk to (the )?ai|i have a question|question about that|can i ask)\b/],
    ['expand', /\b(expand|tell me more|go deeper|more detail|in more detail|elaborate|dig into that|how does that work|why is that)\b/],
    ['explain', /\b(explain|simpler|simplify|eli5|like i.?m five|analogy|what do you mean|i don.?t get it|i do not get it|break it down)\b/],
    ['hint', /\b(hint|clue|help me)\b/],
    ['dontknow', /\b(i dont know|dont know|no idea|not sure|no clue|pass|give up|show me|reveal|whats the answer|what is the answer)\b/],
    ['skip', /\b(skip|next question|next one|move on|next)\b/],
    ['status', /\b(score|how am i doing|progress)\b/],
  ];
  function command(text) {
    const t = ' ' + norm(text) + ' ';
    for (const [name, re] of CMDS) if (re.test(t)) return name;
    return null;
  }

  // ---- numbers ------------------------------------------------------------------------------
  // Parses a spoken number with optional prefix/unit. Returns {value, mult, unit, base} or null.
  function number(text) {
    let t = norm(text).replace(/,/g, '');
    t = t.replace(/\bnegative\b|\bminus\b/g, ' - ').replace(/\bpoint\b|\bdot\b/g, ' . ').replace(/\band\b/g, ' ');
    const toks = t.split(' ').filter(Boolean);
    let i = 0, sign = 1, value = null;
    if (toks[i] === '-') { sign = -1; i++; }
    // digit form
    if (toks[i] && /^-?\d*\.?\d+$/.test(toks[i])) { value = parseFloat(toks[i]); i++; if (toks[i] === '.' && /^\d+$/.test(toks[i + 1] || '')) { value = parseFloat(value + '.' + toks[i + 1]); i += 2; } }
    else if (toks[i] === '.' && /^\d+$/.test(toks[i + 1] || '')) { value = parseFloat('0.' + toks[i + 1]); i += 2; }
    else {
      // word form: integer part
      let total = 0, cur = 0, any = false;
      while (i < toks.length) {
        const w = toks[i];
        if (w in SMALL) { cur += SMALL[w]; any = true; i++; }
        else if (w === 'hundred') { cur = (cur || 1) * 100; any = true; i++; }
        else if (w in SCALE) { total += (cur || 1) * SCALE[w]; cur = 0; any = true; i++; }
        else if (/^\d+$/.test(w) && any && w.length <= 2) { cur += parseInt(w, 10); i++; }
        else break;
      }
      if (any) value = total + cur;
      // decimal part
      if (toks[i] === '.') {
        i++; let frac = '';
        while (i < toks.length && (toks[i] in SMALL || /^\d+$/.test(toks[i]))) { frac += (toks[i] in SMALL ? String(SMALL[toks[i]]) : toks[i]); i++; }
        if (frac) value = parseFloat((value == null ? 0 : value) + '.' + frac);
      }
      // "a half", "one half", "three quarters"
      const fr = { half: 0.5, quarter: 0.25, quarters: 0.25, third: 1 / 3, thirds: 1 / 3 };
      if ((toks[i] || '') in fr) {                      // "one half", "three quarters", "a half"
        value = (value == null ? 1 : value) * fr[toks[i]]; i++;
      } else if (value == null && toks[i] === 'a' && (toks[i + 1] || '') in fr) { value = fr[toks[i + 1]]; i += 2; }
    }
    if (value == null) return null;
    value *= sign;
    // prefix / unit words
    let mult = 1, unit = '';
    const rest = toks.slice(i).join(' ').replace(/\s+/g, ' ');
    const rt = rest.split(' ').filter(Boolean);
    let j = 0;
    if (rt[j] === 'k' || rt[j] === 'kilo' || rt[j] === 'milli' || rt[j] === 'micro' || rt[j] === 'mega' || rt[j] === 'nano' || rt[j] === 'pico' || rt[j] === 'giga') { mult = PREFIX[rt[j]]; j++; }
    if (rt[j] in UNITS) { const [b, m] = UNITS[rt[j]]; unit = b; mult *= m; }
    else if (rt[j]) {
      // glued forms: "4.7k", "10ma", "kohms", "kilo-ohms"
      const m = /^(kilo|milli|micro|mega|nano|k|m|u)?(ohms?|volts?|amps?|watts?|hertz|hz|v|a|w|s|seconds?)$/.exec(rt[j]);
      if (m) { if (m[1]) mult = PREFIX[m[1]]; if (m[2] in UNITS) { const [b, mm] = UNITS[m[2]]; unit = b; mult *= mm; } }
    }
    return { value, mult, unit, base: value * mult };
  }

  // Compare spoken text to a numeric answer {value, unit, tol}. Returns true/false/null(unparseable).
  function matchNumber(text, ans) {
    const p = number(text);
    if (!p) return null;
    const [ab, am] = UNITS[ans.unit || ''] || ['', 1];
    const target = ans.value * am;
    const tol = ans.tol == null ? 0.02 : ans.tol;
    let got = p.base;
    if (!p.unit && p.mult === 1) got = p.value * am;          // bare number: assume the asked unit
    else if (!p.unit) got = p.value * p.mult;                 // "four point seven kilo" (prefix only) -> base units
    if (p.unit && ab && p.unit !== ab) return false;          // wrong physical unit
    if (target === 0) return Math.abs(got) < 1e-9;
    if (Math.abs(got - target) <= Math.abs(target) * tol + 1e-12) return true;
    // if they spoke a bare number equal to the base-unit value (e.g. "4700" for 4.7 kilohms), accept
    if (!p.unit && p.mult === 1 && Math.abs(p.value - target) <= Math.abs(target) * tol) return true;
    return false;
  }
  function numberValue(text, ans) { // spoken value expressed in the answer's unit (for slip matching)
    const p = number(text); if (!p) return null;
    const [, am] = UNITS[ans.unit || ''] || ['', 1];
    if (!p.unit && p.mult === 1) return p.value;
    return p.base / am;
  }

  // ---- choice -------------------------------------------------------------------------------
  function tokens(s) { return norm(s).split(' ').filter(w => w && !/^(the|a|an|of|is|are|to|and|or|in|it|its|that|this|by|with|for|on|at|as|be)$/.test(w)); }
  function choice(text, options) {
    const t = norm(text); const n = options.length;
    const exact0 = options.findIndex(o => norm(o) === t); if (exact0 >= 0) return exact0;   // spoken option text wins over letter labels
    let m = /\b(?:option|number|answer|choice)\s+([a-d]|one|two|three|four|1|2|3|4)\b/.exec(t) || /^(?:the\s+)?(first|second|third|fourth|1st|2nd|3rd|4th)(?:\s+one)?$/.exec(t) || /^(?:option\s+|answer\s+)?([a-d]|one|two|three|four|1|2|3|4)$/.exec(t);
    if (m) {
      const w = m[1]; let idx = null;
      if (w in ORD) idx = ORD[w]; else if (w in SMALL) idx = SMALL[w] - 1; else if (/^\d$/.test(w)) idx = parseInt(w, 10) - 1; else if (w in LETTER) idx = LETTER[w];
      if (idx != null && idx >= 0 && idx < n) return idx;
    }
    // "the last one"
    if (/\b(the )?last (one|option)\b/.test(t)) return n - 1;
    // exact / contained option text
    const nt = t;
    const ex = options.map(o => norm(o));
    const exact = ex.findIndex(o => o === nt); if (exact >= 0) return exact;
    const contained = ex.map((o, i) => (nt.includes(o) || (o.length > 6 && o.includes(nt)) ? i : -1)).filter(i => i >= 0);
    if (contained.length === 1) return contained[0];
    // numeric options
    const pn = number(t);
    if (pn) {
      const nums = ex.map(o => number(o));
      const hits = nums.map((x, i) => (x && Math.abs(x.base - pn.base) <= Math.abs(x.base) * 0.02 + 1e-12 ? i : -1)).filter(i => i >= 0);
      if (hits.length === 1) return hits[0];
    }
    // token overlap
    const tt = new Set(tokens(t)); if (!tt.size) return null;
    const scores = ex.map(o => { const ot = new Set(tokens(o)); let c = 0; for (const w of tt) if (ot.has(w)) c++; return ot.size ? c / Math.max(ot.size, tt.size) : 0; });
    const best = Math.max(...scores);
    if (best >= 0.5 && scores.filter(s => s === best).length === 1) return scores.indexOf(best);
    return null;
  }

  // ---- true / false -------------------------------------------------------------------------
  function tf(text) {
    const t = ' ' + norm(text) + ' ';
    if (/\b(true|yes|yeah|yep|correct|right|agree|thats right|it is)\b/.test(t) && !/\b(not|false|no|wrong)\b/.test(t)) return true;
    if (/\b(false|no|nope|incorrect|wrong|disagree|not true|it isnt|it is not)\b/.test(t)) return false;
    return null;
  }

  // ---- word ---------------------------------------------------------------------------------
  function digitsFromWords(t) { // "one zero one one" -> "1011", "two f" -> "2f"
    const out = t.split(' ').map(w => (w in SMALL && SMALL[w] < 10 ? String(SMALL[w]) : w)).join('');
    return out;
  }
  function word(text, accepted) {
    const raw = norm(text);
    const t = raw.replace(/^(the|a|an|its|it is|thats|that is|is it|i think|maybe|probably)\s+/g, '').trim();
    const acc = accepted.map(a => norm(a));
    if (acc.includes(raw) || acc.includes(t)) return true;
    const compact = t.replace(/[\s\-]/g, ''); const accC = acc.map(a => a.replace(/[\s\-]/g, ''));
    if (accC.includes(compact)) return true;
    const dw = digitsFromWords(t).replace(/\s/g, '');
    if (accC.includes(dw)) return true;
    // accepted phrase contained in the utterance ("it's a nand gate")
    for (const a of acc) if (a.length >= 3 && (' ' + t + ' ').includes(' ' + a + ' ')) return true;
    for (const a of accC) if (a.length >= 4 && compact.includes(a)) return true;
    return false;
  }

  root.Parse = { norm, command, number, matchNumber, numberValue, choice, tf, word };
})(typeof module !== 'undefined' ? module.exports : window);
