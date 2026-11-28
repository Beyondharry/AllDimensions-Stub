// grammar-rules.mjs — pure text analysis for the Grammar bot (no network, fully testable).
//
// Pipeline for every page:
//   1. buildMask()  — find everything the bot must never read or touch (templates, links' targets,
//                     tags, comments, quotes...) and produce a same-length "masked" copy of the text
//                     in which those characters are replaced by U+E000. Offsets therefore line up 1:1
//                     with the real wikitext, which is what makes safe automatic fixing possible.
//   2. analyze()    — run the enabled rules on the masked text and return findings with exact offsets.
//   3. applyFindings() — apply fixes to the real wikitext, verifying each piece of text first.

export const MASK = '\uE000';

// ---------------------------------------------------------------------------
// Rule catalogue (also used to write the report pages, so keep the wording friendly)
// ---------------------------------------------------------------------------

export const RULES = [
  {
    id: 'known_misspelling',
    title: 'Known misspellings',
    version: 1,
    confidence: 'high',
    autofixable: true,
    summary: 'A word that appears on a list of common English misspellings.',
    explain:
      "The bot does NOT try to decide whether a word is 'real English'. On a fiction wiki that would flag thousands of invented names. " +
      "Instead it only flags words that are on a list of *known* misspellings, such as ''occurance'' (occurrence) or ''recieve'' (receive). " +
      "That is why this rule almost never flags lore terms.",
    examples: [
      ['This occurance is extremely rare.', 'This occurrence is extremely rare.'],
      ['He did not recieve the message.', 'He did not receive the message.'],
      ['It was alot bigger.', 'It was a lot bigger.'],
    ],
    notFlagged: [
      'Anything inside templates, quotes, link targets, references or HTML tags.',
      "Words that appear in a page title on the wiki (they may be lore names), and anything on the ignore list.",
    ],
    logic:
      "Every word is lower-cased and looked up in the misspelling list (the file <code>data/misspellings.json</code> plus any entries added on the Grammar config page). " +
      "The capitalisation of the original is kept (''Teh'' becomes ''The'', ''TEH'' becomes ''THE'').",
    risks: [
      'A word on the list might be a deliberate spelling in a character name or in-universe language. Add such words to the ignore list.',
      'Some misspellings have more than one possible correction; the list only contains entries with a single obvious correction.',
    ],
  },
  {
    id: 'repeated_word',
    title: 'Repeated words',
    version: 1,
    confidence: 'low',
    autofixable: true,
    summary: 'The same word written twice in a row (for example "the the").',
    explain: 'Accidentally typing a word twice is one of the most common slips when editing. The second copy is removed.',
    examples: [
      ['It is is extremely rare.', 'It is extremely rare.'],
      ['This is the the end.', 'This is the end.'],
    ],
    notFlagged: [
      "Words that are correct when doubled: ''had had'', ''that that'', ''is is'', ''very very'', ''no no'', ''ha ha'' and similar (the list can be edited on the config page).",
      "Doubled capitalised names such as ''Bora Bora'', and words separated by punctuation or a line break.",
    ],
    logic: 'Looks for a word of 2+ letters followed by spaces/tabs and the same word again (ignoring case).',
    risks: [
      'Chants, stuttering speech and song lyrics can repeat words deliberately. Quoted dialogue is skipped by default.',
    ],
  },
  {
    id: 'lowercase_after_period',
    title: 'Lowercase after full stop',
    version: 1,
    confidence: 'high',
    autofixable: true,
    summary: 'A sentence that starts with a small letter after a full stop (often. this occurs).',
    explain: 'After a full stop, the next sentence should start with a capital letter. The first letter of the next word is capitalised.',
    examples: [
      ['It is rare often. this occurrence is extremely rare.', 'It is rare often. This occurrence is extremely rare.'],
    ],
    notFlagged: [
      "Abbreviations such as ''e.g.'', ''i.e.'', ''etc.'', ''vs.'', ''Dr.'', ''St.'', ''approx.''; single initials; decimals; ellipses (...).",
      "Words with a capital letter inside them (like ''iPhone'' or ''eBay'') and words on the lowercase-names list.",
    ],
    logic:
      'Finds a lowercase letter + full stop + spaces + a lowercase word on the same line. The word before the full stop is checked against the abbreviation list first.',
    risks: [
      'Unusual abbreviations that are not on the list can be flagged. Add them to the abbreviations list on the config page.',
      'Names that are meant to start with a lowercase letter. Add them to the ignore list.',
    ],
  },
  {
    id: 'capital_glue_after_comma',
    title: 'Capital after comma',
    version: 1,
    confidence: 'medium',
    autofixable: true,
    summary: 'A small connecting word (So, And, But, This...) wrongly capitalised after a comma or semicolon.',
    explain:
      "After a comma or semicolon the sentence carries on, so words like ''So'' or ''And'' should be lowercase. " +
      "Only a fixed list of connecting words is checked, so proper names such as ''Earth'' are never flagged.",
    examples: [
      ['It is rare, So it has not been spotted.', 'It is rare, so it has not been spotted.'],
      ['It is rare; But it happens.', 'It is rare; but it happens.'],
    ],
    notFlagged: [
      'Capitalised words that are not on the connecting-word list (names, places...).',
      'A connecting word followed by another capitalised word (that looks like a title or a name).',
      'ALL-CAPS words.',
    ],
    logic: 'Finds a comma or semicolon, spaces, then a capitalised word that is on the connecting-word list (editable on the config page).',
    risks: [
      "Reverent or stylised writing (''Praise be, He who...'') can be flagged. Add the word to the ignore list, or the page to the exempt category.",
    ],
  },
  {
    id: 'missing_space_after_period',
    title: 'Missing space after full stop',
    version: 1,
    confidence: 'medium',
    autofixable: true,
    summary: 'No space between a full stop and the next sentence (often.This).',
    explain: 'Adds the missing space after the full stop.',
    examples: [['It happens often.This is rare.', 'It happens often. This is rare.']],
    notFlagged: [
      'Abbreviations (Dr.Who is left alone), file names, web addresses, and names written like Node.Js.',
      'Anything inside templates and links.',
    ],
    logic: 'Finds 2+ letters, a full stop, then a capital letter followed by at least two lowercase letters, with no space.',
    risks: ['Names that really contain a full stop with no space.'],
  },
  {
    id: 'missing_space_after_comma',
    title: 'Missing space after comma',
    version: 1,
    confidence: 'medium',
    autofixable: true,
    summary: 'No space between a comma/semicolon and the next word (rare,so).',
    explain: 'Adds the missing space after a comma or semicolon.',
    examples: [['It is rare,so it is unseen.', 'It is rare, so it is unseen.']],
    notFlagged: [
      'Numbers such as 1,000 (only letters are checked).',
      'Single letters on both sides (like A,B in a formula).',
      'Anything inside templates and links.',
    ],
    logic: 'Finds a letter, a comma or semicolon, then a letter with no space between.',
    risks: ['Compact lists or code-like text.'],
  },
  {
    id: 'space_before_punctuation',
    title: 'Space before punctuation',
    version: 1,
    confidence: 'medium',
    autofixable: true,
    summary: 'A stray space before a comma, semicolon or full stop (word , next).',
    explain: 'Removes the extra space before the punctuation mark.',
    examples: [['It is rare , but real .', 'It is rare, but real.']],
    notFlagged: ['Ellipses (...).', 'A space after a template or link (only a letter or number directly before the space counts).'],
    logic: 'Finds a letter or digit, spaces, then a comma/semicolon/full stop that is followed by a space or the end of the line.',
    risks: ['Deliberate stylistic spacing.'],
  },
  {
    id: 'double_punctuation',
    title: 'Doubled punctuation',
    version: 1,
    confidence: 'medium',
    autofixable: true,
    summary: 'Two commas, two semicolons, or exactly two full stops in a row.',
    explain: "A doubled mark is nearly always a slip of the keyboard. Three dots (...) are an ellipsis and are never touched.",
    examples: [['It is rare,, but real..', 'It is rare, but real.']],
    notFlagged: ['Ellipses (three or more dots).'],
    logic: 'Finds ,, or ;; or exactly two dots straight after a letter or number.',
    risks: ['A deliberate pause written as two dots.'],
  },
  {
    id: 'a_an',
    title: 'A vs An',
    version: 1,
    confidence: 'low',
    autofixable: true,
    summary: "'a' before a vowel sound or 'an' before a consonant sound.",
    explain:
      "Chooses between ''a'' and ''an'' using the first letters of the next word, with exceptions for words that sound different from how they are spelled " +
      "(''a university'', ''an hour'').",
    examples: [
      ['It was a extremely rare event.', 'It was an extremely rare event.'],
      ['It was an unique event.', 'It was a unique event.'],
    ],
    notFlagged: [
      "Acronyms (''an NPC'', ''a UFO''), single letters, words followed by a digit (''an mp3''), and ''an h...'' words (British ''an historic'' is allowed).",
    ],
    logic: "Uses the spelling of the next word, a list of 'yoo'-sound starts (uni-, use-, eu-, one...) and silent-h starts (hour, honest, honour, heir).",
    risks: [
      'Pronunciation is not always predictable from spelling, and invented words may be pronounced differently. This is the least certain rule, so it needs the most review before approval.',
    ],
  },
  {
    id: 'rare_word_suggestion',
    title: 'Rare-word suggestions',
    version: 1,
    confidence: 'low',
    autofixable: false,
    summary: 'A word used only once or twice on the whole wiki that is one letter away from a very common word.',
    explain:
      "This is the 'clever' check. The bot counts every lowercase word across the whole wiki. A word that appears only once or twice, but is exactly one typing slip away from a word used dozens of times, " +
      "is probably a typo (''existece'' vs ''existence''). It also catches typos of your own lore terms, which no normal spellchecker could.",
    examples: [['The existece of the Void.', 'The existence of the Void.']],
    notFlagged: [
      'Capitalised words, words that appear in any page title, short words, plural/singular and -ed/-er/-y pairs, and anything on the ignore list.',
    ],
    logic:
      'Words with a frequency of at most the rare limit are compared with every word one edit away (a deleted, inserted, replaced or swapped letter) that appears at least the common limit and at least the ratio times more often.',
    risks: ['Valid but rare words, and invented words that happen to be one letter from a common one.'],
    neverAutomatic: true,
  },
];

