// redirect-selflink-module.mjs — Double Redirect & Self-Link Fixer
//
// Wiki config (User:StubManager/Configurations):
//   ONLY reads `enabled_dr_module` (true/false). All other settings come from GitHub env/secrets.

import {
  DRY_RUN,
  READ_CONCURRENCY,
  BATCH_SIZE,
  intEnv,
  sleep,
  chunk,
  mapPool,
  normalizeTitle,
  isRateLimitError,
  api,
  login,
  getCsrfToken,
  loadTrustedConfig,
  revertConfigPage,
  P,
  resolveLayers,
} from './core.mjs';

// ---------- config ----------

const CONFIG_PAGE = 'User:StubManager/Configurations';
const OWNER = 'PureNocturne';
const CONFIG_OPTS = { page: CONFIG_PAGE, owner: OWNER, keys: ['enabled_dr_module'] };

const boolEnv = (name, def) => {
  const parsed = P.bool((process.env[name] ?? '').trim());
  return parsed !== undefined ? parsed : def;
};

// GitHub env/secret settings
const MAX_EDITS = intEnv('MAX_EDITS', 0);
const EDIT_INTERVAL_MS = Math.max(250, intEnv('EDIT_INTERVAL_MS', 1100));
const MAX_EDIT_INTERVAL_MS = 15000;
const EDIT_CONCURRENCY = Math.max(1, intEnv('EDIT_CONCURRENCY', 1));
const STOP_CHECK_EVERY = 10;

const FIX_DOUBLE_REDIRECTS = boolEnv('FIX_DOUBLE_REDIRECTS', true);
const FIX_SELF_LINKS = boolEnv('FIX_SELF_LINKS', true);
const SELF_LINK_SCAN_ALL = boolEnv('SELF_LINK_SCAN_ALL', true);
const RC_HOURS = Math.max(1, intEnv('RC_HOURS', 4));

const EXEMPT_TITLE_SET = new Set(P.titles(process.env.EXEMPT_TITLES ?? ''));
const EXEMPT_TITLE_REGEX = (() => {
  const raw = (process.env.EXEMPT_TITLE_REGEX ?? '').trim();
  const valid = raw ? P.regex(raw) : undefined;
  if (raw && !valid) console.warn(`Ignoring invalid EXEMPT_TITLE_REGEX: "${raw}"`);
  return valid ? new RegExp(valid, 'i') : null;
})();

const isExemptTitle = (title) =>
  EXEMPT_TITLE_SET.has(normalizeTitle(title)) ||
  Boolean(EXEMPT_TITLE_REGEX && EXEMPT_TITLE_REGEX.test(title));

function resolveEnabled(wikiValues, quiet = false) {
  return resolveLayers({
    defaults: { enabled_dr_module: true },
    secrets: { enabled_dr_module: process.env.ENABLED_DR_MODULE },
    parsers: { enabled_dr_module: P.bool },
    wiki: wikiValues,
    quiet,
  }).enabled_dr_module;
}

// ---------- edit pacing ----------

let editInterval = EDIT_INTERVAL_MS;
let rateLimitHits = 0;
let nextEditSlot = 0;

function penalizeEdits() {
  rateLimitHits++;
  const old = editInterval;
  editInterval = Math.min(MAX_EDIT_INTERVAL_MS, editInterval * 1.5);
  if (editInterval !== old) console.log(`Rate limited: edit gap raised to ${editInterval} ms.`);
}

function rewardEdits() {
  editInterval = Math.max(EDIT_INTERVAL_MS, Math.floor(editInterval * 0.9));
}

async function throttleEdit() {
  const now = Date.now();
  const start = Math.max(now, nextEditSlot);
  nextEditSlot = start + editInterval;
  if (start > now) await sleep(start - now);
}

// ---------- reading ----------

