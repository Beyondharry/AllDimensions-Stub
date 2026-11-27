// Setting priority:  Wiki (User:StubManager/Configurations)  >  Secrets (env)  >  Inline code (DEFAULTS)
//
// Required secrets (never read from the wiki):
const WIKI_API = process.env.WIKI_API;       // e.g. "https://yourwiki.fandom.com/api.php"
const BOT_USER = process.env.BOT_USER;       // e.g. "StubManager@StubBot"
const BOT_PASS = process.env.BOT_PASS;       // Generated from Special:BotPasswords
const DRY_RUN = process.env.DRY_RUN === '1'; // Set to "1" to test without editing

const intEnv = (name, def) => {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
};

// Max live edits per run. Unset/empty -> no limit. Set a number to cap.
const MAX_EDITS = intEnv('MAX_EDITS', 0);

// Speed tuning (all optional, env-only)
const EDIT_INTERVAL_MS = Math.max(250, intEnv('EDIT_INTERVAL_MS', 1100)); // base gap between edits
const MAX_EDIT_INTERVAL_MS = 15000;                                      // adaptive slowdown ceiling
const EDIT_CONCURRENCY = Math.max(1, intEnv('EDIT_CONCURRENCY', 1));
const READ_CONCURRENCY = Math.max(1, intEnv('READ_CONCURRENCY', 3));
const BATCH_SIZE = 50;   // pages per read request
const MAX_RETRIES = 8;
const STOP_CHECK_EVERY = 10; // re-read the wiki config every N edits to honour a soft stop
const TEMPLATE_MARGIN = 64;  // max bytes a stub banner can add to a page (used by the cheap pre-filter)

// ---------- wiki configuration ----------

const CONFIG_PAGE = 'User:StubManager/Configurations';
const OWNER = 'PUREDARK999';                  // always trusted
const TRUSTED_GROUPS = ['sysop', 'bureaucrat']; // trusted by group
const BOT_NAME = (BOT_USER || '').split('@')[0]; // the bot's own account is trusted too

function normalizeCategory(name) {
  return name
    .replace(/^Category:/i, '')
    .replace(/_/g, ' ')
    .trim()
    .toLowerCase();
}

const normalizeTitle = (t) => t.replace(/_/g, ' ').trim().toLowerCase();
const parseSize = (v) => (/^\d+$/.test(v) ? parseInt(v, 10) : undefined);

// Lowest priority: inline defaults.
const DEFAULTS = {
  enabled: true,
  exempt_categories: ['googology', 'salad numbers', 'stub exempt'],
  exempt_titles: [],
  exempt_title_regex: '',
  min_size: 512,        // < min_size                       -> left alone (see Special:ShortPages)
  super_stub_max: 1024, // min_size <= size < super_stub_max -> {{Super Stub}}
  stub_max: 2048,       // super_stub_max <= size < stub_max -> {{Stub}}
};

// Middle priority: secrets / environment variables (empty = not set).
const SECRETS = {
  enabled: process.env.ENABLED,
  exempt_categories: process.env.EXEMPT_CATEGORIES,
  exempt_titles: process.env.EXEMPT_TITLES,
  exempt_title_regex: process.env.EXEMPT_TITLE_REGEX,
  min_size: process.env.MIN_SIZE,
  super_stub_max: process.env.SUPER_STUB_MAX,
  stub_max: process.env.STUB_MAX,
};

// Each parser returns undefined for invalid input (the value is then ignored).
const PARSERS = {
  enabled: (v) =>
    /^(1|true|yes|on)$/i.test(v) ? true : /^(0|false|no|off)$/i.test(v) ? false : undefined,
  exempt_categories: (v) => v.split(',').map((c) => normalizeCategory(c)).filter(Boolean),
  exempt_titles: (v) => v.split(',').map((t) => normalizeTitle(t)).filter(Boolean),
  exempt_title_regex: (v) => {
    try {
      new RegExp(v, 'i');
      return v;
    } catch {
      return undefined;
    }
  },
  min_size: parseSize,
  super_stub_max: parseSize,
  stub_max: parseSize,
};

