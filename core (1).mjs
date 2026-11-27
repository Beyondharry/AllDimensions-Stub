// core.mjs — shared plumbing for every StubManager task.
// API client (cookies, retries, maxlag, rate-limit backoff), login, trusted wiki-config loader,
// config layering (Wiki > Secrets > Inline defaults) and small helpers.
//
// Env (secrets): WIKI_API, BOT_USER, BOT_PASS.  Optional: DRY_RUN=1, READ_CONCURRENCY.

export const WIKI_API = process.env.WIKI_API;
export const BOT_USER = process.env.BOT_USER;
export const BOT_PASS = process.env.BOT_PASS;
export const DRY_RUN = process.env.DRY_RUN === '1';
export const BOT_NAME = (BOT_USER || '').split('@')[0]; // "StubManager"
export const USER_AGENT = 'StubManager/2.0 (Wiki maintenance tasks)';

export const intEnv = (name, def) => {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
};

export const READ_CONCURRENCY = Math.max(1, intEnv('READ_CONCURRENCY', 3));
export const BATCH_SIZE = 50; // pages per read request
const MAX_RETRIES = 8;

// ---------- small helpers ----------

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Run fn over items with at most `limit` in flight.
export async function mapPool(items, limit, fn) {
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

export const normalizeTitle = (t) => t.replace(/_/g, ' ').trim().toLowerCase();

export const normalizeCategory = (name) =>
  name.replace(/^Category:/i, '').replace(/_/g, ' ').trim().toLowerCase();

export const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- HTTP / API ----------

const cookies = new Map();

function updateCookies(res) {
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const raw of setCookies) {
    const [pair] = raw.split(';');
    const eqIdx = pair.indexOf('=');
    if (eqIdx > 0) cookies.set(pair.slice(0, eqIdx).trim(), pair.slice(eqIdx + 1).trim());
  }
}

const cookieHeader = () =>
  Array.from(cookies.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

export class ApiError extends Error {
  constructor(code, info) {
    super(`API Error (${code}): ${info}`);
    this.code = code;
    this.info = info;
  }
}

class RetryableError extends Error {
  constructor(message, rateLimited = false) {
    super(message);
    this.rateLimited = rateLimited;
  }
}

export const isRateLimitError = (code, info) =>
  code === 'ratelimited' || /rate.?limit|too many|throttl/i.test(`${code} ${info || ''}`);

export async function api(params, isPost = false) {
  if (!WIKI_API) throw new Error('WIKI_API is not set.');
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
          'User-Agent': USER_AGENT,
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
        if (err instanceof RetryableError && err.rateLimited) {
          throw new ApiError('ratelimited', err.message);
        }
        throw err;
      }
      const rateLimited = err instanceof RetryableError && err.rateLimited;
      const backoff = Math.min(
        15000,
        Math.max(retryAfterMs, (rateLimited ? 3000 : 1000) * 2 ** attempt)
      );
      await sleep(backoff);
    }
  }
}

// ---------- login / tokens / generic helpers ----------

export async function login() {
  if (!WIKI_API || !BOT_USER || !BOT_PASS) {
    throw new Error('Missing WIKI_API, BOT_USER, or BOT_PASS environment variables.');
  }
  const tokenRes = await api({ action: 'query', meta: 'tokens', type: 'login' });
  const lgtoken = tokenRes.query.tokens.logintoken;
  const loginRes = await api(
    { action: 'login', lgname: BOT_USER, lgpassword: BOT_PASS, lgtoken },
    true
  );
  if (loginRes.login?.result !== 'Success') {
    throw new Error(`Login failed: ${JSON.stringify(loginRes.login)}`);
  }
  console.log(`Logged in as ${BOT_USER}.`);
}

export async function getCsrfToken() {
  const res = await api({ action: 'query', meta: 'tokens', type: 'csrf' });
  return res.query.tokens.csrftoken;
}

// Create or overwrite a page. Returns the API's edit result string ("Success", ...).
export async function savePage(title, text, summary, token) {
  const res = await api(
    { action: 'edit', title, text, summary, bot: '1', token },
    true
  );
  return res.edit?.nochange ? 'nochange' : res.edit?.result || 'OK';
}

// Categories for a set of page IDs, batched and in parallel. Map<pageid, string[]>
export async function getCategories(pageids) {
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

// ---------- trusted wiki config (shared by every task) ----------

// Reads `key = value` lines from the first <pre> block. Lines starting with # are comments.
// Keys not in `keys` are ignored, so several tasks can share one config page.
export function parseKeyValues(text, keys) {
  const allowed = new Set(keys);
  const out = {};
  const m = text.match(/<pre>([\s\S]*?)<\/pre>/i);
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const key = t.slice(0, i).trim().toLowerCase();
    if (allowed.has(key)) out[key] = t.slice(i + 1).trim();
  }
  return out;
}

