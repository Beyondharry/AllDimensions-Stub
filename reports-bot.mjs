// reports-bot.mjs — StubManager report tasks (read-only on articles; writes only its own report pages)
//
//   1. Wanted pages        — red links ranked by how many pages link to them
//   2. Unlinked mentions   — for orphaned pages, where their name appears as plain text
//                            (including via redirect aliases), i.e. "add a link here" suggestions
//
// Settings: Wiki (User:StubManager/Configurations) > Secrets (env) > Inline defaults.
// Shares the same config page, trusted-editor rules and `enabled` soft stop as stub-bot.mjs.

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DRY_RUN,
  BATCH_SIZE,
  READ_CONCURRENCY,
  api,
  login,
  getCsrfToken,
  savePage,
  getCategories,
  loadTrustedConfig,
  revertConfigPage,
  resolveLayers,
  P,
  chunk,
  mapPool,
  normalizeTitle,
  normalizeCategory,
  escapeRegExp,
} from './core.mjs';

const CONFIG_PAGE = 'User:StubManager/Configurations';
const OWNER = 'PUREDARK999';
const OUT_DIR = process.env.OUT_DIR || 'out'; // where DRY_RUN writes .wiki files
const STOP_CHECK_EVERY = 20;   // re-read the trusted config every N content batches
const SOURCE_KEEP_LIMIT = 200; // max distinct source pages remembered per orphan
const GENERIC_THRESHOLD = 40;  // this many mentioning pages => probably a common word

// ---------- configuration ----------

const DEFAULTS = {
  enabled: true,            // global soft stop (shared with stub-bot.mjs)
  wanted_enabled: true,
  mentions_enabled: true,
  reports_prefix: 'User:StubManager/Reports/',
  exempt_categories: ['googology', 'salad numbers', 'stub exempt'],
  exempt_titles: ['main page'],
  exempt_title_regex: '',
  wanted_min_links: 2,      // a red link needs at least this many linking pages to be listed
  wanted_max_rows: 300,
  mentions_max_orphans: 150, // how many orphans to analyse per run (largest first)
  mentions_max_sources: 8,   // example pages listed per orphan
  mentions_min_title_length: 4,
};

const SECRETS = {
  enabled: process.env.ENABLED,
  wanted_enabled: process.env.WANTED_ENABLED,
  mentions_enabled: process.env.MENTIONS_ENABLED,
  reports_prefix: process.env.REPORTS_PREFIX,
  exempt_categories: process.env.EXEMPT_CATEGORIES,
  exempt_titles: process.env.EXEMPT_TITLES,
  exempt_title_regex: process.env.EXEMPT_TITLE_REGEX,
  wanted_min_links: process.env.WANTED_MIN_LINKS,
  wanted_max_rows: process.env.WANTED_MAX_ROWS,
  mentions_max_orphans: process.env.MENTIONS_MAX_ORPHANS,
  mentions_max_sources: process.env.MENTIONS_MAX_SOURCES,
  mentions_min_title_length: process.env.MENTIONS_MIN_TITLE_LENGTH,
};

const PARSERS = {
  enabled: P.bool,
  wanted_enabled: P.bool,
  mentions_enabled: P.bool,
  reports_prefix: P.prefix,
  exempt_categories: P.categories,
  exempt_titles: P.titles,
  exempt_title_regex: P.regex,
  wanted_min_links: P.posint,
  wanted_max_rows: P.posint,
  mentions_max_orphans: P.posint,
  mentions_max_sources: P.posint,
  mentions_min_title_length: P.posint,
};

let cfg = null;

function finalizeConfig(wikiValues, quiet = false) {
  const c = resolveLayers({
    defaults: DEFAULTS,
    secrets: SECRETS,
    parsers: PARSERS,
    wiki: wikiValues,
    quiet,
  });
  c.titleSet = new Set(c.exempt_titles);
  c.titleRegex = c.exempt_title_regex ? new RegExp(c.exempt_title_regex, 'i') : null;
  return c;
}

const isExemptTitle = (title) =>
  cfg.titleSet.has(normalizeTitle(title)) || (cfg.titleRegex ? cfg.titleRegex.test(title) : false);

async function stillEnabled() {
  try {
    const { values } = await loadTrustedConfig({
      page: CONFIG_PAGE,
      owner: OWNER,
      keys: Object.keys(DEFAULTS),
    });
    return finalizeConfig(values, true).enabled;
  } catch (err) {
    console.warn(`Could not re-check config (${err.message}); continuing.`);
    return true;
  }
}

