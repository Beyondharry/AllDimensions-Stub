// grammar-bot.mjs — StubManager's spelling & grammar task.
//
//   Phase 1  mode = report   Detailed report pages only. Nothing is edited.
//   Phase 2  mode = preview  Also shows exactly which edits approved rules WOULD make. Still no edits.
//   Phase 3  mode = apply    Makes the edits for rules that an admin approved AND that have review evidence.
//
// Settings live on User:StubManager/Configurations/Grammar (trusted editors only; others are reverted).
// Priority: Wiki > Secrets (env GRAMMAR_<KEY>) > Inline defaults.  `enabled = false` on either that page
// or the main User:StubManager/Configurations page stops the bot (it re-checks while running).

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
  loadTrustedPage,
  loadTrustedConfig,
  parseKeyValues,
  revertConfigPage,
  resolveLayersDetailed,
  P,
  chunk,
  mapPool,
  normalizeTitle,
  sleep,
  ApiError,
} from './core.mjs';
import {
  RULES,
  RULE_BY_ID,
  DEFAULT_ABBREVIATIONS,
  DEFAULT_GLUE_WORDS,
  DEFAULT_REPEAT_OK,
  analyze,
  applyFindings,
  lowerTokens,
  edits1,
  endingOnlyDifference,
  optedOut,
} from './grammar-rules.mjs';
import {
  buildHub,
  buildRulePage,
  buildWorstPages,
  buildSkippedPages,
  buildPlannedFixes,
  buildFixLog,
  buildConfigTemplate,
  fixLogRow,
  parseFixLogRows,
  FIX_LOG_MAX_ROWS,
  rulePageTitle,
  ruleStatus,
  ruleEnabled,
  highlight,
} from './grammar-reports.mjs';

const MAIN_CONFIG_PAGE = 'User:StubManager/Configurations';
const GRAMMAR_CONFIG_PAGE = 'User:StubManager/Configurations/Grammar';
const OWNER = 'PureNocturne';
const OUT_DIR = process.env.OUT_DIR || 'out';
const STOP_CHECK_EVERY = 20;     // content batches between soft-stop re-checks
const EDIT_STOP_CHECK_EVERY = 5; // edits between soft-stop re-checks
const MAX_STORED_PER_PAGE = 300; // findings remembered per page (counts are always exact)
const RULE_IDS = RULES.map((r) => r.id);

// ---------------------------------------------------------------------------
// Settings schema:  default value + parser.  Env secret name is GRAMMAR_<KEY>.
// ---------------------------------------------------------------------------

const parseRuleList = (v) => {
  const items = v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const ok = items.filter((i) => i === 'all' || RULE_IDS.includes(i));
  return ok.length ? ok : undefined;
};
const parseAutofix = (v) => {
  const items = v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const ok = items.filter((i) => RULE_IDS.includes(i));
  return ok.length ? ok : undefined;
};
const parseCatNames = (v) => {
  const items = v.split(',').map((s) => s.replace(/^Category:/i, '').replace(/_/g, ' ').trim()).filter(Boolean);
  return items.length ? items : undefined;
};
const parseBase = (v) => v.trim().replace(/_/g, ' ').replace(/\/+$/, '') || undefined;
const parsePercent = (v) => (/^\d{1,3}(\.\d+)?$/.test(v) && parseFloat(v) <= 100 ? parseFloat(v) : undefined);
const parseMode = (v) => (['report', 'preview', 'apply'].includes(v.toLowerCase()) ? v.toLowerCase() : undefined);

