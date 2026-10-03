/* Murmur — what is spoken vs what is shown.
   forTTS(): fixes words the neural voice mispronounces, by respelling them before synthesis (the screen keeps the real spelling).
   display(): shows units as symbols after a number ("4.7 kilohms" → "4.7 kΩ") while the voice still says the full word. */
'use strict';
const SpeechText = (() => {
  // respellings — whole-word, case-insensitive; add to this list whenever a word sounds wrong
  // Communicative and commutative are distinct words, not interchangeable concepts.
  // Respelling affects audio only; prepare() maintains a map to the original display.
  const SAY = [
    ['Boolean', 'boo lee un'],
    ['communicative', 'kuh myoo nih kuh tiv'],
    ['commutative', 'kuh myoo tuh tiv'],
    ['LOW', 'low'],
    ['HIGH', 'high'],
    ['decoupling', 'dee coupling'],
    ['decouple', 'dee couple'],
    ['VCC', 'V C C'],
    ['VDD', 'V D D'],
    ['VSS', 'V S S'],
    ['delocalized', 'dee-low-kuh-lized'],
    ['delocalised', 'dee-low-kuh-lized'],
    ['delocalization', 'dee-low-kuh-lih-zay-shun'],
    ['kilohms', 'kilo ohms'],
    ['kilohm', 'kilo ohm'],
    ['megohms', 'meg ohms'],
    ['megohm', 'meg ohm'],
    ['milliohms', 'milli ohms'],
    ['siemens', 'see-menz'],
    ['millisiemens', 'milli see-menz'],
    ['coulombs', 'coo-loms'],
    ['coulomb', 'coo-lom'],
    ['Kirchhoff', 'keer-koff'],
    ['Kirchhoffs', 'keer-koffs'],
    ['DeMorgan', 'de mor-gan'],
    ['Boylestad', 'boyle-stad'],
    ['Kleitz', 'klights'],
    ['ASCII', 'ask-ee'],
    ['SAIT', 'S A I T'],
    ['DIGI', 'didge-ee'],
    ['ELTR', 'E L T R'],
    ['EFAB', 'e fab'],
    ['MATH', 'math'],
    ['TTL', 'T T L'],
    ['CMOS', 'see-moss'],
    ['SOP', 'S O P'],
    ['POS', 'P O S'],
    ['BCD', 'B C D'],
    ['LSB', 'L S B'],
    ['MSB', 'M S B'],
    ['DMM', 'D M M'],
    ['ESD', 'E S D'],
    ['PCB', 'P C B'],
    ['PCBs', 'P C Bs'],
    ['IC', 'I C'],
    ['ICs', 'I Cs'],
    ['LED', 'L E D'],
    ['LEDs', 'L E Ds'],
    ['KVL', 'K V L'],
    ['KCL', 'K C L'],
    ['EIS', 'E I S'],
    ['EIP', 'E I P'],
    ['EIC', 'E I C'],
    ['RIS', 'R I S'],
    ['OL', 'O L'],
    ['NAND', 'nand'],
    ['XOR', 'ex or'],
    ['XNOR', 'ex nor'],
    ['Atreides', 'uh-tray-deez'],
    ['Harkonnen', 'har-kuh-nen'],
    ['Harkonnens', 'har-kuh-nenz'],
    ['rheostat', 'ree-oh-stat'],
    ['potentiometer', 'poe-ten-shee-om-uh-ter'],
    ['multimeter', 'mull-tee-mee-ter'],
    ['solder', 'sod-er'],
    ['soldering', 'sod-er-ing'],
    ['soldered', 'sod-erd'],
    ['coterminal', 'co-ter-min-ul'],
    ['radians', 'ray-dee-unz'],
    ['radian', 'ray-dee-un'],
    ['cosecant', 'co-see-kant'],
    ['secant', 'see-kant'],
    ['cotangent', 'co-tan-jent']
  ];
  const re = SAY.map(([w, s]) => [
    new RegExp(
      '\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b',
      /^[A-Z]{2,}s?$/.test(w) ? 'g' : 'gi'
    ),
    s
  ]);
  // Each spoken character maps back to the displayed source. Respelling must never
  // move the highlight onto a different word or change the student's written notation.
  function prepare(text) {
    let t = String(text),
      map = Array.from({ length: t.length }, (_, i) => i);
    function replace(regex, replacement) {
      let next = '',
        indices = [],
        last = 0;
      for (const match of t.matchAll(regex)) {
        const at = match.index,
          value = typeof replacement === 'function' ? replacement(...match) : replacement;
        next += t.slice(last, at) + value;
        indices.push(...map.slice(last, at));
        const start = map[at] ?? at,
          end = map[at + match[0].length - 1] ?? start;
        for (let i = 0; i < value.length; i++)
          indices.push(
            start +
              Math.min(end - start, Math.floor((i * (end - start + 1)) / Math.max(1, value.length)))
          );
        last = at + match[0].length;
      }
      next += t.slice(last);
      indices.push(...map.slice(last));
      t = next;
      map = indices;
    }
    const units = {
      kΩ: 'kilo ohms',
      MΩ: 'mega ohms',
      Ω: 'ohms',
      mV: 'millivolts',
      kV: 'kilovolts',
      V: 'volts',
      mA: 'milliamps',
      µA: 'microamps',
      μA: 'microamps',
      A: 'amps',
      MHz: 'megahertz',
      kHz: 'kilohertz',
      Hz: 'hertz',
      ms: 'milliseconds',
      µs: 'microseconds',
      μs: 'microseconds',
      ns: 'nanoseconds',
      s: 'seconds',
      µF: 'microfarads',
      μF: 'microfarads',
      nF: 'nanofarads',
      pF: 'picofarads'
    };
    replace(
      /([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(kΩ|MΩ|Ω|mV|kV|V|mA|µA|μA|A|MHz|kHz|Hz|ms|µs|μs|ns|s|µF|μF|nF|pF)(?![A-Za-z])/g,
      (all, n, unit) => n + ' ' + units[unit]
    );
    replace(
      /\b74\s*L\s*S\s*(\d{2,3})\b/gi,
      (all, digits) => 'seventy four L S ' + digits.split('').join(' ')
    );
    replace(
      /[×÷±]/g,
      (symbol) => ({ '×': ' times ', '÷': ' divided by ', '±': ' plus or minus ' })[symbol]
    );
    replace(
      /([A-Za-z0-9])([²³])/g,
      (all, value, power) => value + (power === '²' ? ' squared' : ' cubed')
    );
    for (const [regex, spoken] of re) replace(regex, spoken);
    return { text: t, map };
  }
  function forTTS(text) {
    return prepare(text).text;
  }

  const UNIT = {
    volts: 'V',
    volt: 'V',
    millivolts: 'mV',
    millivolt: 'mV',
    kilovolts: 'kV',
    amps: 'A',
    amp: 'A',
    amperes: 'A',
    milliamps: 'mA',
    milliamp: 'mA',
    microamps: 'µA',
    microamp: 'µA',
    ohms: 'Ω',
    ohm: 'Ω',
    kilohms: 'kΩ',
    kilohm: 'kΩ',
    megohms: 'MΩ',
    megohm: 'MΩ',
    watts: 'W',
    watt: 'W',
    milliwatts: 'mW',
    kilowatts: 'kW',
    hertz: 'Hz',
    kilohertz: 'kHz',
    megahertz: 'MHz',
    seconds: 's',
    second: 's',
    milliseconds: 'ms',
    microseconds: 'µs',
    nanoseconds: 'ns',
    joules: 'J',
    joule: 'J',
    coulombs: 'C',
    coulomb: 'C',
    siemens: 'S',
    millisiemens: 'mS',
    farads: 'F',
    microfarads: 'µF',
    nanofarads: 'nF',
    picofarads: 'pF',
    henries: 'H',
    millihenries: 'mH',
    degrees: '°',
    degree: '°',
    percent: '%'
  };
  const isNum = (w) => /^[-+]?\d+(\.\d+)?$/.test(String(w || '').replace(/[,]/g, ''));
  // returns the text to SHOW for word w (prev = previous word, raw)
  function display(w, prev) {
    const m = /^([A-Za-z]+)([^A-Za-z]*)$/.exec(w);
    if (!m || !isNum(prev)) return w;
    const sym = UNIT[m[1].toLowerCase()];
    if (!sym) return w;
    return sym + m[2];
  }
  return { forTTS, prepare, display, SAY };
})();
