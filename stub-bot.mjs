// stub-bot.mjs — Dynamic Fandom Stub / Super Stub Manager
const WIKI_API = process.env.WIKI_API;       // e.g. "https://yourwiki.fandom.com/api.php"
const BOT_USER = process.env.BOT_USER;       // e.g. "StubManager@StubBot"
const BOT_PASS = process.env.BOT_PASS;       // Generated from Special:BotPasswords
const DRY_RUN = process.env.DRY_RUN === '1'; // Set to "1" to test without editing

// Pages in these categories are never given (or stripped of) stub templates.
// Comma-separated, without the "Category:" prefix. Adjust to your wiki's real category names.
const EXEMPT_CATEGORIES = (
  process.env.EXEMPT_CATEGORIES || 'Googology,Salad numbers,Stub exempt'
)
  .split(',')
  .map((c) => normalizeCategory(c))
  .filter(Boolean);

// Optional: pages whose title matches this regex are also exempt (e.g. "^(Googol|Salad)").
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

async function api(params, isPost = false) {
  const bodyParams = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  const url = isPost ? WIKI_API : `${WIKI_API}?${bodyParams.toString()}`;

  const res = await fetch(url, {
    method: isPost ? 'POST' : 'GET',
    headers: {
      'User-Agent': 'FandomStubBot/1.3 (Periodic Maintenance Script)',
      ...(cookies.size ? { Cookie: cookieHeader() } : {}),
      ...(isPost ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(isPost ? { body: bodyParams.toString() } : {}),
  });

  updateCookies(res);
  const data = await res.json();
  if (data.error) {
    throw new Error(`API Error (${data.error.code}): ${data.error.info}`);
  }
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Fetch all non-redirect mainspace pages with their size, categories, and any
// transcluded Stub/Super Stub templates.
async function getAllMainspacePages() {
  const pages = new Map();
  let cont = null;

  do {
    const params = {
      action: 'query',
      generator: 'allpages',
      gapnamespace: '0',
      gapfilterredir: 'nonredirects',
      gaplimit: '500',
      prop: 'info|templates|categories',
      tltemplates: 'Template:Stub|Template:Super Stub',
      tllimit: 'max',
      cllimit: 'max',
      ...(cont || {}), // pass back the full continue object (gapcontinue, tlcontinue, clcontinue...)
    };

    const res = await api(params);
    if (res.query?.pages) {
      for (const p of res.query.pages) {
        const existing = pages.get(p.pageid) || { ...p, templates: [], categories: [] };
        if (p.length !== undefined) existing.length = p.length;
        if (p.templates) {
          for (const t of p.templates) {
            if (!existing.templates.includes(t.title)) existing.templates.push(t.title);
          }
        }
        if (p.categories) {
          for (const c of p.categories) {
            if (!existing.categories.includes(c.title)) existing.categories.push(c.title);
          }
        }
        pages.set(p.pageid, existing);
      }
    }
    cont = res.continue || null;
  } while (cont);

  return Array.from(pages.values());
}

function isExempt(page) {
  if (EXEMPT_TITLE_REGEX && EXEMPT_TITLE_REGEX.test(page.title)) return true;
  return page.categories.some((c) => EXEMPT_CATEGORIES.includes(normalizeCategory(c)));
}

async function getPageContent(pageid) {
  const res = await api({
    action: 'query',
    pageids: String(pageid),
    prop: 'revisions',
    rvprop: 'content',
    rvslots: 'main',
  });
  const page = res.query?.pages?.[0];
  return page?.revisions?.[0]?.slots?.main?.content ?? null;
}

async function editPage(pageid, title, text, summary, token) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would edit "${title}" -> ${summary}`);
    return;
  }

  const res = await api(
    {
      action: 'edit',
      pageid: String(pageid),
      text,
      summary,
      bot: '1',
      minor: '1',
      nocreate: '1',
      token,
    },
    true
  );

  console.log(`Edited "${title}" (${res.edit?.result || 'OK'}) - ${summary}`);
}

async function main() {
  await login();
  const csrfToken = await getCsrfToken();

  const pages = await getAllMainspacePages();

  // Pre-filter. Only pages from 512 to 2047 bytes are ever touched:
  //  - < 512 bytes: ignored (visible at Special:ShortPages)
  //  - >= 2048 bytes: ignored (existing stub templates there are left for humans to judge)
  //  - exempt pages (googology, salad numbers, etc.): ignored
  const actionable = pages.filter((p) => {
    if (p.length < MIN_SIZE || p.length >= STUB_MAX) return false;
    if (isExempt(p)) return false;

    const hasSuper = p.templates.includes('Template:Super Stub');
    const hasStub = p.templates.includes('Template:Stub');

    if (p.length < SUPER_STUB_MAX) {
      return !hasSuper || hasStub; // Should ONLY have {{Super Stub}}
    }
    return !hasStub || hasSuper;   // Should ONLY have {{Stub}}
  });

  const exemptCount = pages.filter(
    (p) => p.length >= MIN_SIZE && p.length < STUB_MAX && isExempt(p)
  ).length;

  console.log(
    `Scanned ${pages.length} articles. ${actionable.length} need updates ` +
      `(${exemptCount} in the 512-2047 byte range skipped as exempt).`
  );
  if (actionable.length === 0) return;

  // Strict, case-sensitive checks on raw wikitext
  const exactSuperStub = /\{\{Super Stub\}\}/;
  const exactStub = /\{\{Stub\}\}/;

  for (const page of actionable) {
    const content = await getPageContent(page.pageid);
    if (content === null) continue;

    const hasSuper = exactSuperStub.test(content);
    const hasStub = exactStub.test(content);

    // 512 to 1023 bytes -> Should have ONLY {{Super Stub}}
    if (page.length < SUPER_STUB_MAX) {
      if (hasSuper && !hasStub) continue;

      let newText = content.replace(/\{\{Stub\}\}[ \t]*\r?\n?/g, '');
      if (!exactSuperStub.test(newText)) {
        newText = `{{Super Stub}}\n${newText.replace(/^\s+/, '')}`;
      }

      if (newText !== content) {
        const summary = hasStub
          ? `Bot: Upgrading {{Stub}} to {{Super Stub}} (page size: ${page.length} bytes < 1024)`
          : `Bot: Adding {{Super Stub}} (page size: ${page.length} bytes < 1024)`;
        await editPage(page.pageid, page.title, newText, summary, csrfToken);
        await sleep(1500);
      }
    }

    // 1024 to 2047 bytes -> Should have ONLY {{Stub}}
    else {
      if (hasStub && !hasSuper) continue;

      let newText = content.replace(/\{\{Super Stub\}\}[ \t]*\r?\n?/g, '');
      if (!exactStub.test(newText)) {
        newText = `{{Stub}}\n${newText.replace(/^\s+/, '')}`;
      }

      if (newText !== content) {
        const summary = hasSuper
          ? `Bot: Changing {{Super Stub}} to {{Stub}} (page size: ${page.length} bytes >= 1024)`
          : `Bot: Adding {{Stub}} (page size: ${page.length} bytes < 2048)`;
        await editPage(page.pageid, page.title, newText, summary, csrfToken);
        await sleep(1500);
      }
    }
  }

  console.log('Done!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
