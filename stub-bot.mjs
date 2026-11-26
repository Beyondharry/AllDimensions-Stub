// stub-bot.mjs — Dynamic Fandom Stub / Super Stub Manager (fast)
const WIKI_API = process.env.WIKI_API;       // e.g. "https://yourwiki.fandom.com/api.php"
const BOT_USER = process.env.BOT_USER;       // e.g. "StubManager@StubBot"
const BOT_PASS = process.env.BOT_PASS;       // Generated from Special:BotPasswords
const DRY_RUN = process.env.DRY_RUN === '1'; // Set to "1" to test without editing

const intEnv = (name, def) => {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
};

// Speed tuning (all optional)
const EDIT_INTERVAL_MS = intEnv('EDIT_INTERVAL_MS', 600); // min gap between edit starts
const EDIT_CONCURRENCY = Math.max(1, intEnv('EDIT_CONCURRENCY', 3));
const READ_CONCURRENCY = Math.max(1, intEnv('READ_CONCURRENCY', 4));
const BATCH_SIZE = 50;   // pages per read request (50 works for everyone)
const MAX_RETRIES = 5;

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
  }
}

const RETRYABLE_CODES = new Set(['maxlag', 'ratelimited']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
          'User-Agent': 'FandomStubBot/1.4 (Periodic Maintenance Script)',
          ...(cookies.size ? { Cookie: cookieHeader() } : {}),
          ...(isPost ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(isPost ? { body: bodyParams.toString() } : {}),
      });

      updateCookies(res);
      const ra = parseInt(res.headers.get('retry-after') || '', 10);
      if (ra > 0) retryAfterMs = ra * 1000;

      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      if (data.error) {
        if (RETRYABLE_CODES.has(data.error.code)) {
          throw new Error(`Retryable API error: ${data.error.code}`);
        }
        throw new ApiError(data.error.code, data.error.info);
      }
      return data;
    } catch (err) {
      if (err instanceof ApiError || attempt >= MAX_RETRIES) throw err;
      await sleep(retryAfterMs || Math.min(30000, 1000 * 2 ** attempt));
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

// Spaces out edit starts so concurrency never exceeds the configured rate.
let nextEditSlot = 0;
async function throttleEdit() {
  const now = Date.now();
  const wait = Math.max(0, nextEditSlot - now);
  nextEditSlot = Math.max(now, nextEditSlot) + EDIT_INTERVAL_MS;
  if (wait > 0) await sleep(wait);
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

  console.log(`Edited "${page.title}" (${res.edit?.result || 'OK'}) - ${summary}`);
}

// ---------- main ----------

async function main() {
  const t0 = Date.now();
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
    console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
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

  // Stage 6: apply edits in parallel, rate-limited.
  let edited = 0;
  let failed = 0;
  await mapPool(jobs, EDIT_CONCURRENCY, async (job) => {
    try {
      await editPage(job.page, job.revid, job.newText, job.summary, csrfToken);
      edited++;
    } catch (err) {
      if (err.code === 'editconflict') {
        console.log(`Skipped "${job.page.title}" (edited by someone else mid-run).`);
      } else {
        failed++;
        console.error(`Failed "${job.page.title}": ${err.message}`);
      }
    }
  });

  console.log(
    `Done in ${((Date.now() - t0) / 1000).toFixed(1)}s. ` +
      `${DRY_RUN ? `${jobs.length} would be edited` : `${edited} edited`}, ${failed} failed.`
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