const SCHEMA = {
  enabled: [true, P.bool],
  mode: ['report', parseMode],
  rules_enabled: [['all'], parseRuleList],
  autofix_rules: [[], parseAutofix],
  autofix_min_reviewed: [50, P.posint],
  autofix_min_precision: [98, parsePercent],
  max_edits_per_run: [20, P.uint],
  max_fixes_per_page: [15, P.posint],
  min_page_age_hours: [24, P.uint],
  edit_interval_ms: [2500, P.uint],
  skip_quotes: [true, P.bool],
  exempt_categories: [['Typo exempt', 'Googology', 'Salad numbers', 'Stub exempt'], parseCatNames],
  exempt_titles: [['main page'], P.titles],
  exempt_title_regex: ['', P.regex],
  max_pages: [0, P.uint],
  reports_base: ['User:StubManager/Reports/Grammar', parseBase],
  report_rows_per_rule: [400, P.posint],
  report_max_per_page_per_rule: [5, P.posint],
  report_worst_pages: [300, P.posint],
  report_sample_size: [25, P.posint],
  freq_rare_max: [2, P.posint],
  freq_common_min: [30, P.posint],
  freq_ratio_min: [10, P.posint],
  freq_min_length: [5, P.posint],
  freq_max_rows: [300, P.posint],
};
const KEYS = Object.keys(SCHEMA);
const DEFAULTS = Object.fromEntries(KEYS.map((k) => [k, SCHEMA[k][0]]));
const PARSERS = Object.fromEntries(KEYS.map((k) => [k, SCHEMA[k][1]]));
const SECRETS = Object.fromEntries(KEYS.map((k) => [k, process.env[`GRAMMAR_${k.toUpperCase()}`]]));

// ---------------------------------------------------------------------------
// Config page parsing
// ---------------------------------------------------------------------------