export const RULE_BY_ID = new Map(RULES.map((r, i) => [r.id, { ...r, priority: i }]));
export const AUTOFIX_RULE_IDS = RULES.filter((r) => r.autofixable).map((r) => r.id);

// ---------------------------------------------------------------------------
// Default word lists (extend / trim them on the Grammar config page)
// ---------------------------------------------------------------------------

export const DEFAULT_ABBREVIATIONS = [
  'e.g', 'i.e', 'etc', 'vs', 'dr', 'mr', 'mrs', 'ms', 'st', 'no', 'approx', 'ca', 'cf', 'al', 'inc', 'ltd',
  'jr', 'sr', 'fig', 'vol', 'ed', 'pp', 'prof', 'gen', 'col', 'lt', 'sgt', 'capt', 'mt', 'ft', 'est',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'cm', 'km', 'kg',
];

export const DEFAULT_GLUE_WORDS = [
  'and', 'but', 'or', 'so', 'because', 'although', 'though', 'however', 'which', 'that', 'this', 'these',
  'those', 'it', 'is', 'are', 'was', 'were', 'for', 'with', 'from', 'into', 'as', 'if', 'when', 'while',
  'also', 'then', 'very', 'not', 'only', 'yet', 'nor', 'where', 'whose', 'who', 'whom', 'what', 'whereas',
  'since', 'unless', 'until', 'whether', 'he', 'she', 'they', 'we', 'you',
];

