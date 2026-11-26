// stub-bot.mjs — Dynamic Fandom Stub / Super Stub Manager (fast, capped, rate-limit safe)
const WIKI_API = process.env.WIKI_API;       // e.g. "https://yourwiki.fandom.com/api.php"
const BOT_USER = process.env.BOT_USER;       // e.g. "StubManager@StubBot"
const BOT_PASS = process.env.BOT_PASS;       // Generated from Special:BotPasswords
const DRY_RUN = process.env.DRY_RUN === '1'; // Set to "1" to test without editing

const intEnv = (name, def) => {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
};

// Max live edits per run. Unset/empty -> 10. Set to 0 for no limit.
const MAX_EDITS = intEnv('MAX_EDITS', 300);

// Speed tuning (all optional)
const EDIT_INTERVAL_MS = Math.max(250, intEnv('EDIT_INTERVAL_MS', 2000)); // base gap between edits
const MAX_EDIT_INTERVAL_MS = 30000;                                      // adaptive slowdown ceiling
const EDIT_CONCURRENCY = Math.max(1, intEnv('EDIT_CONCURRENCY', 1));
const READ_CONCURRENCY = Math.max(1, intEnv('READ_CONCURRENCY', 4));
const BATCH_SIZE = 50;   // pages per read request
const MAX_RETRIES = 8;

// Pages in these categories are never given (or stripped of) stub templates.
const EXEMPT_CATEGORIES = (
  process.env.EXEMPT_CATEGORIES || 'Googology,Salad numbers,Stub exempt'
)
  .split(',')
  .map((c) => normalizeCategory(c))
  .filter(Boolean);

// Optional: pages whose title matches this regex are also exempt.
const EXEMPT_TITLE_REGEX = process.env.EXEMPT_TITLE_REGEX
  ? new RegExp(process.env.EXEMPT_TITLE_REGEX, 'i')
  : null;

const SUPER_STUB_MAX = 1024; // 512 <= size < 1024  -> {{Super Stub}}
const STUB_MAX = 2048;       // 1024 <= size < 2048 -> {{Stub}}
const MIN_SIZE = 512;        // < 512 -> left alone (see Special:ShortPages)

if (!WIKI_API || !BOT_USER || !BOT_PASS) {
  console.error('Missing WIKI_API, BOT_USER, or BOT_PASS environment variables.');
  process.exit(1);
}

function normalizeCategory(name) {
  return name
    .replace(/^Category:/i, '')
    .replace(/_/g, ' ')
    .trim()
    .toLowerCase();
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
  editInterval = Math.min(MAX_EDIT_INTERVAL_MS, editInterval * 2);
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
          'User-Agent': 'FandomStubBot/1.6 (Periodic Maintenance Script)',
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
        ? Math.min(120000, Math.max(retryAfterMs, 5000 * 2 ** attempt))
        : Math.min(30000, Math.max(retryAfterMs, 1000 * 2 ** attempt));
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

// Pure function: returns { newText, summary } or null if nothing to do.
function planEdit(page, content) {
  const hasSuper = RE_SUPER.test(content);
  const hasStub = RE_STUB.test(content);

  // 512 to 1023 bytes -> ONLY {{Super Stub}}
  if (page.length < SUPER_STUB_MAX) {
    if (hasSuper && !hasStub) return null;

    let newText = content.replace(STRIP_STUB, '');
    if (!RE_SUPER.test(newText)) {
      newText = `{{Super Stub}}\n${newText.replace(/^\s+/, '')}`;
    }
    if (newText === content) return null;

    return {
      newText,
      summary: hasStub
        ? `Bot: Upgrading {{Stub}} to {{Super Stub}} (page size: ${page.length} bytes < 1024)`
        : `Bot: Adding {{Super Stub}} (page size: ${page.length} bytes < 1024)`,
    };
  }

  // 1024 to 2047 bytes -> ONLY {{Stub}}
  if (hasStub && !hasSuper) return null;

  let newText = content.replace(STRIP_SUPER, '');
  if (!RE_STUB.test(newText)) {
    newText = `{{Stub}}\n${newText.replace(/^\s+/, '')}`;
  }
  if (newText === content) return null;

  return {
    newText,
    summary: hasSuper
      ? `Bot: Changing {{Super Stub}} to {{Stub}} (page size: ${page.length} bytes >= 1024)`
      : `Bot: Adding {{Stub}} (page size: ${page.length} bytes < 2048)`,
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

  const pages = await getAllMainspacePages();

  // Stage 1 (free, from the scan): only pages 512-2047 bytes whose templates
  // don't match their size band. <512 and >=2048 are never touched.
  let candidates = pages.filter((p) => {
    if (p.length < MIN_SIZE || p.length >= STUB_MAX) return false;

    const hasSuper = p.templates.includes('Template:Super Stub');
    const hasStub = p.templates.includes('Template:Stub');

    if (p.length < SUPER_STUB_MAX) return !hasSuper || hasStub;
    return !hasStub || hasSuper;
  });

  // Stage 2 (free): title-regex exemption.
  let exemptCount = 0;
  if (EXEMPT_TITLE_REGEX) {
    const before = candidates.length;
    candidates = candidates.filter((p) => !EXEMPT_TITLE_REGEX.test(p.title));
    exemptCount += before - candidates.length;
  }

  // Stage 3: category exemption, fetched ONLY for the remaining candidates.
  if (EXEMPT_CATEGORIES.length && candidates.length) {
    const cats = await getCategories(candidates.map((p) => p.pageid));
    const before = candidates.length;
    candidates = candidates.filter(
      (p) => !(cats.get(p.pageid) || []).some((c) => EXEMPT_CATEGORIES.includes(normalizeCategory(c)))
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
  const retryJobs = [];

  const runJob = async (job, isRetry) => {
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
  if (retryJobs.length > 0) {
    console.log(`Cooling down 30s, then retrying ${retryJobs.length} rate-limited edit(s)...`);
    await sleep(30000);
    editInterval = Math.max(editInterval, EDIT_INTERVAL_MS * 2);
    await mapPool(retryJobs, 1, (job) => runJob(job, true));
  }

  console.log(
    `Done in ${elapsed()}. ` +
      `${DRY_RUN ? `${jobs.length} would be edited` : `${edited} edited`}, ${failed} failed, ` +
      `${rateLimitHits} rate-limit hit(s).`
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
