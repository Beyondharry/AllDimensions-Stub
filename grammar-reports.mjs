// grammar-reports.mjs — turns a finished Grammar-bot "run" object into wikitext pages.
// Pure functions only (no network), so they can be tested and previewed offline.

import { RULES, RULE_BY_ID } from './grammar-rules.mjs';

const GREEN = '#2e7d32';
const AMBER = '#b26a00';
const RED = '#b71c1c';
const BLUE = '#1565c0';
const GREY = '#616161';

// ---------------------------------------------------------------------------
// Settings documentation (used by the hub's "Settings in effect" table and the config page template)
// ---------------------------------------------------------------------------

export const SETTING_DOCS = {
  enabled: 'Master switch for the Grammar bot. false = nothing runs (reports are not updated, nothing is edited).',
  mode: 'report = only write the report pages. preview = also show exactly which edits WOULD be made. apply = really make the approved edits.',
  rules_enabled: "Which rules run. 'all' or a comma-separated list of rule IDs (see the rule pages).",
  autofix_rules: 'Rules an admin has approved for automatic fixing. Empty = nothing is ever edited. A rule also needs enough review evidence (see below).',
  autofix_min_reviewed: 'How many findings of a rule must have been spot-checked by a human before it may be automatic.',
  autofix_min_precision: 'Minimum percentage of those spot-checked findings that were correct (for example 98).',
  max_edits_per_run: 'Safety cap: the most pages the bot will edit in one run. 0 = no edits at all.',
  max_fixes_per_page: 'If a page needs more automatic fixes than this, the bot leaves it for a human (very messy pages are risky).',
  min_page_age_hours: 'The bot will not edit a page that someone changed within this many hours (avoids fighting an editor who is mid-way through a rewrite).',
  edit_interval_ms: 'Pause between edits in milliseconds (keeps the bot polite and rate-limit safe).',
  skip_quotes: 'true = text inside "quotation marks" is never changed or flagged (dialogue is often written in an unusual style).',
  exempt_categories: 'Pages in these categories are not checked at all.',
  exempt_titles: 'Page titles that are not checked (comma-separated).',
  exempt_title_regex: 'Optional regular expression; matching page titles are not checked. Empty = none.',
  max_pages: 'Only check this many pages (for testing). 0 = every page.',
  reports_base: 'Where the report pages are saved. Sub-pages are created below this title.',
  report_rows_per_rule: 'Most findings listed on each rule page (the counts are always complete).',
  report_max_per_page_per_rule: 'Most findings listed per article on each rule page, so one messy page cannot fill the list.',
  report_worst_pages: 'How many pages the "Worst pages" report lists.',
  report_sample_size: 'Size of the random spot-check sample on each rule page.',
  freq_rare_max: 'Rare-word rule: a word counts as rare if it appears at most this many times on the whole wiki.',
  freq_common_min: 'Rare-word rule: the similar word must appear at least this many times.',
  freq_ratio_min: 'Rare-word rule: the similar word must be at least this many times more frequent than the rare word.',
  freq_min_length: 'Rare-word rule: ignore words shorter than this.',
  freq_max_rows: 'Rare-word rule: most suggestions listed.',
};

// ---------------------------------------------------------------------------
// Tiny wikitext helpers
// ---------------------------------------------------------------------------

const nw = (s) => (String(s) === '' ? '' : `<nowiki>${String(s).replace(/<\/nowiki>/gi, '')}</nowiki>`);
const L = (t) => `[[:${t}]]`;
const edit = (t) => `[{{fullurl:${t}|action=edit}} edit]`;
const num = (n) => Number(n).toLocaleString('en-US');
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '–');
const fmt = (d) => d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const badge = (text, bg) =>
  `<span style="background:${bg}; color:#fff; padding:1px 7px; border-radius:3px; font-size:90%; white-space:nowrap;">${text}</span>`;
const box = (color, body) =>
  `<div style="border:1px solid #888; border-left:6px solid ${color}; padding:8px 14px; margin:10px 0; background:rgba(128,128,128,0.12);">\n${body}\n</div>`;

const CONF = {
  high: badge('High confidence', GREEN),
  medium: badge('Medium confidence', AMBER),
  low: badge('Low confidence', RED),
};

export const ruleEnabled = (id, cfg) => cfg.rules_enabled.includes('all') || cfg.rules_enabled.includes(id);