// Reads the newest revision of `page` written by a trusted user
// (a sysop/bureaucrat, `owner`, or the bot itself). Untrusted edits are never used.
// Returns { text, meta: { user, revid } | null, revert }.
//   text   = wikitext of the newest trusted revision (null if none / page missing)
//   revert = set when the latest revision is untrusted and should be rolled back
export async function loadTrustedPage({ page, owner, trustedGroups = ['sysop', 'bureaucrat'] }) {
  const res = await api({
    action: 'query',
    prop: 'revisions',
    titles: page,
    rvprop: 'ids|user|content',
    rvslots: 'main',
    rvlimit: '50',
  });
  const p = res.query?.pages?.[0];
  const revs = p?.revisions || [];
  if (!p || p.missing || !revs.length) {
    console.warn(`Config page "${page}" not found; using secrets/defaults.`);
    return { text: null, meta: null, revert: null, missing: true };
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
      n === normalizeTitle(owner) ||
      n === normalizeTitle(BOT_NAME) ||
      (u.groups || []).some((g) => trustedGroups.includes(g))
    ) {
      trusted.add(u.name);
    }
  }

  const isTrusted = (r) =>
    !r.userhidden && trusted.has(r.user) && r.slots?.main?.content !== undefined;

  const good = revs.find(isTrusted);
  if (!good) {
    console.warn(`No trusted revision of "${page}" found; ignoring it.`);
    return { text: null, meta: null, revert: null, missing: false };
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

  return {
    text: good.slots.main.content,
    meta: { user: good.user, revid: good.revid },
    revert,
    missing: false,
  };
}

// Same as loadTrustedPage, parsed as `key = value` lines of the first <pre> block.
// Returns { values, revert, meta }.
export async function loadTrustedConfig({ page, owner, keys, trustedGroups = ['sysop', 'bureaucrat'] }) {
  const r = await loadTrustedPage({ page, owner, trustedGroups });
  return {
    values: r.text == null ? {} : parseKeyValues(r.text, keys),
    revert: r.revert,
    meta: r.meta,
  };
}

// Restores the last trusted revision's text over an untrusted edit.
export async function revertConfigPage(r, token, { page, owner }) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would revert config page edit by ${r.badUser}.`);
    return;
  }
  try {
    await api(
      {
        action: 'edit',
        title: page,
        text: r.text,
        baserevid: String(r.baseRevid), // fail instead of clobbering a newer edit
        summary:
          `Bot: Reverting edit by ${r.badUser} (only sysops, bureaucrats and ${owner} may edit this page); ` +
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

// ---------- config layering: Wiki > Secrets (env) > Inline defaults ----------

// Reusable value parsers. Each returns undefined for invalid input (the value is then ignored).
export const P = {
  bool: (v) =>
    /^(1|true|yes|on)$/i.test(v) ? true : /^(0|false|no|off)$/i.test(v) ? false : undefined,
  uint: (v) => (/^\d+$/.test(v) ? parseInt(v, 10) : undefined),
  posint: (v) => (/^\d+$/.test(v) && parseInt(v, 10) > 0 ? parseInt(v, 10) : undefined),
  categories: (v) => v.split(',').map((c) => normalizeCategory(c)).filter(Boolean),
  titles: (v) => v.split(',').map((t) => normalizeTitle(t)).filter(Boolean),
  regex: (v) => {
    try {
      new RegExp(v, 'i');
      return v;
    } catch {
      return undefined;
    }
  },
  prefix: (v) => {
    const t = v.trim().replace(/_/g, ' ');
    if (!t) return undefined;
    return t.endsWith('/') ? t : `${t}/`;
  },
};

// Empty values count as "not set" and fall through to the next layer.
export function resolveLayers({ defaults, secrets, parsers, wiki, quiet = false }) {
  const out = {};
  for (const key of Object.keys(defaults)) {
    let val;
    for (const [src, raw] of [
      ['wiki', wiki[key]],
      ['secret', secrets[key]],
    ]) {
      if (raw === undefined || String(raw).trim() === '') continue;
      const parsed = parsers[key](String(raw).trim());
      if (parsed !== undefined) {
        val = parsed;
        break;
      }
      if (!quiet) console.warn(`Ignoring invalid ${src} value for ${key}: "${raw}"`);
    }
    out[key] = val !== undefined ? val : defaults[key];
  }
  return out;
}

// Like resolveLayers, but also reports which layer each value came from
// ('wiki' | 'secret' | 'default'). Returns { values, sources }.
export function resolveLayersDetailed({ defaults, secrets, parsers, wiki, quiet = false }) {
  const values = {};
  const sources = {};
  for (const key of Object.keys(defaults)) {
    let val;
    let src = 'default';
    for (const [layer, raw] of [
      ['wiki', wiki[key]],
      ['secret', secrets[key]],
    ]) {
      if (raw === undefined || String(raw).trim() === '') continue;
      const parsed = parsers[key](String(raw).trim());
      if (parsed !== undefined) {
        val = parsed;
        src = layer;
        break;
      }
      if (!quiet) console.warn(`Ignoring invalid ${layer} value for ${key}: "${raw}"`);
    }
    values[key] = val !== undefined ? val : defaults[key];
    sources[key] = src;
  }
  return { values, sources };
}