// ---------- scanning the wiki ----------

// One pass over mainspace: size, outgoing links and the redirects that point at each page.
async function scanGraph() {
  const pages = new Map(); // pageid -> { pageid, title, length, links:Set, redirects:Set }
  let cont = null;
  do {
    const res = await api({
      action: 'query',
      generator: 'allpages',
      gapnamespace: '0',
      gapfilterredir: 'nonredirects',
      gaplimit: 'max',
      prop: 'info|links|redirects',
      plnamespace: '0',
      pllimit: 'max',
      rdnamespace: '0',
      rdlimit: 'max',
      ...(cont || {}), // full continue object (gapcontinue, plcontinue, rdcontinue, ...)
    });
    for (const p of res.query?.pages || []) {
      let e = pages.get(p.pageid);
      if (!e) {
        e = { pageid: p.pageid, title: p.title, length: 0, links: new Set(), redirects: new Set() };
        pages.set(p.pageid, e);
      }
      if (p.length !== undefined) e.length = p.length;
      for (const l of p.links || []) e.links.add(l.title);
      for (const r of p.redirects || []) e.redirects.add(r.title);
    }
    cont = res.continue || null;
  } while (cont);
  return pages;
}

// Derives inbound links (crediting redirect targets), aliases and red links.
export function buildGraph(pages) {
  const byTitle = new Map();
  const existing = new Set();
  const redirectTarget = new Map();
  const aliases = new Map(); // page title -> [redirect titles]

  for (const e of pages.values()) {
    byTitle.set(e.title, e);
    existing.add(e.title);
    for (const r of e.redirects) {
      redirectTarget.set(r, e.title);
      existing.add(r);
      if (!aliases.has(e.title)) aliases.set(e.title, []);
      aliases.get(e.title).push(r);
    }
  }

  const inbound = new Map();
  for (const e of pages.values()) inbound.set(e.title, new Set());
  const wanted = new Map(); // red-linked title -> Set(linking page titles)

  for (const e of pages.values()) {
    for (const t of e.links) {
      const target = redirectTarget.get(t) ?? t; // a link to a redirect counts for its target
      if (byTitle.has(target)) {
        if (target !== e.title) inbound.get(target).add(e.title);
      } else if (!existing.has(t)) {
        if (!wanted.has(t)) wanted.set(t, new Set());
        wanted.get(t).add(e.title);
      }
    }
  }
  return { byTitle, existing, aliases, inbound, wanted };
}

// Double-check candidate red links against the wiki (catches e.g. redirects to redirects).
async function filterMissing(titles) {
  const missing = new Set();
  await mapPool(chunk(titles, BATCH_SIZE), READ_CONCURRENCY, async (batch) => {
    const res = await api({ action: 'query', titles: batch.join('|') });
    for (const p of res.query?.pages || []) if (p.missing) missing.add(p.title);
  });
  return missing;
}

// ---------- task 1: wanted pages ----------

function hintFor(title, lowerIndex) {
  const lower = title.toLowerCase();
  for (const c of [lower, lower.replace(/s$/, ''), `${lower}s`]) {
    const hit = lowerIndex.get(c);
    if (hit && hit !== title) return hit;
  }
  return '';
}

export function selectWanted(g, minLinks) {
  const lowerIndex = new Map();
  for (const t of g.existing) {
    const k = t.toLowerCase();
    if (!lowerIndex.has(k)) lowerIndex.set(k, t);
  }
  const rows = [...g.wanted]
    .map(([title, set]) => ({ title, sources: [...set].sort(), total: set.size }))
    .filter((r) => r.total >= minLinks)
    .sort((a, b) => b.total - a.total || a.title.localeCompare(b.title));
  return { rows, lowerIndex };
}

const L = (t) => `[[:${t}]]`;
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