async function getContents(pageids) {
  const result = new Map();
  await mapPool(chunk(pageids, BATCH_SIZE), READ_CONCURRENCY, async (batch) => {
    let cont = null;
    do {
      const res = await api({
        action: 'query',
        prop: 'revisions',
        pageids: batch.join('|'),
        rvprop: 'ids|content',
        rvslots: 'main',
        ...(cont || {}),
      });
      for (const p of res.query?.pages || []) {
        const rev = p.revisions?.[0];
        const content = rev?.slots?.main?.content;
        if (content !== undefined) {
          result.set(p.pageid, { pageid: p.pageid, title: p.title, revid: rev.revid, content });
        }
      }
      cont = res.continue || null;
    } while (cont);
  });
  return result;
}

// ---------- 1. Double Redirects ----------

async function getDoubleRedirectTitles() {
  const titles = [];
  let cont = null;
  do {
    const res = await api({
      action: 'query',
      list: 'querypage',
      qppage: 'DoubleRedirects',
      qplimit: 'max',
      ...(cont || {}),
    });
    for (const row of res.query?.querypage?.results || []) {
      if (row.ns === 0 && row.title && !isExemptTitle(row.title)) {
        titles.push(row.title);
      }
    }
    cont = res.continue || null;
  } while (cont);
  return [...new Set(titles)];
}

async function resolveFinalTargets(sourceTitles) {
  const resolved = new Map();
  for (const batch of chunk(sourceTitles, BATCH_SIZE)) {
    const res = await api({
      action: 'query',
      titles: batch.join('|'),
      redirects: '1',
    });

    const pagesByTitle = new Map((res.query?.pages || []).map((p) => [p.title, p]));
    const normMap = new Map((res.query?.normalized || []).map((n) => [n.from, n.to]));
    const hopMap = new Map(
      (res.query?.redirects || []).map((r) => [r.from, { to: r.to, tofragment: r.tofragment || '' }])
    );

    for (const orig of batch) {
      let cur = normMap.get(orig) || orig;
      let fragment = '';
      const seen = new Set([cur]);
      let loop = false;

      while (hopMap.has(cur)) {
        const next = hopMap.get(cur);
        cur = next.to;
        if (next.tofragment) fragment = next.tofragment;
        if (seen.has(cur)) {
          loop = true;
          break;
        }
        seen.add(cur);
      }

      const finalPage = pagesByTitle.get(cur);
      if (loop || !finalPage || finalPage.missing || finalPage.invalid) {
        resolved.set(orig, { loop: true });
      } else {
        resolved.set(orig, { loop: false, targetTitle: finalPage.title, targetFragment: fragment });
      }
    }
  }
  return resolved;
}