export const DEFAULT_REPEAT_OK = [
  'had', 'that', 'is', 'was', 'do', 'very', 'no', 'so', 'ha', 'hee', 'bye', 'never', 'ever', 'more',
  'pretty', 'long', 'far', 'yes', 'knock', 'now', 'many', 'blah', 'la', 'na', 'yeah', 'oh', 'ah', 'go',
  'boom', 'tick', 'tock', 'bang', 'ding', 'dong', 'wow', 'hey', 'hmm', 'mm', 'mmm', 'why', 'what', 'well',
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const WORD = "[\\p{L}\\p{M}]+(?:['’][\\p{L}\\p{M}]+)*";
const NB = "(?<![\\p{L}\\p{M}\\p{N}_'’])"; // not preceded by a word character
const NA = "(?![\\p{L}\\p{M}\\p{N}_'’])"; // not followed by a word character

const isUpper = (ch) => !!ch && ch !== ch.toLowerCase();

export function matchCase(found, replacement) {
  if (!replacement) return replacement;
  if (found.length > 1 && found === found.toUpperCase() && found !== found.toLowerCase()) {
    return replacement.toUpperCase();
  }
  if (isUpper(found[0])) return replacement[0].toUpperCase() + replacement.slice(1);
  return replacement;
}

const clean = (s) => s.replace(/\s+/g, ' ');

function contextOf(original, start, end, replacement) {
  const L = 60;
  const bStart = Math.max(0, start - L);
  const aEnd = Math.min(original.length, end + L);
  return {
    before: (bStart > 0 ? '…' : '') + clean(original.slice(bStart, start)),
    found: original.slice(start, end),
    replacement,
    after: clean(original.slice(end, aEnd)) + (aEnd < original.length ? '…' : ''),
  };
}

// ---------------------------------------------------------------------------
// 1. Masking
// ---------------------------------------------------------------------------

function matchingBracket(src, from) {
  // src[from..from+1] === '[['. Returns the index just after the matching ']]' (or src.length).
  let depth = 0;
  for (let i = from; i < src.length - 1; i++) {
    if (src[i] === '[' && src[i + 1] === '[') {
      depth++;
      i++;
    } else if (src[i] === ']' && src[i + 1] === ']') {
      depth--;
      i++;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

export function buildMask(src, { skipQuotes = true } = {}) {
  const n = src.length;
  const hard = new Uint8Array(n); // never read, never edit
  const prot = new Uint8Array(n); // readable for context, but never edited
  const markH = (a, b) => hard.fill(1, Math.max(0, a), Math.min(n, b));
  const markP = (a, b) => prot.fill(1, Math.max(0, a), Math.min(n, b));
  const each = (re, fn) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      fn(m);
      if (m[0].length === 0) re.lastIndex++;
    }
  };

  // Comments and whole blocks that are not prose.
  each(/<!--[\s\S]*?(?:-->|$)/g, (m) => markH(m.index, m.index + m[0].length));
  each(
    /<(nowiki|pre|code|math|syntaxhighlight|source|script|style|gallery|tabber|poem|blockquote|ref|references|score|timeline|imagemap|inputbox|charinsert|templatestyles|noinclude|includeonly|onlyinclude)\b(?![^>]*\/>)[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,
    (m) => markH(m.index, m.index + m[0].length)
  );

  // Templates {{ ... }} with nesting.
  {
    let depth = 0;
    let start = -1;
    for (let i = 0; i < n - 1; i++) {
      if (src[i] === '{' && src[i + 1] === '{') {
        if (depth === 0) start = i;
        depth++;
        i++;
      } else if (src[i] === '}' && src[i + 1] === '}' && depth > 0) {
        depth--;
        i++;
        if (depth === 0) markH(start, i + 1);
      }
    }
    if (depth > 0) markH(start, n);
  }

  // Line-based markup: tables, headings, list markers, rules.
  {
    let pos = 0;
    for (const line of src.split('\n')) {
      const a = pos;
      const b = pos + line.length;
      pos = b + 1;
      if (/^\s*(?:\{\||\|\}|\|-|\|\+)/.test(line)) {
        markH(a, b);
        continue;
      }
      if (/^\s*[|!]/.test(line)) {
        const lead = /^\s*[|!]+/.exec(line)[0];
        markH(a, a + lead.length);
        const rest = line.slice(lead.length);
        const attr = /^((?:\s*[\w-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s|]+))+\s*)\|(?!\|)/.exec(rest);
        if (attr) markH(a + lead.length, a + lead.length + attr[0].length);
        for (const sep of line.matchAll(/\|\||!!/g)) markH(a + sep.index, a + sep.index + 2);
        continue;
      }
      const h = /^(={1,6})(.*?)(={1,6})[ \t]*$/.exec(line);
      if (h) {
        markH(a, a + h[1].length);
        markH(b - h[3].length - (line.length - line.trimEnd().length), b);
        continue;
      }
      const lm = /^[*#:;]+/.exec(line);
      if (lm) markH(a, a + lm[0].length);
      if (/^-{4,}\s*$/.test(line)) markH(a, b);
    }
  }

  // Links. Namespaced/interwiki links (File:, Category:, w:c:...) are masked completely.
  each(/\[\[\s*[A-Za-z_]{1,20}:/g, (m) => markH(m.index, matchingBracket(src, m.index)));
  each(/\[\[([^\[\]|\n]*)\|([^\[\]\n]*)\]\]/g, (m) => {
    markH(m.index, m.index + 2 + m[1].length + 1); // [[Target|
    markH(m.index + m[0].length - 2, m.index + m[0].length); // ]]
  });
  each(/\[\[([^\[\]|\n]*)\]\]/g, (m) => {
    markH(m.index, m.index + 2);
    markH(m.index + m[0].length - 2, m.index + m[0].length);
    markP(m.index + 2, m.index + m[0].length - 2); // visible link text: read-only
  });
  each(/\[(?:https?:)?\/\/[^\s\]]+[^\]\n]*\]/gi, (m) => markH(m.index, m.index + m[0].length));
  each(/https?:\/\/[^\s<>\[\]|"]+/gi, (m) => markH(m.index, m.index + m[0].length));
  each(/\bwww\.[^\s<>\[\]|"]+/gi, (m) => markH(m.index, m.index + m[0].length));

  // Tags, entities, emphasis marks, magic words.
  each(/<\/?[A-Za-z][^<>]{0,500}>/g, (m) => markH(m.index, m.index + m[0].length));
  each(/&(?:#\d+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g, (m) => markH(m.index, m.index + m[0].length));
  each(/'{2,}/g, (m) => markH(m.index, m.index + m[0].length));
  each(/__[A-Z]+__|~{3,5}/g, (m) => markH(m.index, m.index + m[0].length));

  // Build the masked copy.
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = hard[i] ? MASK : src[i];
  const text = out.join('');

  // Quoted dialogue is readable for context but never edited.
  if (skipQuotes) {
    each2(text, /"[^"\n]{1,600}"/g, (m) => markP(m.index, m.index + m[0].length));
    each2(text, /“[^”\n]{1,600}”/g, (m) => markP(m.index, m.index + m[0].length));
  }
  return { text, hard, prot };
}

function each2(text, re, fn) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    fn(m);
    if (m[0].length === 0) re.lastIndex++;
  }
}

// ---------------------------------------------------------------------------
// 2. Analysis
// ---------------------------------------------------------------------------

const U_SOUND = /^(uni(?![mn])|use|usa|usu|uti|ubi|uk|ufo|ura|ure|uro|eu|ew|one|once|ut[eo])/;
const SILENT_H = /^(hour|honest|honou?r|heir)/;

// ctx: {
//   rulesOn:Set<string>, dict:Map, ignore:Set<string>, ignorePhrases:string[], titleWords:Set,
//   glue:Set, abbr:Set, repeatOk:Set, lowercaseNames:Set, skipQuotes:boolean
// }
export function analyze(original, ctx) {
  const { text, hard, prot } = buildMask(original, { skipQuotes: ctx.skipQuotes });
  const n = original.length;
  const raw = [];
  const on = (id) => ctx.rulesOn.has(id);

  const nearIgnored = (start, end) => {
    if (ctx.ignore.size) {
      const win = text.slice(Math.max(0, start - 20), Math.min(n, end + 20));
      for (const m of win.matchAll(new RegExp(WORD, 'gu'))) {
        if (ctx.ignore.has(m[0].toLowerCase())) return true;
      }
    }
    if (ctx.ignorePhrases.length) {
      const win = original.slice(Math.max(0, start - 60), Math.min(n, end + 60)).toLowerCase();
      if (ctx.ignorePhrases.some((p) => win.includes(p))) return true;
    }
    return false;
  };

  const add = (rule, start, end, replacement) => {
    if (start < 0 || end > n || end <= start) return;
    for (let i = start; i < end; i++) if (hard[i] || prot[i]) return;
    const found = original.slice(start, end);
    if (found === replacement) return;
    if (nearIgnored(start, end)) return;
    raw.push({ rule, start, end, found, replacement, ctx: contextOf(original, start, end, replacement) });
  };

  // --- known_misspelling ---
  if (on('known_misspelling')) {
    for (const m of text.matchAll(new RegExp(WORD, 'gu'))) {
      const lower = m[0].toLowerCase();
      const right = ctx.dict.get(lower);
      if (!right || ctx.titleWords.has(lower)) continue;
      add('known_misspelling', m.index, m.index + m[0].length, matchCase(m[0], right));
    }
  }

  // --- repeated_word ---
  if (on('repeated_word')) {
    const re = new RegExp(`${NB}([\\p{L}\\p{M}]{2,})([ \\t]+)\\1${NA}`, 'giu');
    for (const m of text.matchAll(re)) {
      const w = m[1];
      if (ctx.repeatOk.has(w.toLowerCase())) continue;
      const secondStart = m.index + w.length + m[2].length;
      if (w.length >= 3 && isUpper(w[0]) && isUpper(text[secondStart])) continue; // Bora Bora
      add('repeated_word', m.index + w.length, m.index + m[0].length, '');
    }
  }

  // --- lowercase_after_period ---
  if (on('lowercase_after_period')) {
    const re = /(?<=\p{Ll})\.([ \t]+)(\p{Ll}[\p{L}\p{M}]*(?:['’][\p{L}\p{M}]+)*)/gu;
    for (const m of text.matchAll(re)) {
      const dot = m.index;
      let i = dot - 1;
      while (i >= 0 && /[\p{L}\p{M}.]/u.test(text[i])) i--;
      const chunk = text.slice(i + 1, dot).toLowerCase();
      if (chunk.includes('.') || chunk.length <= 1 || ctx.abbr.has(chunk)) continue;
      const word = m[2];
      if (/\p{Lu}/u.test(word.slice(1))) continue; // iPhone, eBay
      if (ctx.lowercaseNames.has(word.toLowerCase())) continue;
      const s = m.index + 1 + m[1].length;
      add('lowercase_after_period', s, s + 1, word[0].toUpperCase());
    }
  }

  // --- capital_glue_after_comma ---
  if (on('capital_glue_after_comma')) {
    const re = /([,;])([ \t]+)(\p{Lu}[\p{L}\p{M}]*)(?![\p{L}\p{M}\p{N}_'’])/gu;
    for (const m of text.matchAll(re)) {
      const w = m[3];
      if (!ctx.glue.has(w.toLowerCase())) continue;
      if (w.length > 1 && w === w.toUpperCase()) continue;
      const after = text.slice(m.index + m[0].length);
      if (/^[ \t]+\p{Lu}/u.test(after)) continue; // looks like a title or name
      const s = m.index + 1 + m[2].length;
      add('capital_glue_after_comma', s, s + 1, w[0].toLowerCase());
    }
  }

  // --- missing_space_after_period ---
  if (on('missing_space_after_period')) {
    const re = new RegExp(`${NB}(\\p{L}{2,})\\.(\\p{Lu}\\p{Ll}{2,})`, 'gu');
    for (const m of text.matchAll(re)) {
      if (ctx.abbr.has(m[1].toLowerCase())) continue;
      const dot = m.index + m[1].length;
      add('missing_space_after_period', dot, dot + 2, `. ${m[2][0]}`);
    }
  }

  // --- missing_space_after_comma ---
  if (on('missing_space_after_comma')) {
    const re = /(?<=(\p{L}+))([,;])(?=(\p{L}+))/gu;
    for (const m of text.matchAll(re)) {
      if (m[1].length === 1 && m[3].length === 1) continue; // A,B
      add('missing_space_after_comma', m.index, m.index + 2, `${m[2]} ${text[m.index + 1]}`);
    }
  }

  // --- space_before_punctuation ---
  if (on('space_before_punctuation')) {
    const re = /(?<=[\p{L}\p{N}])([ \t]+)([,;]|\.(?!\.))(?=[ \t]|$)/gmu;
    for (const m of text.matchAll(re)) add('space_before_punctuation', m.index, m.index + m[0].length, m[2]);
  }

  // --- double_punctuation ---
  if (on('double_punctuation')) {
    for (const m of text.matchAll(/(?<=[\p{L}\p{N}])(,{2,}|;{2,})/gu)) {
      add('double_punctuation', m.index, m.index + m[0].length, m[0][0]);
    }
    for (const m of text.matchAll(/(?<=[\p{L}\p{N}])\.\.(?!\.)/gu)) {
      add('double_punctuation', m.index, m.index + 2, '.');
    }
  }

  // --- a_an ---
  if (on('a_an')) {
    const re = new RegExp(`${NB}(an?)([ \\t]+)${MASK}*([\\p{L}][\\p{L}\\p{M}'’]*)`, 'giu');
    for (const m of text.matchAll(re)) {
      const art = m[1];
      const word = m[3];
      if (word.length <= 1 || word === word.toUpperCase()) continue; // single letters, acronyms
      const wl = word.toLowerCase();
      const wordEnd = m.index + m[0].length;
      if (/\d/.test(text[wordEnd] || '')) continue; // mp3, x2...
      const startsVowel = /^[aeiou]/.test(wl);
      const uSound = U_SOUND.test(wl);
      const silentH = SILENT_H.test(wl);
      let want = null;
      if (art.toLowerCase() === 'a') {
        if ((startsVowel && !uSound) || silentH) want = 'an';
      } else if (uSound) {
        want = 'a';
      } else if (!startsVowel && !silentH && /^[b-df-gj-np-tv-z]/.test(wl)) {
        want = 'a';
      }
      if (want) add('a_an', m.index, m.index + art.length, matchCase(art, want));
    }
  }

  // Resolve overlaps (earlier start wins; ties go to the rule listed first), then count.
  raw.sort((x, y) => x.start - y.start || RULE_BY_ID.get(x.rule).priority - RULE_BY_ID.get(y.rule).priority);
  const findings = [];
  let lastEnd = -1;
  for (const f of raw) {
    if (f.start < lastEnd) continue;
    findings.push(f);
    lastEnd = f.end;
  }
  const counts = {};
  for (const f of findings) counts[f.rule] = (counts[f.rule] || 0) + 1;

  const words = (text.match(new RegExp(WORD, 'gu')) || []).length;
  return { findings, counts, words, text };
}

// ---------------------------------------------------------------------------
// Rare-word statistics (used by the rare_word_suggestion rule)
// ---------------------------------------------------------------------------

// Calls onToken(word, index) for every pure-lowercase word of 4+ letters in the masked text.
export function lowerTokens(text, onToken) {
  const re = new RegExp(`${NB}([a-z]{4,})${NA}`, 'g');
  for (const m of text.matchAll(re)) onToken(m[1], m.index);
}

export function edits1(word) {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const out = new Set();
  for (let i = 0; i <= word.length; i++) {
    const L = word.slice(0, i);
    const R = word.slice(i);
    if (R) out.add(L + R.slice(1)); // delete
    if (R.length > 1) out.add(L + R[1] + R[0] + R.slice(2)); // swap
    for (const c of letters) {
      if (R) out.add(L + c + R.slice(1)); // replace
      out.add(L + c + R); // insert
    }
  }
  out.delete(word);
  return out;
}

// True when the two words differ only by a harmless ending (plural, -ed, -er, -y, -e).
export function endingOnlyDifference(a, b) {
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return l.length === s.length + 1 && l.startsWith(s) && 'sdrye'.includes(l[l.length - 1]);
}

// ---------------------------------------------------------------------------
// 3. Applying fixes
// ---------------------------------------------------------------------------

// findings must be non-overlapping (analyze() guarantees that). Each fix is verified against the
// real text before it is applied; anything that no longer matches is skipped.
export function applyFindings(original, findings) {
  let out = original;
  const applied = [];
  const skipped = [];
  for (const f of [...findings].sort((a, b) => b.start - a.start)) {
    if (out.slice(f.start, f.end) !== f.found) {
      skipped.push(f);
      continue;
    }
    out = out.slice(0, f.start) + f.replacement + out.slice(f.end);
    applied.push(f);
  }
  return { text: out, applied: applied.reverse(), skipped };
}

// Pages can opt out with {{nobots}} or {{bots|deny=all}} / {{bots|deny=StubManager}}.
export function optedOut(wikitext, botName = 'StubManager') {
  if (/\{\{\s*nobots\s*\}\}/i.test(wikitext)) return true;
  const m = /\{\{\s*bots\s*\|[^}]*deny\s*=\s*([^}|]*)/i.exec(wikitext);
  if (!m) return false;
  const v = m[1].toLowerCase();
  return v.includes('all') || v.includes(botName.toLowerCase());
}