export function buildWantedReport(rows, lowerIndex, meta) {
  const lines = [
    `''Auto-generated by [[User:StubManager|StubManager]] on ${stamp()}. This page is overwritten on every run; do not edit it.''`,
    '',
    '== Summary ==',
    `* '''Distinct red-linked titles in mainspace:''' ${meta.totalRedlinks.toLocaleString('en-US')}`,
    `* '''Linked from at least ${meta.minLinks} pages:''' ${meta.qualifying.toLocaleString('en-US')}`,
    `* '''Rows shown:''' ${rows.length.toLocaleString('en-US')}`,
    '',
    '== Wanted pages ==',
    "Titles that many pages link to but that do not exist yet. Either create the page, create a redirect, or fix the links. A ''Hint'' means a very similar page already exists (different capitalisation or a plural/singular form).",
    '',
    '{| class="wikitable sortable"',
    '! # !! Missing page !! Linked from !! Hint !! Example pages',
  ];
  rows.forEach((r, i) => {
    const hint = hintFor(r.title, lowerIndex);
    const examples =
      r.sources.slice(0, 5).map(L).join(', ') +
      (r.sources.length > 5 ? ` ''(+${r.sources.length - 5} more)''` : '');
    lines.push('|-');
    lines.push(`| ${i + 1} || ${L(r.title)} || ${r.total} || ${hint ? L(hint) : ''} || ${examples}`);
  });
  lines.push('|}', '');
  return lines.join('\n');
}

// ---------- task 2: unlinked mentions of orphans ----------

// Remove templates ({{...}}, nesting-safe) so infoboxes/navboxes don't produce noise.
export function stripTemplates(text) {
  const out = [];
  let depth = 0;
  for (let i = 0; i < text.length; ) {
    if (text[i] === '{' && text[i + 1] === '{') {
      depth++;
      i += 2;
    } else if (text[i] === '}' && text[i + 1] === '}' && depth > 0) {
      depth--;
      i += 2;
    } else {
      if (depth === 0) out.push(text[i]);
      i++;
    }
  }
  return out.join('');
}

// Plain prose only: no comments, refs, templates, links (already linked text is not "unlinked"), tags.
export function plainText(wikitext) {
  let t = wikitext
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(nowiki|ref|gallery|pre|syntaxhighlight|source|script|style|tabber)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<ref\b[^>]*\/>/gi, ' ');
  t = stripTemplates(t);
  t = t
    .replace(/\[\[[^\]]*\]\]/g, ' ')                     // wikilinks, files, categories
    .replace(/\[https?:\/\/[^\s\]]+(?:\s+[^\]]*)?\]/g, ' ') // external links
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s*(?:\{\||\|\}|\|-).*$/gm, ' ')           // table scaffolding
    .replace(/'{2,}/g, '');                              // bold/italic markup
  return t;
}

// Single-word names must match exactly (so "Void" doesn't match the common word "void");
// multi-word names may differ in the first letter's case.
export function makeNameRegex(name) {
  const words = name.split(' ');
  const first = name[0];
  let pattern = escapeRegExp(name);
  if (words.length > 1 && first.toLowerCase() !== first.toUpperCase()) {
    pattern = `[${first.toUpperCase()}${first.toLowerCase()}]${escapeRegExp(name.slice(1))}`;
  }
  return new RegExp(`(?<![\\p{L}\\p{N}_])${pattern}(?![\\p{L}\\p{N}_])`, 'gu');
}

export function buildMatcher(title, aliasTitles, minLen) {
  const names = [title, ...(aliasTitles || [])].filter((n) => n.length >= minLen);
  if (!names.length) return null;
  return {
    title,
    entries: names.map((name) => ({ name, lower: name.toLowerCase(), re: makeNameRegex(name) })),
  };
}

function makeSnippet(text, idx, len) {
  const start = Math.max(0, idx - 50);
  const end = Math.min(text.length, idx + len + 50);
  const clean = (s) => s.replace(/\s+/g, ' ').replace(/<\/?nowiki>/gi, '');
  const before = clean(text.slice(start, idx)).replace(/^\s+/, '');
  const match = clean(text.slice(idx, idx + len));
  const after = clean(text.slice(idx + len, end)).replace(/\s+$/, '');
  return (
    (start > 0 ? '…' : '') +
    `<nowiki>${before}</nowiki>'''<nowiki>${match}</nowiki>'''<nowiki>${after}</nowiki>` +
    (end < text.length ? '…' : '')
  );
}