let cfg = null; // resolved in main()

if (!WIKI_API || !BOT_USER || !BOT_PASS) {
  console.error('Missing WIKI_API, BOT_USER, or BOT_PASS environment variables.');
  process.exit(1);
}

// ---------- HTTP / API ----------

const cookies = new Map();

function updateCookies(res) {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const raw of setCookies) {
    const [pair] = raw.split(';');
    const eqIdx = pair.indexOf('=');
    if (eqIdx > 0) {
      cookies.set(pair.slice(0, eqIdx).trim(), pair.slice(eqIdx + 1).trim());
    }
  }
}

function cookieHeader() {
  return Array.from(cookies.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

class ApiError extends Error {
  constructor(code, info) {
    super(`API Error (${code}): ${info}`);
    this.code = code;
    this.info = info;
  }
}

// Marks an error as retryable; rateLimited=true triggers the longer backoff.
class RetryableError extends Error {
  constructor(message, rateLimited = false) {
    super(message);
    this.rateLimited = rateLimited;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isRateLimitError = (code, info) =>
  code === 'ratelimited' || /rate.?limit|too many|throttl/i.test(`${code} ${info || ''}`);

// Adaptive edit pacing: slows down on every rate-limit hit, eases back on success.
let editInterval = EDIT_INTERVAL_MS;
let rateLimitHits = 0;

function penalizeEdits() {
  rateLimitHits++;
  const old = editInterval;
  editInterval = Math.min(MAX_EDIT_INTERVAL_MS, editInterval * 1.5);
  if (editInterval !== old) {
    console.log(`Rate limited: edit gap raised to ${editInterval} ms.`);
  }
}

function rewardEdits() {
  editInterval = Math.max(EDIT_INTERVAL_MS, Math.floor(editInterval * 0.9));
}

async function api(params, isPost = false) {
  const bodyParams = new URLSearchParams({
    format: 'json',
    formatversion: '2',
    maxlag: '5', // back off automatically if the wiki's servers are lagging
    ...params,
  });
  const url = isPost ? WIKI_API : `${WIKI_API}?${bodyParams.toString()}`;

  for (let attempt = 0; ; attempt++) {
    let retryAfterMs = 0;
    try {
      const res = await fetch(url, {
        method: isPost ? 'POST' : 'GET',
        headers: {
          'User-Agent': 'FandomStubBot/1.8 (Periodic Maintenance Script)',
          ...(cookies.size ? { Cookie: cookieHeader() } : {}),
          ...(isPost ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(isPost ? { body: bodyParams.toString() } : {}),
      });

      updateCookies(res);
      const ra = parseInt(res.headers.get('retry-after') || '', 10);
      if (ra > 0) retryAfterMs = ra * 1000;

      if (res.status === 429) throw new RetryableError('HTTP 429', true);
      if (res.status >= 500) throw new RetryableError(`HTTP ${res.status}`);

      const data = await res.json();
      if (data.error) {
        const { code, info } = data.error;
        if (isRateLimitError(code, info)) throw new RetryableError(`Rate limited (${code})`, true);
        if (code === 'maxlag') throw new RetryableError('maxlag');
        throw new ApiError(code, info);
      }
      return data;
    } catch (err) {
      const retryable = err instanceof RetryableError || !(err instanceof ApiError);
      if (!retryable || attempt >= MAX_RETRIES) {
        // Surface exhausted rate-limit retries as an ApiError so callers can detect them.
        if (err instanceof RetryableError && err.rateLimited) {
          throw new ApiError('ratelimited', err.message);
        }
        throw err;
      }

      const rateLimited = err instanceof RetryableError && err.rateLimited;
      if (rateLimited) penalizeEdits();

      const backoff = rateLimited
        ? Math.min(15000, Math.max(retryAfterMs, 3000 * 2 ** attempt))
        : Math.min(15000, Math.max(retryAfterMs, 1000 * 2 ** attempt));
      await sleep(backoff);
    }
  }
}

// ---------- helpers ----------

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Run fn over items with at most `limit` in flight.
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// Spaces out edit starts using the current (adaptive) interval.
let nextEditSlot = 0;
async function throttleEdit() {
  const now = Date.now();
  const start = Math.max(now, nextEditSlot);
  nextEditSlot = start + editInterval;
  if (start > now) await sleep(start - now);
}

// ---------- login ----------

async function login() {
  const tokenRes = await api({ action: 'query', meta: 'tokens', type: 'login' });
  const lgtoken = tokenRes.query.tokens.logintoken;

  const loginRes = await api(
    {
      action: 'login',
      lgname: BOT_USER,
      lgpassword: BOT_PASS,
      lgtoken,
    },
    true
  );

  if (loginRes.login?.result !== 'Success') {
    throw new Error(`Login failed: ${JSON.stringify(loginRes.login)}`);
  }
  console.log(`Logged in as ${BOT_USER}.`);
}

async function getCsrfToken() {
  const res = await api({ action: 'query', meta: 'tokens', type: 'csrf' });
  return res.query.tokens.csrftoken;
}

// ---------- wiki config loading ----------

// Reads `key = value` lines from the first <pre> block. Lines starting with # are comments.
function parseConfigText(text) {
  const out = {};
  const m = text.match(/<pre>([\s\S]*?)<\/pre>/i);
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const key = t.slice(0, i).trim().toLowerCase();
    if (Object.hasOwn(DEFAULTS, key)) out[key] = t.slice(i + 1).trim();
  }
  return out;
}

// Returns { values, revert }.
// `values` come ONLY from the newest revision written by a trusted user
// (sysop, bureaucrat, OWNER, or the bot itself). Untrusted edits are never used.
// `revert` is set when the latest revision is untrusted and should be rolled back.
async function loadWikiConfig() {
  const res = await api({
    action: 'query',
    prop: 'revisions',
    titles: CONFIG_PAGE,
    rvprop: 'ids|user|content',
    rvslots: 'main',
    rvlimit: '50',
  });
  const page = res.query?.pages?.[0];
  const revs = page?.revisions || [];
  if (!page || page.missing || !revs.length) {
    console.warn(`Config page "${CONFIG_PAGE}" not found; using secrets/defaults.`);
    return { values: {}, revert: null };
  }

  const names = [...new Set(revs.filter((r) => !r.userhidden && r.user).map((r) => r.user))];
  const ures = await api({
    action: 'query',
    list: 'users',
    ususers: names.join('|'),
    usprop: 'groups',
  });

  const trusted = new Set();
  for (const u of ures.query?.users || []) {
    if (u.missing || u.invalid || !u.name) continue; // IP editors and unknown users land here
    const n = normalizeTitle(u.name);
    if (
      n === normalizeTitle(OWNER) ||
      n === normalizeTitle(BOT_NAME) ||
      (u.groups || []).some((g) => TRUSTED_GROUPS.includes(g))
    ) {
      trusted.add(u.name);
    }
  }

  const isTrusted = (r) =>
    !r.userhidden && trusted.has(r.user) && r.slots?.main?.content !== undefined;

  const good = revs.find(isTrusted);
  if (!good) {
    console.warn('No trusted revision of the config page found; ignoring it.');
    return { values: {}, revert: null };
  }

  const revert = isTrusted(revs[0])
    ? null
    : {
        text: good.slots.main.content,
        baseRevid: revs[0].revid,
        goodRevid: good.revid,
        goodUser: good.user,
        badUser: revs[0].user || '(hidden)',
      };

  return { values: parseConfigText(good.slots.main.content), revert };
}

// Restores the last trusted revision's text over an untrusted edit.
async function revertConfigPage(r, token) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would revert config page edit by ${r.badUser}.`);
    return;
  }
  try {
    await api(
      {
        action: 'edit',
        title: CONFIG_PAGE,
        text: r.text,
        baserevid: String(r.baseRevid), // fail instead of clobbering a newer edit
        summary:
          `Bot: Reverting edit by ${r.badUser} (only sysops, bureaucrats and ${OWNER} may edit this page); ` +
          `restoring revision ${r.goodRevid} by ${r.goodUser}`,
        nocreate: '1',
        // Deliberately no bot flag, so admins can see the revert in Recent Changes.
        token,
      },
      true
    );
    console.log(`Reverted config page edit by ${r.badUser}.`);
  } catch (err) {
    console.error(`Could not revert config page: ${err.message}`);
  }
}

// Merge layers: Wiki > Secrets > Defaults. Empty values count as "not set".
function resolveConfig(wikiValues, { quiet = false } = {}) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    let val;
    for (const [src, raw] of [
      ['wiki', wikiValues[key]],
      ['secret', SECRETS[key]],
    ]) {
      if (raw === undefined || String(raw).trim() === '') continue;
      const parsed = PARSERS[key](String(raw).trim());
      if (parsed !== undefined) {
        val = parsed;
        break;
      }
      if (!quiet) console.warn(`Ignoring invalid ${src} value for ${key}: "${raw}"`);
    }
    out[key] = val !== undefined ? val : DEFAULTS[key];
  }

  if (!(out.min_size < out.super_stub_max && out.super_stub_max < out.stub_max)) {
    if (!quiet) {
      console.warn(
        'Size thresholds must satisfy min_size < super_stub_max < stub_max; using defaults for all three.'
      );
    }
    out.min_size = DEFAULTS.min_size;
    out.super_stub_max = DEFAULTS.super_stub_max;
    out.stub_max = DEFAULTS.stub_max;
  }

  out.titleSet = new Set(out.exempt_titles);
  out.titleRegex = out.exempt_title_regex ? new RegExp(out.exempt_title_regex, 'i') : null;
  return out;
}

// ---------- reading ----------

// Scan: all non-redirect mainspace pages with size + any Stub/Super Stub templates.
async function getAllMainspacePages() {
  const pages = new Map();
  let cont = null;

  do {
    const res = await api({
      action: 'query',
      generator: 'allpages',
      gapnamespace: '0',
      gapfilterredir: 'nonredirects',
      gaplimit: 'max',
      prop: 'info|templates',
      tltemplates: 'Template:Stub|Template:Super Stub',
      tllimit: 'max',
      ...(cont || {}), // full continue object (gapcontinue, tlcontinue, ...)
    });

    for (const p of res.query?.pages || []) {
      const existing = pages.get(p.pageid) || { ...p, templates: [] };
      if (p.length !== undefined) existing.length = p.length;
      for (const t of p.templates || []) {
        if (!existing.templates.includes(t.title)) existing.templates.push(t.title);
      }
      pages.set(p.pageid, existing);
    }
    cont = res.continue || null;
  } while (cont);

  return Array.from(pages.values());
}

// Categories for a set of page IDs, batched and in parallel. Map<pageid, string[]>
async function getCategories(pageids) {
  const result = new Map();
  await mapPool(chunk(pageids, BATCH_SIZE), READ_CONCURRENCY, async (batch) => {
    let cont = null;
    do {
      const res = await api({
        action: 'query',
        prop: 'categories',
        pageids: batch.join('|'),
        cllimit: 'max',
        ...(cont || {}),
      });
      for (const p of res.query?.pages || []) {
        const list = result.get(p.pageid) || [];
        for (const c of p.categories || []) list.push(c.title);
        result.set(p.pageid, list);
      }
      cont = res.continue || null;
    } while (cont);
  });
  return result;
}

// Wikitext + revision ID for a set of page IDs, batched and in parallel.
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
          result.set(p.pageid, { revid: rev.revid, content });
        }
      }
      cont = res.continue || null;
    } while (cont);
  });
  return result;
}

// ---------- editing ----------

// Strict, case-sensitive checks on raw wikitext
const RE_SUPER = /\{\{Super Stub\}\}/;
const RE_STUB = /\{\{Stub\}\}/;
const STRIP_SUPER = /\{\{Super Stub\}\}[ \t]*\r?\n?/g;
const STRIP_STUB = /\{\{Stub\}\}[ \t]*\r?\n?/g;

const byteLen = (str) => Buffer.byteLength(str, 'utf8');

// The page with every stub banner removed. Its size does NOT change when the bot adds,
// removes or swaps a banner, so the size band it falls in is stable between runs.
const stripBanners = (content) =>
  content.replace(STRIP_SUPER, '').replace(STRIP_STUB, '').replace(/^\s+/, '');

// 'super' | 'stub' | 'none' (left to human judgement)
function bandOf(size) {
  if (size < cfg.min_size || size >= cfg.stub_max) return 'none';
  return size < cfg.super_stub_max ? 'super' : 'stub';
}

// Pure function: returns { newText, summary } or null if nothing to do.
// The band is chosen from the size WITHOUT the banner, so adding a banner can never
// push a page across a threshold and make the next run flip it back.
function planEdit(page, content) {
  const hasSuper = RE_SUPER.test(content);
  const hasStub = RE_STUB.test(content);
  const baseSize = byteLen(stripBanners(content));
  const band = bandOf(baseSize);

  if (band === 'none') return null;

  if (band === 'super') {
    if (hasSuper && !hasStub) return null;

    let newText = content.replace(STRIP_STUB, '');
    if (!RE_SUPER.test(newText)) {
      newText = `{{Super Stub}}\n\n\n${newText.replace(/^\s+/, '')}`;
    }
    if (newText === content) return null;

    return {
      newText,
      summary: hasStub
        ? `Bot: Upgrading {{Stub}} to {{Super Stub}} (content size without banner: ${baseSize} bytes < ${cfg.super_stub_max})`
        : `Bot: Adding {{Super Stub}} (content size without banner: ${baseSize} bytes < ${cfg.super_stub_max})`,
    };
  }

  // band === 'stub'
  if (hasStub && !hasSuper) return null;

  let newText = content.replace(STRIP_SUPER, '');
  if (!RE_STUB.test(newText)) {
    newText = `{{Stub}}\n\n\n${newText.replace(/^\s+/, '')}`;
  }
  if (newText === content) return null;

  return {
    newText,
    summary: hasSuper
      ? `Bot: Changing {{Super Stub}} to {{Stub}} (content size without banner: ${baseSize} bytes >= ${cfg.super_stub_max})`
      : `Bot: Adding {{Stub}} (content size without banner: ${baseSize} bytes < ${cfg.stub_max})`,
  };
}

async function editPage(page, revid, text, summary, token) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would edit "${page.title}" -> ${summary}`);
    return;
  }

  await throttleEdit();
  const res = await api(
    {
      action: 'edit',
      pageid: String(page.pageid),
      baserevid: String(revid), // don't clobber edits made since we read the page
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
  console.log(`Edited "${page.title}" (${res.edit?.result || 'OK'}) - ${summary}`);
}

// ---------- main ----------

async function main() {
  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  await login();
  const csrfToken = DRY_RUN ? null : await getCsrfToken();

  // Load settings from the wiki (trusted revisions only) and undo untrusted edits.
  const { values, revert } = await loadWikiConfig();
  if (revert) await revertConfigPage(revert, csrfToken);
  cfg = resolveConfig(values);

  // Soft stop: `enabled = false` on the config page.
  if (!cfg.enabled) {
    console.log('Bot is disabled (enabled = false). Exiting without edits.');
    return;
  }

  const pages = await getAllMainspacePages();

  // Stage 1 (free, from the scan): cheap pre-filter. The scanned size includes any banner, so the
  // real (banner-free) size lies between length - TEMPLATE_MARGIN and length. If that whole range
  // sits in one band and the templates already match it, the page is settled. If the range
  // straddles a threshold we can't tell yet, so the page stays a candidate and planEdit
  // decides from the exact banner-free size.
  let candidates = pages.filter((p) => {
    const hasSuper = p.templates.includes('Template:Super Stub');
    const hasStub = p.templates.includes('Template:Stub');
    const overhead = hasSuper || hasStub ? TEMPLATE_MARGIN : 0;

    const hiBand = bandOf(p.length);
    const loBand = bandOf(Math.max(0, p.length - overhead));
    if (hiBand !== loBand) return true;
    if (hiBand === 'none') return false;
    return hiBand === 'super' ? !hasSuper || hasStub : !hasStub || hasSuper;
  });

  // Stage 2 (free): title exemptions (exact titles + regex).
  let exemptCount = 0;
  {
    const before = candidates.length;
    candidates = candidates.filter(
      (p) =>
        !cfg.titleSet.has(normalizeTitle(p.title)) &&
        !(cfg.titleRegex && cfg.titleRegex.test(p.title))
    );
    exemptCount += before - candidates.length;
  }

  // Stage 3: category exemption, fetched ONLY for the remaining candidates.
  if (cfg.exempt_categories.length && candidates.length) {
    const cats = await getCategories(candidates.map((p) => p.pageid));
    const before = candidates.length;
    candidates = candidates.filter(
      (p) =>
        !(cats.get(p.pageid) || []).some((c) =>
          cfg.exempt_categories.includes(normalizeCategory(c))
        )
    );
    exemptCount += before - candidates.length;
  }

  console.log(
    `Scanned ${pages.length} articles. ${candidates.length} need updates ` +
      `(${exemptCount} otherwise-eligible pages skipped as exempt).`
  );
  if (candidates.length === 0) {
    console.log(`Done in ${elapsed()}.`);
    return;
  }

  // Stage 4: batched content fetch.
  const contents = await getContents(candidates.map((p) => p.pageid));

  // Stage 5: plan edits (pure, instant).
  const jobs = [];
  for (const page of candidates) {
    const entry = contents.get(page.pageid);
    if (!entry) continue;
    const plan = planEdit(page, entry.content);
    if (plan) jobs.push({ page, revid: entry.revid, ...plan });
  }

  // Stage 6: apply the cap. Dry runs always show everything.
  const capped = !DRY_RUN && MAX_EDITS > 0 && jobs.length > MAX_EDITS;
  const toRun = capped ? jobs.slice(0, MAX_EDITS) : jobs;
  if (capped) {
    console.log(
      `MAX_EDITS=${MAX_EDITS}: editing ${toRun.length} of ${jobs.length} pages this run; ` +
        `${jobs.length - toRun.length} deferred to later runs.`
    );
  }

  // Stage 7: apply edits, rate-limited. Rate-limit failures are collected for a retry pass.
  let edited = 0;
  let failed = 0;
  let stopRequested = false;
  let sinceCheck = 0;
  const retryJobs = [];

  const runJob = async (job, isRetry) => {
    if (stopRequested) return;

    // Every STOP_CHECK_EVERY edits, re-read the trusted config to honour a soft stop.
    if (!DRY_RUN && ++sinceCheck % STOP_CHECK_EVERY === 0) {
      try {
        const fresh = resolveConfig((await loadWikiConfig()).values, { quiet: true });
        if (!fresh.enabled) {
          stopRequested = true;
          console.log('Stop requested via config page (enabled = false); halting.');
          return;
        }
      } catch (err) {
        console.warn(`Could not re-check config (${err.message}); continuing.`);
      }
    }

    try {
      await editPage(job.page, job.revid, job.newText, job.summary, csrfToken);
      edited++;
    } catch (err) {
      if (err.code === 'editconflict') {
        console.log(`Skipped "${job.page.title}" (edited by someone else mid-run).`);
      } else if (!isRetry && isRateLimitError(err.code, err.info)) {
        console.log(`Rate limited on "${job.page.title}"; will retry at the end.`);
        retryJobs.push(job);
      } else {
        failed++;
        console.error(`Failed "${job.page.title}": ${err.message}`);
      }
    }
  };

  await mapPool(toRun, EDIT_CONCURRENCY, (job) => runJob(job, false));

  // Stage 8: one cleanup pass for anything that was rate limited, after a cooldown.
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
