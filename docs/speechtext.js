/* Pandora Practice Pal — what is spoken vs what is shown.
   forTTS(): fixes words the neural voice mispronounces, by respelling them before synthesis (the screen keeps the real spelling).
   display(): shows units as symbols after a number ("4.7 kilohms" → "4.7 kΩ") while the voice still says the full word. */
'use strict';
const SpeechText = (() => {
  // respellings — whole-word, case-insensitive; add to this list whenever a word sounds wrong
  const SAY = [
    ['delocalized', 'dee-low-kuh-lized'], ['delocalised', 'dee-low-kuh-lized'], ['delocalization', 'dee-low-kuh-lih-zay-shun'],
    ['kilohms', 'kilo ohms'], ['kilohm', 'kilo ohm'], ['megohms', 'meg ohms'], ['megohm', 'meg ohm'], ['milliohms', 'milli ohms'],
    ['siemens', 'see-menz'], ['millisiemens', 'milli see-menz'], ['coulombs', 'coo-loms'], ['coulomb', 'coo-lom'],
    ['Kirchhoff', 'keer-koff'], ['Kirchhoffs', 'keer-koffs'], ['DeMorgan', 'de mor-gan'], ['Boylestad', 'boyle-stad'], ['Kleitz', 'klights'],
    ['ASCII', 'ask-ee'], ['SAIT', 'S A I T'], ['DIGI', 'didge-ee'], ['ELTR', 'E L T R'], ['EFAB', 'e fab'], ['MATH', 'math'],
    ['TTL', 'T T L'], ['CMOS', 'see-moss'], ['SOP', 'S O P'], ['POS', 'P O S'], ['BCD', 'B C D'], ['LSB', 'L S B'], ['MSB', 'M S B'],
    ['DMM', 'D M M'], ['ESD', 'E S D'], ['PCB', 'P C B'], ['PCBs', 'P C Bs'], ['IC', 'I C'], ['ICs', 'I Cs'], ['LED', 'L E D'], ['LEDs', 'L E Ds'],
    ['KVL', 'K V L'], ['KCL', 'K C L'], ['EIS', 'E I S'], ['EIP', 'E I P'], ['EIC', 'E I C'], ['RIS', 'R I S'], ['OL', 'O L'],
    ['NAND', 'nand'], ['XOR', 'ex or'], ['XNOR', 'ex nor'], ['Atreides', 'uh-tray-deez'], ['Harkonnen', 'har-kuh-nen'], ['Harkonnens', 'har-kuh-nenz'],
    ['rheostat', 'ree-oh-stat'], ['potentiometer', 'poe-ten-shee-om-uh-ter'], ['multimeter', 'mull-tee-mee-ter'], ['solder', 'sod-er'], ['soldering', 'sod-er-ing'], ['soldered', 'sod-erd'],
    ['coterminal', 'co-ter-min-ul'], ['radians', 'ray-dee-unz'], ['radian', 'ray-dee-un'], ['cosecant', 'co-see-kant'], ['secant', 'see-kant'], ['cotangent', 'co-tan-jent'],
  ];
  const re = SAY.map(([w, s]) => [new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', /^[A-Z]{2,}s?$/.test(w) ? 'g' : 'gi'), s]);
  function forTTS(text) { let t = String(text); for (const [r, s] of re) t = t.replace(r, s); return t; }

  const UNIT = { volts: 'V', volt: 'V', millivolts: 'mV', millivolt: 'mV', kilovolts: 'kV', amps: 'A', amp: 'A', amperes: 'A', milliamps: 'mA', milliamp: 'mA', microamps: 'µA', microamp: 'µA',
    ohms: 'Ω', ohm: 'Ω', kilohms: 'kΩ', kilohm: 'kΩ', megohms: 'MΩ', megohm: 'MΩ', watts: 'W', watt: 'W', milliwatts: 'mW', kilowatts: 'kW', hertz: 'Hz', kilohertz: 'kHz', megahertz: 'MHz',
    seconds: 's', second: 's', milliseconds: 'ms', microseconds: 'µs', nanoseconds: 'ns', joules: 'J', joule: 'J', coulombs: 'C', coulomb: 'C', siemens: 'S', millisiemens: 'mS',
    farads: 'F', microfarads: 'µF', nanofarads: 'nF', picofarads: 'pF', henries: 'H', millihenries: 'mH', degrees: '°', degree: '°', percent: '%' };
  const isNum = (w) => /^[-+]?\d+(\.\d+)?$/.test(String(w || '').replace(/[,]/g, ''));
  // returns the text to SHOW for word w (prev = previous word, raw)
  function display(w, prev) {
    const m = /^([A-Za-z]+)([^A-Za-z]*)$/.exec(w); if (!m || !isNum(prev)) return w;
    const sym = UNIT[m[1].toLowerCase()]; if (!sym) return w;
    return sym + m[2];
  }
  return { forTTS, display, SAY };
})();