function planDoubleRedirectEdit(entry, resolution) {
  if (!resolution || resolution.loop) return null;
  if (normalizeTitle(entry.title) === normalizeTitle(resolution.targetTitle)) return null;

  const m = entry.content.match(/^\s*#REDIRECT\s*\[\[([^\]]+)\]\]/i);
  if (!m) return null;

  const origRaw = m[1].split('|')[0].trim();
  const origFragIdx = origRaw.indexOf('#');
  const origFrag = origFragIdx >= 0 ? origRaw.slice(origFragIdx + 1).trim() : '';
  const fragment = resolution.targetFragment || origFrag;

  const dest = fragment ? `${resolution.targetTitle}#${fragment}` : resolution.targetTitle;
  const newText = entry.content.replace(/^\s*#REDIRECT\s*\[\[[^\]]+\]\]/i, `#REDIRECT [[${dest}]]`);
  if (newText === entry.content) return null;

  return {
    newText,
    summary: `Bot: Fixing double redirect to [[${dest}]]`,
  };
}

// ---------- 2. Self-Links ----------

async function getMainspaceCandidateIds() {
  if (!SELF_LINK_SCAN_ALL) {
    const since = new Date(Date.now() - RC_HOURS * 3600 * 1000).toISOString();
    const ids = new Set();
    let cont = null;
    do {
      const res = await api({
        action: 'query',
        list: 'recentchanges',
        rcnamespace: '0',
        rctype: 'edit|new',
        rcend: since,
        rclimit: 'max',
        ...(cont || {}),
      });
      for (const rc of res.query?.recentchanges || []) {
        if (rc.pageid && !isExemptTitle(rc.title)) ids.add(rc.pageid);
      }
      cont = res.continue || null;
    } while (cont);
    return [...ids];
  }

  const ids = [];
  let cont = null;
  do {
    const res = await api({
      action: 'query',
      generator: 'allpages',
      gapnamespace: '0',
      gapfilterredir: 'nonredirects',
      gaplimit: 'max',
      ...(cont || {}),
    });
    for (const p of res.query?.pages || []) {
      if (p.pageid && !isExemptTitle(p.title)) ids.push(p.pageid);
    }
    cont = res.continue || null;
  } while (cont);
  return ids;
}

function sameWikiPage(a, b) {
  const clean = (s) => s.replace(/_/g, ' ').trim();
  const ca = clean(a);
  const cb = clean(b);
  if (!ca || !cb) return false;
  return ca[0].toUpperCase() + ca.slice(1) === cb[0].toUpperCase() + cb.slice(1);
}

function stripSelfLinks(title, content) {
  if (/^\s*#REDIRECT\b/i.test(content)) return { text: content, count: 0 };

  const masks = [];
  const masked = content.replace(
    /<!--[\s\S]*?-->|<(nowiki|pre|code|syntaxhighlight)\b[^>]*>[\s\S]*?<\/\1>/gi,
    (block) => {
      const key = `\u0000MASK${masks.length}\u0000`;
      masks.push(block);
      return key;
    }
  );

  let count = 0;
  const replaced = masked.replace(
    /(?<!\[)\[\[([^[\]|#\n]+)(?:\|([^[\]\n]*))?\]\](?!\])/g,
    (full, target, label) => {
      const cleanTarget = target.replace(/^:+/, '').trim();
      if (!sameWikiPage(cleanTarget, title)) return full;

      count++;
      if (label !== undefined) {
        return label.trim() === '' ? target.trim() : label;
      }
      return target.trim();
    }
  );

  const restored = replaced.replace(/\u0000MASK(\d+)\u0000/g, (_, idx) => masks[Number(idx)]);
  return { text: restored, count };
}

function planSelfLinkEdit(entry) {
  const { text, count } = stripSelfLinks(entry.title, entry.content);
  if (count === 0 || text === entry.content) return null;
  return {
    newText: text,
    summary: `Bot: Removing ${count} self-link${count === 1 ? '' : 's'} to [[${entry.title}]]`,
  };
}

// ---------- editing ----------

async function editPage(pageid, title, revid, text, summary, token) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would edit "${title}" -> ${summary}`);
    return;
  }

  await throttleEdit();
  const res = await api(
    {
      action: 'edit',
      pageid: String(pageid),
      baserevid: String(revid),
      text,
      summary,
      bot: '1',
      minor: '1',
      nocreate: '1',
      token,
    },
    true
  );

  rewardEdits();
  console.log(`Edited "${title}" (${res.edit?.result || 'OK'}) - ${summary}`);
}

// ---------- main ----------

async function main() {
  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  await login();
  const csrfToken = DRY_RUN ? null : await getCsrfToken();

  const { values, revert } = await loadTrustedConfig(CONFIG_OPTS);
  if (revert) await revertConfigPage(revert, csrfToken, { page: CONFIG_PAGE, owner: OWNER });

  if (!resolveEnabled(values)) {
    console.log('Module disabled (enabled_dr_module = false). Exiting without edits.');
    return;
  }

  const jobs = [];
  const plannedIds = new Set();

  if (FIX_DOUBLE_REDIRECTS) {
    const drTitles = await getDoubleRedirectTitles();
    if (drTitles.length > 0) {
      const drEntries = [];
      for (const batch of chunk(drTitles, BATCH_SIZE)) {
        const res = await api({
          action: 'query',
          titles: batch.join('|'),
          prop: 'revisions',
          rvprop: 'ids|content',
          rvslots: 'main',
        });
        for (const p of res.query?.pages || []) {
          const rev = p.revisions?.[0];
          const content = rev?.slots?.main?.content;
          if (!p.missing && content !== undefined) {
            drEntries.push({ pageid: p.pageid, title: p.title, revid: rev.revid, content });
          }
        }
      }

      const resolutions = await resolveFinalTargets(drEntries.map((e) => e.title));
      for (const entry of drEntries) {
        const plan = planDoubleRedirectEdit(entry, resolutions.get(entry.title));
        if (plan) {
          jobs.push({ ...entry, ...plan });
          plannedIds.add(entry.pageid);
        }
      }
    }
    console.log(`Double redirects queued: ${jobs.length}`);
  }

  if (FIX_SELF_LINKS) {
    const candidateIds = (await getMainspaceCandidateIds()).filter((id) => !plannedIds.has(id));
    const contents = await getContents(candidateIds);
    let selfLinkJobs = 0;

    for (const entry of contents.values()) {
      const plan = planSelfLinkEdit(entry);
      if (plan) {
        jobs.push({ ...entry, ...plan });
        selfLinkJobs++;
      }
    }
    console.log(`Scanned ${contents.size} articles for self-links; ${selfLinkJobs} queued.`);
  }

  if (jobs.length === 0) {
    console.log(`Nothing to update. Done in ${elapsed()}.`);
    return;
  }

  const capped = !DRY_RUN && MAX_EDITS > 0 && jobs.length > MAX_EDITS;
  const toRun = capped ? jobs.slice(0, MAX_EDITS) : jobs;
  if (capped) {
    console.log(
      `MAX_EDITS=${MAX_EDITS}: editing ${toRun.length} of ${jobs.length} pages this run; ` +
        `${jobs.length - toRun.length} deferred to later runs.`
    );
  }

  let edited = 0;
  let failed = 0;
  let stopRequested = false;
  let sinceCheck = 0;
  const retryJobs = [];

  const runJob = async (job, isRetry) => {
    if (stopRequested) return;

    if (!DRY_RUN && ++sinceCheck % STOP_CHECK_EVERY === 0) {
      try {
        const { values: fresh } = await loadTrustedConfig(CONFIG_OPTS);
        if (!resolveEnabled(fresh, true)) {
          stopRequested = true;
          console.log('Stop requested via config page (enabled_dr_module = false); halting.');
          return;
        }
      } catch (err) {
        console.warn(`Could not re-check config (${err.message}); continuing.`);
      }
    }

    try {
      await editPage(job.pageid, job.title, job.revid, job.newText, job.summary, csrfToken);
      edited++;
    } catch (err) {
      if (err.code === 'editconflict') {
        console.log(`Skipped "${job.title}" (edited by someone else mid-run).`);
      } else if (!isRetry && isRateLimitError(err.code, err.info)) {
        penalizeEdits();
        console.log(`Rate limited on "${job.title}"; will retry at the end.`);
        retryJobs.push(job);
      } else {
        failed++;
        console.error(`Failed "${job.title}": ${err.message}`);
      }
    }
  };

  await mapPool(toRun, EDIT_CONCURRENCY, (job) => runJob(job, false));

  if (retryJobs.length > 0 && !stopRequested) {
    console.log(`Cooling down 15s, then retrying ${retryJobs.length} rate-limited edit(s)...`);
    await sleep(15000);
    editInterval = Math.max(editInterval, EDIT_INTERVAL_MS * 2);
    await mapPool(retryJobs, 1, (job) => runJob(job, true));
  }

  console.log(
    `Done in ${elapsed()}${stopRequested ? ' (stopped early via config)' : ''}. ` +
      `${DRY_RUN ? `${jobs.length} would be edited` : `${edited} edited`}, ${failed} failed, ` +
      `${rateLimitHits} rate-limit hit(s).`
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