// Review evidence is recorded by admins on the config page: "rule_id@version = reviewed, incorrect"
export function ruleStatus(rule, cfg, review, mode) {
  if (!ruleEnabled(rule.id, cfg)) {
    return { key: 'off', label: 'Off', color: GREY, detail: 'Switched off with rules_enabled, so it is not running.' };
  }
  if (!cfg.autofix_rules.includes(rule.id)) {
    return { key: 'report', label: 'Report only', color: BLUE, detail: 'Findings are listed in the reports. Nothing is ever edited for this rule.' };
  }
  if (!rule.autofixable) {
    return { key: 'never', label: 'Never automatic', color: RED, detail: 'This rule can only make suggestions. It is not allowed to edit pages, even if listed in autofix_rules.' };
  }
  const need = cfg.autofix_min_reviewed;
  const minP = cfg.autofix_min_precision;
  if (!review || review.stale || review.reviewed < need) {
    const have = review && !review.stale ? review.reviewed : 0;
    const why = review?.stale ? ' (the recorded review was for an older version of this rule, so it does not count)' : '';
    return { key: 'blocked', label: 'Blocked – needs review', color: AMBER, detail: `Listed in autofix_rules, but only ${have} of the required ${need} findings have been spot-checked${why}.` };
  }
  const precision = (100 * (review.reviewed - review.incorrect)) / review.reviewed;
  if (precision < minP) {
    return { key: 'blocked', label: 'Blocked – too many mistakes', color: AMBER, detail: `Spot-checks found ${precision.toFixed(1)}% correct, but ${minP}% is required.` };
  }
  if (mode === 'apply') return { key: 'auto', label: 'Auto-fix ON', color: GREEN, detail: 'Approved and mode = apply: the bot edits pages for this rule.' };
  if (mode === 'preview') return { key: 'preview', label: 'Approved – preview only', color: GREEN, detail: 'Approved, but mode = preview: planned edits are shown on the Planned fixes page and nothing is edited.' };
  return { key: 'approved_wait', label: 'Approved – waiting for apply mode', color: GREEN, detail: 'Approved, but mode = report, so nothing is edited yet.' };
}

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededSample(arr, k, seed) {
  const rnd = mulberry32(seed);
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

export const highlight = (before, found, after) => `${nw(before)}'''${nw(found)}'''${nw(after)}`;

const asWritten = (c) =>
  `${nw(c.before)}'''${nw(c.found || ' ')}'''${nw(c.after)}`;
const wouldBecome = (c) =>
  `${nw(c.before)}${c.replacement ? `'''${nw(c.replacement)}'''` : "''(removed)''"}${nw(c.after)}`;

function subpage(run, name) {
  return `${run.base}/${name}`;
}
export const rulePageTitle = (base, rule) => `${base}/Rule - ${rule.title}`;

// ---------------------------------------------------------------------------
// HUB
// ---------------------------------------------------------------------------

export function buildHub(run) {
  const { cfg, sources } = run;
  const out = [];
  const modeLabel = { report: 'Report only', preview: 'Preview (planned edits shown, nothing edited)', apply: 'Apply (approved fixes are being made)' }[run.mode];
  const configLink = `[[${run.configPage}|Grammar configuration page]]`;

  out.push(
    `''Automatically generated by [[User:StubManager|StubManager]]. Last updated ${fmt(run.finishedAt)}. This page is overwritten on every run, so please do not edit it. Change settings on the ${configLink} instead.''`
  );

  out.push('', '== Start here ==');
  out.push(
    box(
      run.mode === 'apply' ? AMBER : GREEN,
      `'''Current mode: ${modeLabel}.'''\n\n` +
        (run.mode === 'report'
          ? 'The bot only <u>reports</u> possible spelling and grammar problems. It does not change any article.'
          : run.mode === 'preview'
          ? 'The bot reports problems and shows exactly which edits it <u>would</u> make for approved rules. It still does not change any article.'
          : `The bot reports problems and makes the fixes that an admin has approved. See [[${subpage(run, 'Fix log')}|the fix log]].`) +
        `\n\n* '''Pages checked:''' ${num(run.totals.scanned)} of ${num(run.totals.articles)} articles (${num(run.totals.words)} words)\n` +
        `* '''Possible problems found:''' ${num(run.totals.findings)} on ${num(run.totals.pagesWithFindings)} pages\n` +
        `* '''Where to begin:''' the [[${subpage(run, 'Worst pages')}|worst pages list]] shows the articles that need the most attention.`
    )
  );

  out.push('', '== What the Grammar bot is, and what it is not ==');
  out.push(
    "This bot reads every article and looks for ''mechanical'' writing slips: words from a list of known misspellings, a word typed twice, a missing or extra space around a comma or full stop, a sentence that starts with a small letter, and so on. " +
      "It uses simple, predictable rules instead of guessing, which is why it can be trusted on a wiki full of invented words.",
    '',
    "It is '''not''' an editor. It does not judge style, tone or story content, and it does not try to understand sentences. " +
      "Anything inside quotation marks, templates, tables, references, link addresses or HTML is skipped, and pages in the exempt categories are not checked at all."
  );

  out.push('', '== How to read these reports ==');
  out.push(
    "{| class=\"wikitable\"\n! Label !! What it means\n|-\n" +
      `| ${CONF.high} || Almost always a genuine mistake.\n|-\n` +
      `| ${CONF.medium} || Usually a mistake, but there are legitimate exceptions. Worth a quick look.\n|-\n` +
      `| ${CONF.low} || Often right, sometimes wrong. Treat as a hint, not a verdict.\n|-\n` +
      `| ${badge('Report only', BLUE)} || The bot lists the problem. A person fixes it (or ignores it).\n|-\n` +
      `| ${badge('Approved – preview only', GREEN)} || An admin approved the rule; the bot shows what it would change but changes nothing.\n|-\n` +
      `| ${badge('Auto-fix ON', GREEN)} || An admin approved the rule and the bot is fixing it by itself.\n|-\n` +
      `| ${badge('Blocked – needs review', AMBER)} || Someone asked for automatic fixing, but there is not enough proof that the rule is accurate yet.\n|-\n` +
      `| ${badge('Never automatic', RED)} || Suggestions only. This kind of finding is never fixed by the bot.\n` +
      '|}',
    '',
    "In every list, the problem is shown in '''bold''' inside the surrounding text, next to what the text would become after the fix."
  );

  out.push('', '== Rules at a glance ==');
  out.push('Click a rule name for its full page: explanation, examples, risks, a random spot-check sample and every finding.', '');
  out.push('{| class="wikitable sortable"', '! # !! Rule !! What it catches !! Example !! Confidence !! Findings !! Pages !! Status');
  RULES.forEach((rule, i) => {
    const st = run.ruleStats[rule.id];
    out.push('|-');
    out.push(
      `| ${i + 1} || [[${rulePageTitle(run.base, rule)}|${rule.title}]] || ${rule.summary} || ${nw(rule.examples[0][0])} → ${nw(rule.examples[0][1])} || ${CONF[rule.confidence]} || ${num(st.count)} || ${num(st.pages)} || ${badge(st.status.label, st.status.color)}`
    );
  });
  out.push('|}');

  out.push('', '== Pages that need the most attention ==');
  out.push(`The ten articles with the most findings (full list: [[${subpage(run, 'Worst pages')}|Worst pages]]).`, '');
  out.push('{| class="wikitable"', '! Page !! Findings !! Words !! Findings per 1,000 words !! Link');
  for (const p of run.worstPages.slice(0, 10)) {
    out.push('|-');
    out.push(`| ${L(p.title)} || ${num(p.total)} || ${num(p.words)} || ${((p.total * 1000) / Math.max(1, p.words)).toFixed(1)} || ${edit(p.title)}`);
  }
  if (!run.worstPages.length) out.push('|-', '| colspan="5" | No problems found. ');
  out.push('|}');

  out.push('', '== Words flagged most often ==');
  out.push(
    "If a word is flagged on many pages it is either a genuinely common typo (fix them all!) or an invented word that the bot should leave alone. " +
      "In the second case an admin can add it to the ''ignore list'' on the " +
      configLink +
      ', and it will never be flagged again.',
    ''
  );
  out.push('{| class="wikitable sortable"', '! Word !! Rule !! Times flagged !! On pages !! Suggested fix');
  for (const w of run.topWords.slice(0, 25)) {
    out.push('|-');
    out.push(`| ${nw(w.word)} || ${w.ruleTitle} || ${num(w.count)} || ${num(w.pages)} || ${w.suggestion ? nw(w.suggestion) : '–'}`);
  }
  if (!run.topWords.length) out.push('|-', '| colspan="5" | Nothing to show yet.');
  out.push('|}');

  out.push('', '== Coverage: what was and was not checked ==');
  out.push('{| class="wikitable"', '! Item !! Count', '|-', `| Articles on the wiki (redirects excluded) || ${num(run.totals.articles)}`, '|-', `| Articles checked || ${num(run.totals.scanned)}`);
  const sc = run.skippedCounts;
  out.push('|-', `| Skipped: in an exempt category (${cfg.exempt_categories.map(nw).join(', ') || 'none'}) || ${num(sc.category)}`);
  out.push('|-', `| Skipped: title is in exempt_titles || ${num(sc.title)}`, '|-', `| Skipped: title matches exempt_title_regex || ${num(sc.regex)}`);
  out.push('|-', `| Skipped: the page asks bots to stay away (<code>${nw('{{nobots}}')}</code>) || ${num(sc.nobots)}`);
  out.push('|-', `| Skipped: over the max_pages testing limit || ${num(sc.limit)}`, '|}', '');
  out.push(`The pages that were skipped, with the reason, are listed on [[${subpage(run, 'Skipped pages')}|Skipped pages]].`, '');
  out.push(
    "'''The bot never reads or changes:''' templates (including infoboxes and navboxes), tables' formatting, link addresses, file and category links, references, comments, HTML tags, web addresses, headings' markup, " +
      (cfg.skip_quotes ? 'text inside quotation marks, ' : '') +
      'poems, block quotes, code, maths, and anything on the ignore list.'
  );

  out.push('', '== Approval and automatic fixing ==');
  out.push(
    "Nothing is fixed automatically until an admin says so, rule by rule. Even then, a rule must prove itself first: " +
      `at least '''${cfg.autofix_min_reviewed}''' findings must have been checked by a person, and at least '''${cfg.autofix_min_precision}%''' of them must have been correct.`,
    ''
  );
  if (run.approval) {
    out.push(`The configuration in use was last saved by ${badge('trusted', GREEN)} user [[User:${run.approval.user}|${run.approval.user}]] ([[Special:PermanentLink/${run.approval.revid}|revision ${run.approval.revid}]]). Edits to the configuration page by anyone who is not a sysop, bureaucrat or the wiki owner are ignored and reverted.`, '');
  }
  out.push('{| class="wikitable"', '! Rule !! Can it ever be automatic? !! Approved? !! Checked by a person !! Wrong !! Accuracy !! Status');
  for (const rule of RULES) {
    const st = run.ruleStats[rule.id];
    const rv = st.review;
    const acc = rv && !rv.stale && rv.reviewed ? `${(100 * (rv.reviewed - rv.incorrect) / rv.reviewed).toFixed(1)}%` : '–';
    out.push('|-');
    out.push(
      `| ${rule.title} || ${rule.autofixable ? 'Yes' : 'No – suggestions only'} || ${cfg.autofix_rules.includes(rule.id) ? 'Yes' : 'No'} || ${rv ? `${rv.reviewed}${rv.stale ? ' (outdated)' : ''}` : 0} || ${rv && !rv.stale ? rv.incorrect : '–'} || ${acc} || ${badge(st.status.label, st.status.color)} ${st.status.detail}`
    );
  }
  out.push('|}', '');
  out.push(
    "'''How an admin approves a rule''' (the same steps, in order):",
    '# Read the rule page and look at the findings. Add anything that is wrong because it is lore, a name or a deliberate style to the ignore list.',
    "# Open the rule page's ''spot-check sample'' and check each example. Count how many were checked and how many were wrong.",
    `# Record the result on the ${configLink} in the reviews box, for example <code>known_misspelling@1 = 50, 1</code> (50 checked, 1 wrong).`,
    '# Add the rule ID to <code>autofix_rules</code>.',
    `# Set <code>mode = preview</code> and look at [[${subpage(run, 'Planned fixes')}|Planned fixes]]. Nothing is edited yet.`,
    '# Set <code>mode = apply</code> with a small <code>max_edits_per_run</code> (for example 20). Watch the fix log and Recent changes, then raise the limit gradually.',
    "# '''To stop or undo:''' remove the rule from <code>autofix_rules</code>, set <code>mode = report</code>, or set <code>enabled = false</code>. Every edit names the rule in its summary and is listed in the fix log, so any rule's edits can be reviewed or undone."
  );

  out.push('', '== Safeguards when the bot does edit ==');
  out.push(
    `* Only rules approved by an admin <u>and</u> backed by review evidence can edit.`,
    `* At most '''${cfg.max_edits_per_run}''' pages per run.`,
    `* A page needing more than '''${cfg.max_fixes_per_page}''' fixes is left for a human.`,
    `* A page edited within the last '''${cfg.min_page_age_hours} hours''' is left alone.`,
    '* The page is read again immediately before editing, every fix is verified against the live text, and the edit is refused if anyone changed the page in the meantime.',
    '* Pages with <code>{{nobots}}</code> or <code>{{bots|deny=all}}</code> are never touched.',
    '* Every edit is marked as a minor bot edit with a summary naming the rules used, and is recorded in the fix log.',
    '* An administrator can stop everything instantly with <code>enabled = false</code> on the configuration page. The bot re-checks it while it works.'
  );

  out.push('', '== Settings in effect ==');
  out.push(
    "Each value comes from one of three places, in this order of priority: '''Wiki''' (the configuration page) → '''Secret''' (a GitHub secret) → '''Default''' (built into the code).",
    ''
  );
  out.push('{| class="wikitable"', '! Setting !! Value !! Comes from !! What it does');
  const sourceBadge = { wiki: badge('Wiki', GREEN), secret: badge('Secret', AMBER), default: badge('Default', GREY) };
  for (const key of Object.keys(SETTING_DOCS)) {
    const v = cfg[key];
    const shown = Array.isArray(v) ? (v.length ? v.join(', ') : '(none)') : String(v === '' ? '(empty)' : v);
    out.push('|-');
    out.push(`| <code>${key}</code> || ${nw(shown)} || ${sourceBadge[sources[key]] || ''} || ${SETTING_DOCS[key]}`);
  }
  out.push('|}');

  out.push('', '== How you can help the bot get better ==');
  out.push(
    `* '''A flagged word is not actually wrong?''' Add it to the ignore list on the ${configLink}.`,
    `* '''A whole page should never be checked?''' Put it in the category ${cfg.exempt_categories.length ? `<code>${cfg.exempt_categories[0]}</code>` : 'of your choice'}, or add <code>{{nobots}}</code> to the page.`,
    '* \'\'\'A typo the bot missed that is common?\'\'\' Add it to the misspellings box on the configuration page as <code>wrong -> right</code>.',
    '* \'\'\'An abbreviation is being treated as the end of a sentence?\'\'\' Add it to the abbreviations box.',
    '* \'\'\'Found a bug?\'\'\' Leave a message on [[User talk:StubManager]] with the page name and the rule.'
  );

  out.push('', '== Glossary ==');
  out.push(
    '; Finding',
    ': One possible problem the bot spotted, with the exact place and a suggested fix.',
    '; Rule',
    ': One kind of check, for example "Repeated words".',
    '; Report only',
    ': The bot lists problems for people to fix and never edits.',
    '; Preview',
    ': The bot also shows the edits it would make, without making them.',
    '; Apply',
    ': The bot makes the edits for rules that an admin has approved.',
    '; Spot-check',
    ': A person looks at a random sample of findings and records how many were right or wrong.',
    '; Ignore list',
    ': Words and phrases the bot must never flag, kept on the configuration page.',
    '; Exempt category',
    ': A category whose pages are never checked.'
  );

  out.push('', '== Run details ==');
  out.push(
    '{| class="wikitable"',
    `|-\n| Started || ${fmt(run.startedAt)}`,
    `|-\n| Finished || ${fmt(run.finishedAt)}`,
    `|-\n| Duration || ${Math.round((run.finishedAt - run.startedAt) / 1000)} seconds`,
    `|-\n| Mode || ${run.mode}${run.dryRun ? ' (dry run: no pages were saved)' : ''}`,
    `|-\n| Pages checked || ${num(run.totals.scanned)}`,
    `|-\n| Words analysed || ${num(run.totals.words)}`,
    `|-\n| Total findings || ${num(run.totals.findings)}`,
    ...(run.mode === 'apply' ? [`|-\n| Pages edited this run || ${num(run.applied.length)}`, `|-\n| Pages left for a human || ${num(run.plannedSkipped.length)}`] : []),
    ...(run.stoppedEarly ? ['|-\n| Note || The run was stopped early because <code>enabled</code> was set to false.'] : []),
    '|}',
    '',
    '[[Category:Bot reports]]'
  );
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// RULE PAGE
// ---------------------------------------------------------------------------

export function buildRulePage(run, rule) {
  const st = run.ruleStats[rule.id];
  const { cfg } = run;
  const out = [];
  out.push(`''Automatically generated by [[User:StubManager|StubManager]] on ${fmt(run.finishedAt)}. This page is overwritten on every run. Back to the [[${run.base}|Grammar report overview]].''`);

  out.push('', '== Summary ==');
  out.push(
    box(
      st.status.color,
      `'''${rule.title}''' (rule ID <code>${rule.id}</code>, version ${rule.version})\n\n` +
        `* '''What it catches:''' ${rule.summary}\n` +
        `* '''Confidence:''' ${CONF[rule.confidence]}\n` +
        `* '''Findings:''' ${num(st.count)} on ${num(st.pages)} pages\n` +
        `* '''Status:''' ${badge(st.status.label, st.status.color)} ${st.status.detail}\n` +
        `* '''Can it ever fix pages by itself?''' ${rule.autofixable ? 'Yes, once an admin approves it and it passes review.' : "No. It only makes suggestions."}`
    )
  );

  out.push('', '== What this rule looks for ==', rule.explain);

  out.push('', '== Examples ==');
  out.push('{| class="wikitable"', '! Written !! Becomes');
  for (const [bad, good] of rule.examples) out.push('|-', `| ${nw(bad)} || ${nw(good)}`);
  out.push('|}');
  out.push('', "'''Deliberately not flagged:'''");
  for (const n of rule.notFlagged) out.push(`* ${n}`);

  out.push('', '== What could go wrong ==');
  for (const r of rule.risks) out.push(`* ${r}`);
  out.push(`* Anything wrong can be silenced by adding the word to the ignore list on the [[${run.configPage}|configuration page]], or by exempting the page.`);

  out.push('', '== How the bot decides (technical detail) ==', rule.logic);
  if (rule.id === 'rare_word_suggestion') {
    out.push(
      '',
      `Current limits: a word is ''rare'' if it appears at most <code>${cfg.freq_rare_max}</code> time(s); the similar word must appear at least <code>${cfg.freq_common_min}</code> times and at least <code>${cfg.freq_ratio_min}</code> times more often; words shorter than <code>${cfg.freq_min_length}</code> letters are ignored.`
    );
  }

  out.push('', '== Status and approval ==');
  const rv = st.review;
  out.push(
    `* '''Status:''' ${badge(st.status.label, st.status.color)} ${st.status.detail}`,
    `* '''Spot-checks recorded:''' ${rv ? `${rv.reviewed} checked, ${rv.incorrect} wrong${rv.stale ? ' (for an older version of the rule: does not count)' : ''}` : 'none yet'}`,
    `* '''Required before automatic fixing:''' ${cfg.autofix_min_reviewed} checked, at least ${cfg.autofix_min_precision}% correct`
  );
  if (rule.autofixable) {
    out.push(
      '',
      `To approve this rule: spot-check the sample below, record the result in the reviews box on the [[${run.configPage}|configuration page]] as <code>${rule.id}@${rule.version} = checked, wrong</code>, then add <code>${rule.id}</code> to <code>autofix_rules</code>. The full procedure is on the [[${run.base}#Approval and automatic fixing|overview page]].`
    );
  } else {
    out.push('', "This rule is permanently limited to suggestions; there is no approval step.");
  }

  const rows = run.ruleRows[rule.id] || [];
  const isFreq = rule.id === 'rare_word_suggestion';

  out.push('', '== Spot-check sample ==');
  out.push(
    `${num(Math.min(rows.length, cfg.report_sample_size))} findings chosen at random (the sample changes only once a day). Open each page, decide whether the suggestion is right, and note how many were wrong.`,
    ''
  );
  const sample = seededSample(rows, cfg.report_sample_size, run.seed + rule.version * 7919 + RULES.indexOf(rule));
  out.push(...table(run, rule, sample, isFreq, false));

  out.push('', '== All findings ==');
  const perPage = new Map();
  const shown = [];
  let hidden = 0;
  for (const r of rows) {
    const c = perPage.get(r.title) || 0;
    if (c >= cfg.report_max_per_page_per_rule || shown.length >= cfg.report_rows_per_rule) {
      hidden++;
      continue;
    }
    perPage.set(r.title, c + 1);
    shown.push(r);
  }
  out.push(
    `Showing ${num(shown.length)} of ${num(rows.length)} findings` +
      (hidden ? ` (${num(hidden)} not shown: at most ${cfg.report_max_per_page_per_rule} per page and ${cfg.report_rows_per_rule} in total are listed; fix some and the rest appear on the next run)` : '') +
      '. Click a column heading to sort.',
    ''
  );
  out.push(...table(run, rule, shown, isFreq, true));
  out.push('', '[[Category:Bot reports]]');
  return out.join('\n');
}

function table(run, rule, rows, isFreq, numbered) {
  const out = [];
  if (!rows.length) return ['No findings for this rule.'];
  if (isFreq) {
    out.push('{| class="wikitable sortable"', '! # !! Rare word !! Times on the wiki !! Looks like !! That word appears !! Where it appears');
    rows.forEach((r, i) => {
      out.push('|-');
      const where = r.occurrences
        .map((o) => `${L(o.title)} (${edit(o.title)}): ${o.snippet}`)
        .join('<br />');
      out.push(`| ${i + 1} || ${nw(r.word)} || ${r.count} || ${nw(r.suggestion)} || ${num(r.suggestionCount)} times || ${where}`);
    });
    out.push('|}');
    return out;
  }
  const fixNow = run.ruleStats[rule.id].status.key === 'auto';
  out.push('{| class="wikitable sortable"', `! # !! Page !! Link !! As written (problem in bold) !! Would become !! Fixed by the bot?`);
  rows.forEach((r, i) => {
    out.push('|-');
    out.push(
      `| ${i + 1} || ${L(r.title)} || ${edit(r.title)} || ${asWritten(r.finding.ctx)} || ${wouldBecome(r.finding.ctx)} || ${fixNow ? 'Yes, on the next edit of this page' : 'No'}`
    );
  });
  out.push('|}');
  return out;
}

// ---------------------------------------------------------------------------
// WORST PAGES
// ---------------------------------------------------------------------------

export function buildWorstPages(run) {
  const out = [];
  out.push(`''Automatically generated by [[User:StubManager|StubManager]] on ${fmt(run.finishedAt)}. Back to the [[${run.base}|overview]].''`, '');
  out.push('== How to use this list ==');
  out.push(
    "These are the articles with the most possible problems, so a few minutes of cleaning here removes the most findings. " +
      "''Findings per 1,000 words'' is fairer for long pages; click any column heading to sort. The columns on the right show how many findings each rule produced. " +
      "(The rare-word suggestions are not included, because they are about the whole wiki rather than one page.)",
    ''
  );
  out.push('== Worst pages ==');
  const rules = RULES.filter((r) => r.id !== 'rare_word_suggestion');
  out.push('{| class="wikitable sortable"', `! # !! Page !! Link !! Words !! Findings !! Per 1,000 words ${rules.map((r) => `!! ${r.title}`).join(' ')}`);
  run.worstPages.slice(0, run.cfg.report_worst_pages).forEach((p, i) => {
    out.push('|-');
    out.push(
      `| ${i + 1} || ${L(p.title)} || ${edit(p.title)} || ${num(p.words)} || ${num(p.total)} || ${((p.total * 1000) / Math.max(1, p.words)).toFixed(1)} ${rules.map((r) => `|| ${p.counts[r.id] || 0}`).join(' ')}`
    );
  });
  if (!run.worstPages.length) out.push('|-', `| colspan="${6 + rules.length}" | No problems found.`);
  out.push('|}', '', '[[Category:Bot reports]]');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// SKIPPED PAGES
// ---------------------------------------------------------------------------

export function buildSkippedPages(run) {
  const out = [];
  out.push(`''Automatically generated by [[User:StubManager|StubManager]] on ${fmt(run.finishedAt)}. Back to the [[${run.base}|overview]].''`, '');
  out.push('== Why pages are skipped ==');
  out.push(
    '* ' + "'''In an exempt category:''' for example pages about invented number systems, where unusual spelling is normal.",
    '* ' + "'''Exempt title or title pattern:''' set on the configuration page.",
    '* ' + "'''Opted out:''' the page contains <code>{{nobots}}</code> or <code>{{bots|deny=all}}</code>.",
    '* ' + "'''Testing limit:''' <code>max_pages</code> was set, so only part of the wiki was checked.",
    ''
  );
  out.push(`== Skipped pages (${num(run.skipped.length)}) ==`);
  const cap = 1500;
  out.push('{| class="wikitable sortable"', '! Page !! Reason !! Detail');
  for (const s of run.skipped.slice(0, cap)) out.push('|-', `| ${L(s.title)} || ${s.reason} || ${s.detail ? nw(s.detail) : ''}`);
  if (run.skipped.length > cap) out.push('|-', `| colspan="3" | … and ${num(run.skipped.length - cap)} more.`);
  if (!run.skipped.length) out.push('|-', '| colspan="3" | No pages were skipped.');
  out.push('|}', '', '[[Category:Bot reports]]');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// PLANNED FIXES (preview / apply)
// ---------------------------------------------------------------------------

export function buildPlannedFixes(run) {
  const out = [];
  out.push(`''Automatically generated by [[User:StubManager|StubManager]] on ${fmt(run.finishedAt)}. Back to the [[${run.base}|overview]].''`, '');
  out.push('== What this page shows ==');
  out.push(
    run.mode === 'apply'
      ? 'The fixes the bot planned from approved rules, and what actually happened to each page in this run.'
      : "The fixes the bot '''would''' make if mode were set to apply. Nothing on the wiki has been changed.",
    ''
  );
  const active = RULES.filter((r) => run.ruleStats[r.id].status.key === 'preview' || run.ruleStats[r.id].status.key === 'auto');
  out.push(`'''Rules included:''' ${active.length ? active.map((r) => r.title).join(', ') : "none (no rule is approved yet, so there is nothing to preview)"}`, '');

  out.push('== Summary ==');
  const totalFixes = run.planned.reduce((s, p) => s + p.fixes.length, 0);
  out.push(
    `* '''Pages with planned fixes:''' ${num(run.planned.length)}`,
    `* '''Total planned fixes:''' ${num(totalFixes)}`,
    `* '''Pages left for a human:''' ${num(run.plannedSkipped.length)}`,
    ...(run.mode === 'apply' ? [`* '''Pages edited in this run:''' ${num(run.applied.length)} (limit ${run.cfg.max_edits_per_run})`] : []),
    ''
  );

  if (run.mode === 'apply' && run.applied.length) {
    out.push('== Edits made in this run ==');
    out.push('{| class="wikitable sortable"', '! Page !! Diff !! Fixes made');
    for (const a of run.applied) {
      out.push('|-', `| ${L(a.title)} || ${a.newRevid ? `[[Special:Diff/${a.newRevid}|diff]]` : '–'} || ${a.fixes.length}`);
    }
    out.push('|}', '');
  }

  out.push('== Planned fixes by page ==');
  const cap = 300;
  for (const p of run.planned.slice(0, cap)) {
    out.push(`=== ${L(p.title)} (${p.fixes.length}) ===`, `${edit(p.title)}`, '');
    out.push('{| class="wikitable"', '! Rule !! As written !! Would become');
    for (const f of p.fixes.slice(0, 20)) {
      out.push('|-', `| ${RULE_BY_ID.get(f.rule).title} || ${asWritten(f.ctx)} || ${wouldBecome(f.ctx)}`);
    }
    if (p.fixes.length > 20) out.push('|-', `| colspan="3" | … and ${p.fixes.length - 20} more on this page.`);
    out.push('|}', '');
  }
  if (run.planned.length > cap) out.push(`… and ${num(run.planned.length - cap)} more pages.`, '');
  if (!run.planned.length) out.push('No planned fixes.', '');

  out.push('== Pages the bot will leave for a human ==');
  out.push('{| class="wikitable sortable"', '! Page !! Reason');
  for (const s of run.plannedSkipped.slice(0, 500)) out.push('|-', `| ${L(s.title)} || ${s.reason}`);
  if (!run.plannedSkipped.length) out.push('|-', '| colspan="2" | None.');
  out.push('|}', '', '[[Category:Bot reports]]');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// FIX LOG (append-only across runs)
// ---------------------------------------------------------------------------

const LOG_START = '<!-- LOG-START -->';
const LOG_END = '<!-- LOG-END -->';
export const FIX_LOG_MAX_ROWS = 1000;

export function parseFixLogRows(text) {
  if (!text) return [];
  const a = text.indexOf(LOG_START);
  const b = text.indexOf(LOG_END);
  if (a < 0 || b < 0 || b < a) return [];
  return text
    .slice(a + LOG_START.length, b)
    .split(/^\|-\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function fixLogRow(applied, when) {
  const counts = {};
  for (const f of applied.fixes) counts[f.rule] = (counts[f.rule] || 0) + 1;
  const rules = Object.entries(counts)
    .map(([id, c]) => `${RULE_BY_ID.get(id).title} ×${c}`)
    .join(', ');
  const examples = applied.fixes
    .slice(0, 3)
    .map((f) => `${nw(f.found.trim() || f.found)} → ${nw(f.replacement.trim() || '(removed)')}`)
    .join('; ');
  return `| ${fmt(when)} || ${L(applied.title)} || ${applied.newRevid ? `[[Special:Diff/${applied.newRevid}|diff]]` : '–'} || ${rules} || ${examples}`;
}

export function buildFixLog(run, rows) {
  const out = [];
  out.push(`''Automatically generated by [[User:StubManager|StubManager]]. Back to the [[${run.base}|overview]].''`, '');
  out.push('== About this log ==');
  out.push(
    'Every page the bot has edited automatically is listed here, newest first, with a link to the exact change. ' +
      `Only the most recent ${FIX_LOG_MAX_ROWS} edits are kept. If a rule is making mistakes, remove it from <code>autofix_rules</code> on the [[${run.configPage}|configuration page]] and undo its edits using the links below.`,
    ''
  );
  out.push('== Edits ==');
  out.push('{| class="wikitable sortable"', '! Time !! Page !! Change !! Rules used !! Examples', LOG_START);
  for (const r of rows) out.push('|-', r);
  out.push(LOG_END, '|}', '', '[[Category:Bot reports]]');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// CONFIG PAGE TEMPLATE (seeded automatically if the page does not exist)
// ---------------------------------------------------------------------------

export function buildConfigTemplate(defaults, base) {
  const list = (v) => (Array.isArray(v) ? v.join(',') : String(v));
  const settings = Object.keys(SETTING_DOCS)
    .map((k) => `# ${SETTING_DOCS[k]}\n${k} = ${list(defaults[k])}`)
    .join('\n\n');
  return `<div style="border:1px solid #303030; border-radius:4px; padding:16px 20px;">

== Grammar bot configuration ==

These settings control the '''Grammar bot''' run by [[User:StubManager|StubManager]]. Only edits by sysops, bureaucrats and the wiki owner are used; any other edit is ignored and reverted automatically. Results are published at [[${base}]].

'''Priority of settings:''' Wiki (this page) > Secrets (GitHub) > Defaults (in the code). A value that is left empty is treated as "not set".

=== Settings ===
Change the value after the <code>=</code> and save. Lines starting with <code>#</code> are comments.

<pre class="grammar-settings">
${settings}
</pre>

=== Ignore list ===
Words or phrases the bot must never flag (invented names, deliberate spellings). One per line or comma-separated. A phrase containing spaces ignores any finding whose surroundings contain it.

<pre class="grammar-ignore">
# example: Voidance, Omniverse
</pre>

=== Extra misspellings ===
One per line as <code>wrong -> right</code>. These are added to the built-in list.

<pre class="grammar-misspellings">
# example: omniverce -> omniverse
</pre>

=== Reviews (evidence for automatic fixing) ===
After spot-checking a rule's sample, record <code>rule_id@version = checked, wrong</code>. The version must match the rule's current version or the review is treated as outdated.

<pre class="grammar-reviews">
# example: known_misspelling@1 = 50, 1
</pre>

=== Word lists ===
These lists '''extend''' the built-in lists. Start a line with <code>-</code> to remove a built-in entry (for example <code>-this</code>).

'''Connecting words''' (wrongly capitalised after a comma):
<pre class="grammar-glue">
# example: whereupon
</pre>

'''Abbreviations''' (a full stop after these does not end a sentence; no dot at the end):
<pre class="grammar-abbreviations">
# example: gov
</pre>

'''Words that may be repeated''' (for example "had had"):
<pre class="grammar-repeat-ok">
# example: bis
</pre>

'''Names that start with a lowercase letter on purpose''':
<pre class="grammar-lowercase-names">
# example: iphone
</pre>

=== Rollout guide ===
# '''Report phase:''' leave <code>mode = report</code> and <code>autofix_rules</code> empty. Read the reports, fix false positives with the lists above.
# '''Review phase:''' spot-check each rule's sample and record the result in the reviews box.
# '''Preview phase:''' add trusted rules to <code>autofix_rules</code>, set <code>mode = preview</code> and read the Planned fixes page.
# '''Apply phase:''' set <code>mode = apply</code>. Keep <code>max_edits_per_run</code> small at first.
# '''Emergency stop:''' <code>enabled = false</code>.

</div>
[[Category:Bot configurations]]`;
}
