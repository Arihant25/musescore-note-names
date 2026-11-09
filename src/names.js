/* Note-name formatting for the various naming systems. */
(function (global) {
  'use strict';

  const ENGLISH = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  const SOLFEGE = ['Do', 'Re', 'Mi', 'Fa', 'Sol', 'La', 'Si'];
  const SOLFEGE_TI = ['Do', 'Re', 'Mi', 'Fa', 'Sol', 'La', 'Ti'];
  const SYMBOL = { '-2': '𝄫', '-1': '♭', 0: '', 1: '♯', 2: '𝄪' };
  const ASCII = { '-2': 'bb', '-1': 'b', 0: '', 1: '#', 2: 'x' };

  // Boomwhacker-style colours, one per letter (C..B).
  const LETTER_COLORS = ['#e8202a', '#f58b22', '#d6b800', '#3aa935', '#2a7dd1', '#6a3bb3', '#c2268f'];

  function german(letter, alter) {
    const base = ['C', 'D', 'E', 'F', 'G', 'A', 'H'][letter];
    if (alter === 0) return base;
    if (alter > 0) return base + 'is'.repeat(alter);
    // Flats: special spellings for E, A and B.
    if (letter === 6) return alter === -1 ? 'B' : 'Heses';
    if (letter === 2) return 'E' + 's' + 'es'.repeat(-alter - 1);  // Es, Eses
    if (letter === 5) return 'A' + 's' + 'as'.repeat(-alter - 1);  // As, Asas
    return base + 'es'.repeat(-alter);
  }

  /**
   * @param {{letter:number, octave:number, alter:number}} note
   * @param {{system:string, octave:boolean, asciiAccidentals:boolean, hideNaturals:boolean}} opts
   */
  function format(note, opts) {
    const acc = (opts.asciiAccidentals ? ASCII : SYMBOL)[note.alter] || '';
    let name;
    switch (opts.system) {
      case 'german': name = german(note.letter, note.alter); break;
      case 'solfege': name = SOLFEGE[note.letter] + acc; break;
      case 'solfege-ti': name = SOLFEGE_TI[note.letter] + acc; break;
      default: name = ENGLISH[note.letter] + acc;
    }
    if (opts.octave) name += note.octave;
    return name;
  }

  global.MSNN = global.MSNN || {};
  Object.assign(global.MSNN, { formatName: format, LETTER_COLORS });
})(typeof window !== 'undefined' ? window : globalThis);