export function scanText(sourceTitle, wikitext, matchers, results) {
  const text = plainText(wikitext);
  if (!text.trim()) return;
  const lower = text.toLowerCase();
  for (const m of matchers) {
    if (m.title === sourceTitle) continue;
    for (const entry of m.entries) {
      if (!lower.includes(entry.lower)) continue; // cheap pre-check before the regex
      const hits = [...text.matchAll(entry.re)];
      if (!hits.length) continue;
      const r = results.get(m.title);
      r.total++;
      if (r.sources.size < SOURCE_KEEP_LIMIT) {
        r.sources.set(sourceTitle, {
          count: hits.length,
          snippet: makeSnippet(text, hits[0].index, hits[0][0].length),
        });
      }
      break; // one matching name per source page is enough
    }
  }
}

// Streams every article's wikitext in batches and matches as it goes (no need to keep it all in memory).
async function scanMentions(allPages, matchers) {
  const results = new Map();
  for (const m of matchers) results.set(m.title, { total: 0, sources: new Map() });

  let started = 0;
  let stopped = false;
  await mapPool(chunk(allPages, BATCH_SIZE), READ_CONCURRENCY, async (batch) => {
    if (stopped) return;
    if (++started % STOP_CHECK_EVERY === 0 && !(await stillEnabled())) {
      stopped = true;
      console.log('Stop requested via config page (enabled = false); halting scan.');
      return;
    }
    let cont = null;
    do {
      const res = await api({
        action: 'query',
        prop: 'revisions',
        pageids: batch.map((p) => p.pageid).join('|'),
        rvprop: 'content',
        rvslots: 'main',
        ...(cont || {}),
      });
      for (const p of res.query?.pages || []) {
        const content = p.revisions?.[0]?.slots?.main?.content;
        if (content !== undefined) scanText(p.title, content, matchers, results);
      }
      cont = res.continue || null;
    } while (cont);
  });
  return { results, stopped };
}

export function buildMentionsReport(analysis, maxSources) {
  const { totalOrphans, analysed, skippedShort, rows, noMention } = analysis;
  const lines = [
    `''Auto-generated by [[User:StubManager|StubManager]] on ${stamp()}. This page is overwritten on every run; do not edit it.''`,
    '',
    '== Summary ==',
    `* '''Orphaned pages (no incoming links from other articles):''' ${totalOrphans.toLocaleString('en-US')}`,
    `* '''Analysed this run (largest first):''' ${analysed.toLocaleString('en-US')}`,
    `* '''With unlinked mentions found:''' ${rows.length.toLocaleString('en-US')}`,
    `* '''Without any mention:''' ${noMention.length.toLocaleString('en-US')}`,
    ...(skippedShort ? [`* '''Skipped (title too short to match safely):''' ${skippedShort}`] : []),
    '',
    '== Orphans that are mentioned in plain text ==',
    "Each row is an orphaned page together with other articles that write its name (or a redirect alias) without linking it. Adding a link from one of those pages fixes the orphan. Names mentioned on ''very many'' pages are listed last, since they are often ordinary words.",
    '',
    '{| class="wikitable sortable"',
    '! Orphaned page !! Also known as !! Pages mentioning it !! Where it appears',
  ];

  for (const r of rows) {
    const shown = r.sources.slice(0, maxSources);
    lines.push('|-');
    lines.push(`| ${L(r.title)}`);
    lines.push(`| ${r.aliases.map((a) => `<nowiki>${a}</nowiki>`).join(', ')}`);
    lines.push(`| ${r.total}${r.generic ? " ''(very common)''" : ''}`);
    lines.push('|');
    for (const s of shown) {
      lines.push(`* ${L(s.title)}${s.count > 1 ? ` ×${s.count}` : ''}: ${s.snippet}`);
    }
    if (r.total > shown.length) lines.push(`* ''(+${r.total - shown.length} more)''`);
  }
  lines.push('|}');

  lines.push('', '== Orphans with no mention anywhere ==');
  lines.push('These need a human: nobody refers to them by name in plain text either.', '');
  for (const o of noMention) lines.push(`* ${L(o.title)} (${o.length.toLocaleString('en-US')} bytes)`);
  lines.push('');
  return lines.join('\n');
}

// ---------- publishing ----------

async function publish(title, text, summary, token) {
  if (DRY_RUN) {
    await fs.mkdir(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, `${title.replace(/[^\w.-]+/g, '_')}.wiki`);
    await fs.writeFile(file, text, 'utf8');
    console.log(`[DRY RUN] Wrote ${file}`);
    return;
  }
  const result = await savePage(title, text, summary, token);
  console.log(`Saved "${title}" (${result}).`);
}