function parseBlocks(text) {
  const blocks = {};
  for (const m of (text || '').matchAll(/<pre\s+class\s*=\s*"grammar-([a-z-]+)"[^>]*>([\s\S]*?)<\/pre>/gi)) {
    blocks[m[1].toLowerCase()] = m[2];
  }
  return blocks;
}
const dataLines = (t) => (t || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
const listItems = (t) => dataLines(t).flatMap((l) => l.split(',')).map((s) => s.trim()).filter(Boolean);

function extendList(defaults, blockText) {
  const set = new Set(defaults.map((d) => d.toLowerCase()));
  for (const item of listItems(blockText)) {
    if (item.startsWith('-')) set.delete(item.slice(1).trim().toLowerCase());
    else set.add(item.toLowerCase());
  }
  return set;
}

function parseReviews(blockText) {
  const out = new Map();
  for (const line of dataLines(blockText)) {
    const m = /^([a-z_]+)(?:@(\d+))?\s*=\s*(\d+)\s*,\s*(\d+)$/i.exec(line);
    if (!m) continue;
    const id = m[1].toLowerCase();
    const rule = RULE_BY_ID.get(id);
    const reviewed = parseInt(m[3], 10);
    const incorrect = parseInt(m[4], 10);
    if (!rule || incorrect > reviewed) continue;
    const version = m[2] === undefined ? null : parseInt(m[2], 10);
    out.set(id, { reviewed, incorrect, version, stale: version === null || version !== rule.version });
  }
  return out;
}

async function loadGrammarConfig(token, { quiet = false } = {}) {
  const main = await loadTrustedConfig({ page: MAIN_CONFIG_PAGE, owner: OWNER, keys: ['enabled'] });
  if (main.revert && token !== undefined) await revertConfigPage(main.revert, token, { page: MAIN_CONFIG_PAGE, owner: OWNER });
  const globalEnabled = P.bool(String(main.values.enabled ?? '').trim() || 'true') ?? true;

  const g = await loadTrustedPage({ page: GRAMMAR_CONFIG_PAGE, owner: OWNER });
  if (g.revert && token !== undefined) await revertConfigPage(g.revert, token, { page: GRAMMAR_CONFIG_PAGE, owner: OWNER });

  const text = g.text || '';
  const blocks = parseBlocks(text);
  const wiki = parseKeyValues(`<pre>${blocks.settings || ''}</pre>`, KEYS);
  const { values: cfg, sources } = resolveLayersDetailed({ defaults: DEFAULTS, secrets: SECRETS, parsers: PARSERS, wiki, quiet });

  // Safety: autofix may only list rules that exist; mode apply without rules does nothing.
  const ignoreItems = listItems(blocks.ignore);
  const misspellings = [];
  for (const line of dataLines(blocks.misspellings)) {
    const m = /^(\p{L}+)\s*->\s*(.{1,60})$/u.exec(line);
    if (m) misspellings.push([m[1].toLowerCase(), m[2].trim()]);
  }

  return {
    globalEnabled,
    cfg,
    sources,
    missing: g.missing,
    approval: g.meta,
    lists: {
      ignoreWords: new Set(ignoreItems.filter((i) => !/\s/.test(i)).map((i) => i.toLowerCase())),
      ignorePhrases: ignoreItems.filter((i) => /\s/.test(i)).map((i) => i.toLowerCase()),
      misspellings,
      glue: extendList(DEFAULT_GLUE_WORDS, blocks.glue),
      abbr: extendList(DEFAULT_ABBREVIATIONS, blocks.abbreviations),
      repeatOk: extendList(DEFAULT_REPEAT_OK, blocks['repeat-ok']),
      lowercaseNames: extendList([], blocks['lowercase-names']),
    },
    reviews: parseReviews(blocks.reviews),
  };
}

// ---------------------------------------------------------------------------
// Wiki reading
// ---------------------------------------------------------------------------

async function listAllpages(filterredir) {
  const out = [];
  let cont = null;
  do {
    const res = await api({
      action: 'query',
      list: 'allpages',
      apnamespace: '0',
      apfilterredir: filterredir,
      aplimit: 'max',
      ...(cont || {}),
    });
    for (const p of res.query?.allpages || []) out.push({ pageid: p.pageid, title: p.title });
    cont = res.continue || null;
  } while (cont);
  return out;
}

async function exemptMembers(categories) {
  const map = new Map(); // title -> category
  for (const cat of categories) {
    const name = cat.charAt(0).toUpperCase() + cat.slice(1);
    let cont = null;
    do {
      const res = await api({
        action: 'query',
        list: 'categorymembers',
        cmtitle: `Category:${name}`,
        cmnamespace: '0',
        cmlimit: 'max',
        cmtype: 'page',
        ...(cont || {}),
      });
      for (const m of res.query?.categorymembers || []) if (!map.has(m.title)) map.set(m.title, name);
      cont = res.continue || null;
    } while (cont);
  }
  return map;
}

async function readPage(title) {
  const res = await api({ action: 'query', prop: 'revisions', titles: title, rvprop: 'content', rvslots: 'main' });
  return res.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content ?? null;
}

// ---------------------------------------------------------------------------
// Rare-word suggestions
// ---------------------------------------------------------------------------

export function computeRareWords(freq, occ, ctx, cfg) {
  const rows = [];
  for (const [w, c] of freq) {
    if (c > cfg.freq_rare_max || w.length < cfg.freq_min_length) continue;
    if (ctx.titleWords.has(w) || ctx.ignore.has(w) || ctx.dict.has(w)) continue;
    let best = null;
    for (const v of edits1(w)) {
      const vc = freq.get(v);
      if (!vc || vc < cfg.freq_common_min || vc < cfg.freq_ratio_min * c) continue;
      if (v[0] !== w[0] || endingOnlyDifference(w, v)) continue;
      if (!best || vc > best.count) best = { word: v, count: vc };
    }
    if (best) {
      rows.push({
        word: w,
        count: c,
        suggestion: best.word,
        suggestionCount: best.count,
        score: best.count / c,
        occurrences: occ.get(w) || [],
      });
    }
  }
  rows.sort((a, b) => b.score - a.score || a.word.localeCompare(b.word));
  return rows;
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

async function publish(title, text, summary, token) {
  if (Buffer.byteLength(text, 'utf8') > 1_900_000) {
    text = `${text.slice(0, 1_800_000)}\n\n''(page truncated: too large)''`;
  }
  if (DRY_RUN) {
    await fs.mkdir(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, `${title.replace(/[^\w.-]+/g, '_')}.wiki`);
    await fs.writeFile(file, text, 'utf8');
    console.log(`[DRY RUN] Wrote ${file}`);
    return;
  }
  const result = await savePage(title, text, summary, token);
  console.log(`Saved "${title}" (${result}).`);
  await sleep(1000);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startedAt = new Date();
  await login();
  const token = DRY_RUN ? undefined : await getCsrfToken();

  let conf = await loadGrammarConfig(token);
  if (conf.missing) {
    const template = buildConfigTemplate(DEFAULTS, DEFAULTS.reports_base);
    if (DRY_RUN) {
      await fs.mkdir(OUT_DIR, { recursive: true });
      await fs.writeFile(path.join(OUT_DIR, 'Grammar_config_template.wiki'), template, 'utf8');
      console.log('[DRY RUN] Config page is missing; wrote a template to the output folder.');
    } else {
      await savePage(GRAMMAR_CONFIG_PAGE, template, 'Bot: Creating the Grammar bot configuration page with default settings', token);
      console.log(`Created ${GRAMMAR_CONFIG_PAGE} with default settings.`);
    }
  }

  const stillEnabled = async () => {
    try {
      const c = await loadGrammarConfig(undefined, { quiet: true });
      return c.globalEnabled && c.cfg.enabled;
    } catch (err) {
      console.warn(`Could not re-check config (${err.message}); continuing.`);
      return true;
    }
  };

  if (!conf.globalEnabled || !conf.cfg.enabled) {
    console.log('Grammar bot is disabled (enabled = false). Exiting.');
    return;
  }

  const { cfg, sources, lists, reviews } = conf;
  const effectiveMode = cfg.mode === 'apply' && DRY_RUN ? 'preview' : cfg.mode;
  if (cfg.mode === 'apply' && DRY_RUN) console.log('DRY_RUN is set: running apply mode as preview (no edits).');
  const base = cfg.reports_base;

  // --- dictionary & analysis context ---
  const fileJson = JSON.parse(await fs.readFile(new URL('./data/misspellings.json', import.meta.url), 'utf8'));
  const dict = new Map(fileJson.pairs);
  for (const [w, r] of lists.misspellings) dict.set(w, r);

  // --- titles ---
  console.log('Listing pages...');
  const articles = await listAllpages('nonredirects');
  const redirects = await listAllpages('redirects');
  const titleWords = new Set();
  for (const p of [...articles, ...redirects]) {
    for (const w of p.title.toLowerCase().match(/[\p{L}\p{M}]+/gu) || []) titleWords.add(w);
  }

  const ctx = {
    rulesOn: new Set(RULE_IDS.filter((id) => id !== 'rare_word_suggestion' && ruleEnabled(id, cfg))),
    dict,
    ignore: lists.ignoreWords,
    ignorePhrases: lists.ignorePhrases,
    titleWords,
    glue: lists.glue,
    abbr: lists.abbr,
    repeatOk: lists.repeatOk,
    lowercaseNames: lists.lowercaseNames,
    skipQuotes: cfg.skip_quotes,
  };
  const freqOn = ruleEnabled('rare_word_suggestion', cfg);

  // --- exemptions ---
  const exemptCat = await exemptMembers(cfg.exempt_categories);
  const titleSet = new Set(cfg.exempt_titles);
  const titleRegex = cfg.exempt_title_regex ? new RegExp(cfg.exempt_title_regex, 'i') : null;
  const skipped = [];
  const skippedCounts = { category: 0, title: 0, regex: 0, nobots: 0, limit: 0 };
  let pending = [];
  for (const a of articles) {
    if (exemptCat.has(a.title)) {
      skipped.push({ title: a.title, reason: 'In an exempt category', detail: `Category:${exemptCat.get(a.title)}` });
      skippedCounts.category++;
    } else if (titleSet.has(normalizeTitle(a.title))) {
      skipped.push({ title: a.title, reason: 'Title is in exempt_titles', detail: '' });
      skippedCounts.title++;
    } else if (titleRegex && titleRegex.test(a.title)) {
      skipped.push({ title: a.title, reason: 'Title matches exempt_title_regex', detail: cfg.exempt_title_regex });
      skippedCounts.regex++;
    } else pending.push(a);
  }
  if (cfg.max_pages > 0 && pending.length > cfg.max_pages) {
    skippedCounts.limit = pending.length - cfg.max_pages;
    pending = pending.slice(0, cfg.max_pages);
  }
  console.log(`${articles.length} articles; ${pending.length} to check (${skipped.length} exempt).`);

  // --- scan ---
  const pagesOut = [];
  const ruleRows = Object.fromEntries(RULE_IDS.map((id) => [id, []]));
  const ruleCounts = Object.fromEntries(RULE_IDS.map((id) => [id, { count: 0, pages: 0 }]));
  const flagged = new Map();
  const freq = new Map();
  const occ = new Map();
  const seen = new Set();
  let scanned = 0;
  let totalWords = 0;
  let totalFindings = 0;
  let started = 0;
  let stopped = false;

  const handlePage = (p, rev, content) => {
    if (seen.has(p.pageid)) return;
    seen.add(p.pageid);
    if (optedOut(content)) {
      skipped.push({ title: p.title, reason: 'Page opted out', detail: '{{nobots}}' });
      skippedCounts.nobots++;
      return;
    }
    const r = analyze(content, ctx);
    scanned++;
    totalWords += r.words;

    if (freqOn) {
      lowerTokens(r.text, (w, idx) => {
        const c = freq.get(w) || 0;
        freq.set(w, c + 1);
        if (c < 3) {
          const arr = occ.get(w) || [];
          const s = Math.max(0, idx - 50);
          const e = Math.min(content.length, idx + w.length + 50);
          arr.push({
            title: p.title,
            snippet: (s > 0 ? '…' : '') + highlight(content.slice(s, idx).replace(/\s+/g, ' '), w, content.slice(idx + w.length, e).replace(/\s+/g, ' ')) + (e < content.length ? '…' : ''),
          });
          occ.set(w, arr);
        }
      });
    }

    if (!r.findings.length) return;
    totalFindings += r.findings.length;
    for (const [id, n] of Object.entries(r.counts)) {
      ruleCounts[id].count += n;
      ruleCounts[id].pages++;
    }
    const stored = r.findings.slice(0, MAX_STORED_PER_PAGE);
    for (const f of stored) {
      ruleRows[f.rule].push({ title: p.title, finding: f });
      if (f.rule === 'known_misspelling' || f.rule === 'repeated_word') {
        const word = f.rule === 'repeated_word' ? f.found.trim().toLowerCase() : f.found.toLowerCase();
        const key = `${f.rule}:${word}`;
        const e = flagged.get(key) || { word, rule: f.rule, count: 0, titles: new Set(), suggestion: f.rule === 'known_misspelling' ? f.replacement.toLowerCase() : '' };
        e.count++;
        e.titles.add(p.title);
        flagged.set(key, e);
      }
    }
    pagesOut.push({ title: p.title, pageid: p.pageid, words: r.words, total: r.findings.length, counts: r.counts, findings: stored, timestamp: rev.timestamp });
  };

  await mapPool(chunk(pending, BATCH_SIZE), READ_CONCURRENCY, async (batch) => {
    if (stopped) return;
    if (++started % STOP_CHECK_EVERY === 0 && !(await stillEnabled())) {
      stopped = true;
      console.log('Stop requested via config (enabled = false); halting scan.');
      return;
    }
    let cont = null;
    do {
      const res = await api({
        action: 'query',
        prop: 'revisions',
        pageids: batch.map((p) => p.pageid).join('|'),
        rvprop: 'ids|timestamp|content',
        rvslots: 'main',
        ...(cont || {}),
      });
      for (const p of res.query?.pages || []) {
        const rev = p.revisions?.[0];
        const content = rev?.slots?.main?.content;
        if (content !== undefined) handlePage(p, rev, content);
      }
      cont = res.continue || null;
    } while (cont);
  });

  if (stopped) {
    console.log('Scan stopped early; not publishing partial reports.');
    return;
  }
  console.log(`Scanned ${scanned} pages, ${totalWords} words, ${totalFindings} findings.`);

  // --- rare-word suggestions ---
  let freqRows = [];
  if (freqOn) {
    freqRows = computeRareWords(freq, occ, ctx, cfg).slice(0, cfg.freq_max_rows);
    ruleRows.rare_word_suggestion = freqRows;
    ruleCounts.rare_word_suggestion = {
      count: freqRows.length,
      pages: new Set(freqRows.flatMap((r) => r.occurrences.map((o) => o.title))).size,
    };
  }

  // --- rule statuses ---
  const ruleStats = {};
  for (const rule of RULES) {
    const review = reviews.get(rule.id) || null;
    ruleStats[rule.id] = {
      ...ruleCounts[rule.id],
      review,
      status: ruleStatus(rule, cfg, review, effectiveMode),
    };
  }
  const approved = new Set(RULES.filter((r) => ['preview', 'auto'].includes(ruleStats[r.id].status.key)).map((r) => r.id));

  // --- planned fixes (preview/apply) ---
  const planned = [];
  const plannedSkipped = [];
  const now = Date.now();
  if (effectiveMode !== 'report' && approved.size) {
    for (const pg of pagesOut.slice().sort((a, b) => a.title.localeCompare(b.title))) {
      const fixes = pg.findings.filter((f) => approved.has(f.rule));
      const exactTotal = [...approved].reduce((s, id) => s + (pg.counts[id] || 0), 0);
      if (!exactTotal) continue;
      if (exactTotal > cfg.max_fixes_per_page) {
        plannedSkipped.push({ title: pg.title, reason: `Needs ${exactTotal} fixes (limit ${cfg.max_fixes_per_page}): a human should look at this page` });
        continue;
      }
      const ageH = (now - Date.parse(pg.timestamp)) / 3600000;
      if (cfg.min_page_age_hours > 0 && ageH < cfg.min_page_age_hours) {
        plannedSkipped.push({ title: pg.title, reason: `Edited ${ageH.toFixed(1)} hours ago (waiting for ${cfg.min_page_age_hours} hours of quiet)` });
        continue;
      }
      planned.push({ title: pg.title, pageid: pg.pageid, fixes });
    }
  }

  // --- apply ---
  const applied = [];
  let stoppedEarly = false;
  if (effectiveMode === 'apply' && approved.size && planned.length) {
    console.log(`Applying fixes to up to ${Math.min(planned.length, cfg.max_edits_per_run)} of ${planned.length} pages...`);
    let edits = 0;
    for (const item of planned) {
      if (edits >= cfg.max_edits_per_run) {
        plannedSkipped.push({ title: item.title, reason: 'Over the max_edits_per_run limit; it will be handled in a later run' });
        continue;
      }
      if (edits % EDIT_STOP_CHECK_EVERY === 0 && !(await stillEnabled())) {
        stoppedEarly = true;
        console.log('Stop requested via config (enabled = false); halting edits.');
        break;
      }
      const res = await api({ action: 'query', prop: 'revisions', pageids: String(item.pageid), rvprop: 'ids|timestamp|content', rvslots: 'main' });
      const rev = res.query?.pages?.[0]?.revisions?.[0];
      const content = rev?.slots?.main?.content;
      if (content === undefined) {
        plannedSkipped.push({ title: item.title, reason: 'Page could not be read (deleted or moved?)' });
        continue;
      }
      const ageH = (Date.now() - Date.parse(rev.timestamp)) / 3600000;
      if (cfg.min_page_age_hours > 0 && ageH < cfg.min_page_age_hours) {
        plannedSkipped.push({ title: item.title, reason: `Edited ${ageH.toFixed(1)} hours ago (waiting for ${cfg.min_page_age_hours} hours of quiet)` });
        continue;
      }
      if (optedOut(content)) {
        plannedSkipped.push({ title: item.title, reason: 'Page now opts out of bots' });
        continue;
      }
      const fresh = analyze(content, ctx).findings.filter((f) => approved.has(f.rule));
      if (!fresh.length) {
        plannedSkipped.push({ title: item.title, reason: 'Nothing left to fix (someone already fixed it)' });
        continue;
      }
      if (fresh.length > cfg.max_fixes_per_page) {
        plannedSkipped.push({ title: item.title, reason: `Now needs ${fresh.length} fixes (limit ${cfg.max_fixes_per_page})` });
        continue;
      }
      const { text, applied: done } = applyFindings(content, fresh);
      if (text === content || !done.length) {
        plannedSkipped.push({ title: item.title, reason: 'No fix could be verified against the live text' });
        continue;
      }
      const counts = {};
      for (const f of done) counts[f.rule] = (counts[f.rule] || 0) + 1;
      const rulesText = Object.entries(counts).map(([id, c]) => `${RULE_BY_ID.get(id).title} ×${c}`).join(', ');
      const summary = `Bot: Fixing ${done.length} typo${done.length === 1 ? '' : 's'} (${rulesText}). Approved rules; details: [[${base}]]`.slice(0, 480);

      if (edits > 0) await sleep(cfg.edit_interval_ms);
      try {
        const out = await api(
          { action: 'edit', pageid: String(item.pageid), baserevid: String(rev.revid), text, summary, bot: '1', minor: '1', nocreate: '1', token },
          true
        );
        edits++;
        applied.push({ title: item.title, oldRevid: rev.revid, newRevid: out.edit?.newrevid, fixes: done });
        console.log(`Edited "${item.title}" (${done.length} fixes).`);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'editconflict') {
          plannedSkipped.push({ title: item.title, reason: 'Edited by someone else mid-run' });
        } else {
          plannedSkipped.push({ title: item.title, reason: `Edit failed: ${err.message}` });
          console.error(`Failed "${item.title}": ${err.message}`);
        }
      }
    }
  }

  // --- assemble the run object ---
  const worstPages = pagesOut.slice().sort((a, b) => b.total - a.total || a.title.localeCompare(b.title));
  const topWords = [...flagged.values()]
    .map((e) => ({ word: e.word, count: e.count, pages: e.titles.size, ruleTitle: RULE_BY_ID.get(e.rule).title, suggestion: e.suggestion }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));
  const d = new Date();
  const run = {
    base,
    configPage: GRAMMAR_CONFIG_PAGE,
    startedAt,
    finishedAt: new Date(),
    mode: effectiveMode,
    dryRun: DRY_RUN,
    cfg,
    sources,
    approval: conf.approval,
    totals: { articles: articles.length, scanned, words: totalWords, findings: totalFindings, pagesWithFindings: pagesOut.length },
    skipped: skipped.sort((a, b) => a.title.localeCompare(b.title)),
    skippedCounts,
    ruleStats,
    ruleRows,
    worstPages,
    topWords,
    planned,
    plannedSkipped,
    applied,
    stoppedEarly,
    seed: d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(),
  };

  // --- publish ---
  console.log('Publishing reports...');
  for (const rule of RULES) {
    await publish(rulePageTitle(base, rule), buildRulePage(run, rule), `Bot: Updating Grammar report: ${rule.title}`, token);
  }
  await publish(`${base}/Worst pages`, buildWorstPages(run), 'Bot: Updating Grammar report: worst pages', token);
  await publish(`${base}/Skipped pages`, buildSkippedPages(run), 'Bot: Updating Grammar report: skipped pages', token);
  if (effectiveMode !== 'report') {
    await publish(`${base}/Planned fixes`, buildPlannedFixes(run), 'Bot: Updating Grammar report: planned fixes', token);
  }
  if (effectiveMode === 'apply') {
    const old = parseFixLogRows(await readPage(`${base}/Fix log`));
    const fresh = applied.map((a) => fixLogRow(a, run.finishedAt));
    const rows = [...fresh, ...old].slice(0, FIX_LOG_MAX_ROWS);
    await publish(`${base}/Fix log`, buildFixLog(run, rows), `Bot: Updating Grammar fix log (+${fresh.length})`, token);
  }
  await publish(base, buildHub(run), `Bot: Updating Grammar report overview (${totalFindings} findings, mode ${effectiveMode})`, token);

  console.log(`Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