// ---------- main ----------

async function main() {
  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  await login();
  const token = DRY_RUN ? null : await getCsrfToken();

  const { values, revert } = await loadTrustedConfig({
    page: CONFIG_PAGE,
    owner: OWNER,
    keys: Object.keys(DEFAULTS),
  });
  if (revert) await revertConfigPage(revert, token, { page: CONFIG_PAGE, owner: OWNER });
  cfg = finalizeConfig(values);

  if (!cfg.enabled) {
    console.log('Bot is disabled (enabled = false). Exiting without edits.');
    return;
  }
  if (!cfg.wanted_enabled && !cfg.mentions_enabled) {
    console.log('Both report tasks are disabled. Nothing to do.');
    return;
  }

  console.log('Scanning mainspace...');
  const pages = await scanGraph();
  const g = buildGraph(pages);
  console.log(`Scanned ${pages.size} articles in ${elapsed()}.`);

  // ----- Task 1: wanted pages -----
  if (cfg.wanted_enabled) {
    const { rows, lowerIndex } = selectWanted(g, cfg.wanted_min_links);
    const candidates = rows.slice(0, cfg.wanted_max_rows * 2);
    const missing = await filterMissing(candidates.map((r) => r.title));
    const finalRows = candidates.filter((r) => missing.has(r.title)).slice(0, cfg.wanted_max_rows);

    const text = buildWantedReport(finalRows, lowerIndex, {
      totalRedlinks: g.wanted.size,
      qualifying: rows.length,
      minLinks: cfg.wanted_min_links,
    });
    await publish(
      `${cfg.reports_prefix}Wanted pages`,
      text,
      `Bot: Updating wanted pages report (${finalRows.length} rows)`,
      token
    );
  }

  // ----- Task 2: unlinked mentions of orphans -----
  if (cfg.mentions_enabled && (await stillEnabled())) {
    let orphans = [...g.byTitle.values()].filter(
      (e) => g.inbound.get(e.title).size === 0 && !isExemptTitle(e.title)
    );

    if (cfg.exempt_categories.length && orphans.length) {
      const cats = await getCategories(orphans.map((o) => o.pageid));
      orphans = orphans.filter(
        (o) => !(cats.get(o.pageid) || []).some((c) => cfg.exempt_categories.includes(normalizeCategory(c)))
      );
    }

    orphans.sort((a, b) => b.length - a.length || a.title.localeCompare(b.title));
    const selected = orphans.slice(0, cfg.mentions_max_orphans);

    const matchers = [];
    const aliasByTitle = new Map();
    let skippedShort = 0;
    for (const o of selected) {
      const aliases = (g.aliases.get(o.title) || []).slice().sort();
      aliasByTitle.set(o.title, aliases);
      const m = buildMatcher(o.title, aliases, cfg.mentions_min_title_length);
      if (m) matchers.push(m);
      else skippedShort++;
    }
    console.log(`${orphans.length} orphans; matching ${matchers.length} of them against all articles...`);

    const { results, stopped } = await scanMentions([...g.byTitle.values()], matchers);
    if (stopped) {
      console.log('Mentions scan was stopped early; not publishing a partial report.');
    } else {
      const rows = [];
      const noMention = [];
      for (const o of selected) {
        const r = results.get(o.title);
        if (!r) continue;
        if (r.total === 0) {
          noMention.push({ title: o.title, length: o.length });
          continue;
        }
        const sources = [...r.sources]
          .map(([title, v]) => ({ title, ...v }))
          .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
        rows.push({
          title: o.title,
          aliases: aliasByTitle.get(o.title) || [],
          total: r.total,
          sources,
          generic: r.total >= GENERIC_THRESHOLD,
        });
      }
      rows.sort((a, b) => Number(a.generic) - Number(b.generic) || b.total - a.total || a.title.localeCompare(b.title));

      const text = buildMentionsReport(
        { totalOrphans: orphans.length, analysed: matchers.length, skippedShort, rows, noMention },
        cfg.mentions_max_sources
      );
      await publish(
        `${cfg.reports_prefix}Unlinked mentions of orphaned pages`,
        text,
        `Bot: Updating unlinked mentions report (${rows.length} orphans with mentions)`,
        token
      );
    }
  }

  console.log(`Done in ${elapsed()}.`);
}

// Run only when executed directly (so the pure functions can be imported for testing).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
