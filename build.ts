import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RawPackage {
  name?: string;
  url?: string;
  description?: string;
  tags?: string[];
  method?: string;
}

/** Slim package shape — short keys to minimise inlined JSON payload */
interface Package {
  n: string;   // name
  u: string;   // url
  d: string;   // description
  t: string[]; // tags
  o: string;   // owner / author (extracted from repo URL)
  v: string;   // latest version tag (empty when unknown)
  a: string;   // last pushed/updated ISO date (empty when unknown)
}

interface RepoInfo { version: string; updatedAt: string }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract { owner, repo, platform } from a package URL. Returns null for unsupported platforms. */
function parseRepoUrl(url: string): { owner: string; repo: string; platform: "github" | "gitlab" | "codeberg" } | null {
  const clean = url.replace(/\.git$/, "");

  for (const [prefix, platform] of [
    ["https://github.com/", "github"],
    ["git@github.com:", "github"],
    ["https://gitlab.com/", "gitlab"],
    ["git@gitlab.com:", "gitlab"],
    ["https://codeberg.org/", "codeberg"],
    ["git@codeberg.org:", "codeberg"],
  ] as const) {
    if (clean.startsWith(prefix)) {
      const parts = clean.slice(prefix.length).split("/");
      if (parts.length >= 2 && parts[0] && parts[1]) {
        return { owner: parts[0], repo: parts[1], platform };
      }
    }
  }
  return null;
}

/** Sanitise a string into a valid GraphQL alias (letters, digits, underscores only). */
function toAlias(s: string): string {
  return "p_" + s.replace(/[^a-zA-Z0-9]/g, "_");
}

/** Fetch JSON from a URL with optional Bearer token. */
async function fetchJson(url: string, token?: string): Promise<unknown> {
  const headers: Record<string, string> = { "User-Agent": "nimpackages-build/1.0" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Phase 2a — GitHub bulk enrichment via GraphQL
// ---------------------------------------------------------------------------

/**
 * Query GitHub GraphQL for up to 100 repos in a single request.
 * Returns a map of alias → RepoInfo.
 */
async function fetchGithubBatch(
  batch: Array<{ alias: string; owner: string; repo: string }>,
  token: string,
): Promise<Map<string, RepoInfo>> {
  const fields = batch
    .map(
      ({ alias, owner, repo }) =>
        `${alias}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {
          pushedAt
          refs(refPrefix: "refs/tags/", last: 1, orderBy: {field: TAG_COMMIT_DATE, direction: ASC}) {
            nodes { name }
          }
        }`,
    )
    .join("\n");

  const query = `{ ${fields} }`;

  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "nimpackages-build/1.0",
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) throw new Error(`GitHub GraphQL HTTP ${res.status}`);

  const json = (await res.json()) as { data?: Record<string, unknown>; errors?: unknown[] };
  const result = new Map<string, RepoInfo>();

  if (!json.data) return result;

  for (const { alias } of batch) {
    const repo = json.data[alias] as {
      pushedAt?: string;
      refs?: { nodes?: Array<{ name: string }> };
    } | null;

    if (!repo) continue; // deleted / private / renamed

    const version = repo.refs?.nodes?.[0]?.name ?? "";
    const updatedAt = repo.pushedAt ?? "";
    result.set(alias, { version, updatedAt });
  }

  return result;
}

/** Enrich all GitHub packages using batched GraphQL queries. */
async function enrichGithub(
  packages: Array<Package & { owner: string; repo: string; alias: string }>,
  token: string,
): Promise<void> {
  const BATCH_SIZE = 100;
  const total = packages.length;
  let done = 0;

  for (let i = 0; i < packages.length; i += BATCH_SIZE) {
    const batch = packages.slice(i, i + BATCH_SIZE);
    console.log(`  GitHub batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(total / BATCH_SIZE)} (${batch.length} repos)…`);

    try {
      const infoMap = await fetchGithubBatch(batch, token);
      for (const pkg of batch) {
        const info = infoMap.get(pkg.alias);
        if (info) {
          pkg.v = info.version;
          pkg.a = info.updatedAt;
        }
      }
    } catch (err) {
      console.warn(`  Batch failed: ${err}`);
    }

    done += batch.length;
    // Brief pause between batches to stay polite, but GraphQL is efficient
    if (done < total) await new Promise((r) => setTimeout(r, 500));
  }
}

// ---------------------------------------------------------------------------
// Phase 2b — GitLab / Codeberg sequential REST enrichment
// ---------------------------------------------------------------------------

async function fetchRestRepoInfo(
  platform: "gitlab" | "codeberg",
  owner: string,
  repo: string,
  token?: string,
): Promise<RepoInfo> {
  try {
    let apiBase: string;
    if (platform === "gitlab") {
      const encoded = encodeURIComponent(`${owner}/${repo}`);
      apiBase = `https://gitlab.com/api/v4/projects/${encoded}`;
    } else {
      apiBase = `https://codeberg.org/api/v1/repos/${owner}/${repo}`;
    }

    const repoData = (await fetchJson(apiBase, token)) as Record<string, unknown>;
    const updatedAt =
      (repoData["last_activity_at"] as string | undefined) ??
      (repoData["updated_at"] as string | undefined) ??
      "";

    // Fetch latest tag
    let version = "";
    try {
      const tagsUrl =
        platform === "gitlab"
          ? `${apiBase}/repository/tags`
          : `${apiBase}/tags`;
      const tags = (await fetchJson(tagsUrl, token)) as Array<{ name?: string }>;
      version = tags[0]?.name ?? "";
    } catch {
      // Tags endpoint may fail; version stays empty
    }

    return { version, updatedAt };
  } catch {
    return { version: "", updatedAt: "" };
  }
}

// ---------------------------------------------------------------------------
// Phase 3 — HTML generation
// ---------------------------------------------------------------------------

function buildHtml(packages: Package[], css: string, builtAt: string, trackingScript?: string): string {
  // Last 10 entries in packages.json = newest additions to the Nim registry
  const newest = packages.slice(-10);

  // Minify the package array slightly — drop empty strings for optional fields to save bytes
  const slim = packages.map((p) => ({
    n: p.n,
    u: p.u,
    d: p.d,
    t: p.t,
    ...(p.o ? { o: p.o } : {}),
    ...(p.v ? { v: p.v } : {}),
    ...(p.a ? { a: p.a } : {}),
  }));

  const json = JSON.stringify(slim);
  const newestJson = JSON.stringify(newest.map((p) => p.n));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" href="/favicon.ico" type="image/x-icon">
  <title>Nim Packages</title>
  <link rel="canonical" href="https://nimpackages.com">
  <meta name="description" content="Discover and explore Nim libraries and packages">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://nimpackages.com">
  <meta property="og:title" content="Nim Packages">
  <meta property="og:description" content="Discover and explore Nim libraries and packages">
  <meta property="og:image" content="https://nimpackages.com/nimpackages.png">
  <meta name="twitter:card" content="summary_large_image">
  <style>${css}</style>
  ${trackingScript ?? ""}
</head>
<body>
  <div class="container">
    <div class="header">
      <a href="/">
        <div style="display:flex;justify-content:center;align-items:center;gap:20px">
          <div class="stat-number" style="position:relative">
            <span style="position:absolute;top:-8px;left:50%;transform:translateX(-50%);font-size:0.8em">👑</span>
            <span style="margin-top:8px;display:inline-block">📦</span>
          </div>
          <h1>Nim Packages</h1>
        </div>
      </a>
      <p>Discover and explore Nim libraries and packages</p>
      <p>Learn more about <a href="https://nim-lang.org" target="_blank">Nim</a> and <a href="https://nim-lang.github.io/nimble/" target="_blank">Nimble</a></p>
    </div>

    <div class="search-container">
      <form class="search-form" onsubmit="return false">
        <input
          type="text"
          id="q"
          class="search-input"
          placeholder="Search packages (e.g., 'http', 'http client', 'json parser')…"
          autocomplete="off"
          autofocus
        >
        <button type="button" class="search-button" onclick="doSearch()">Search</button>
      </form>

      <div class="stats">
        <div class="stat-card">
          <div class="stat-number" id="total-count">${packages.length}</div>
          <div class="stat-label">Total Packages</div>
        </div>
        <div class="stat-card">
          <div class="stat-number" style="font-size:1.1rem">${builtAt}</div>
          <div class="stat-label">Last Updated</div>
        </div>
        <div class="stat-card">
          <div class="stat-label" style="text-align:left">Install with Nimble</div>
          <div style="margin-top:10px;font-family:'Monaco','Menlo',monospace;font-size:0.8rem;color:#666;text-align:left">
            <div style="margin-bottom:5px">$ nimble install &lt;pkg&gt;</div>
            <div>$ nimble install --depsOnly</div>
          </div>
        </div>
      </div>
    </div>

    <div class="results-container">
      <div class="results-header">
        <h2 id="results-title">Newest Packages</h2>
        <span class="results-count" id="results-count"></span>
      </div>
      <div id="results"></div>
    </div>
  </div>

  <div class="footer">
    Copyright <a href="https://github.com/ThomasTJdev/nimpackages">Thomas T. Jarloev (TTJ)</a><br>
    Hosted by <a href="https://cxplanner.com">CxPlanner</a><br>
    We love <a href="https://nim-lang.org">Nim</a>
  </div>

  <script type="application/ld+json">
  {"@context":"https://schema.org","@type":"WebSite","name":"Nim Packages","url":"https://nimpackages.com/","potentialAction":{"@type":"SearchAction","target":"https://nimpackages.com/?q={search_term_string}","query-input":"required name=search_term_string"}}
  </script>

  <script>
  // All packages inlined at build time
  const P = ${json};
  // Names of the 10 newest packages (last entries in packages.json)
  const NEWEST_NAMES = new Set(${newestJson});
  const NEWEST = P.filter(p => NEWEST_NAMES.has(p.n)).reverse();

  function esc(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function card(p) {
    const tags = (p.t || []).map(t => \`<span class="tag">\${esc(t)}</span>\`).join('');
    const version = p.v ? \`<span>v\${esc(p.v)}</span>\` : '';
    const updated = p.a ? \`<span>Updated \${p.a.slice(0,10)}</span>\` : '';
    return \`<div class="package-card">
      <div class="package-header">
        <a class="package-name" href="\${esc(p.u)}" target="_blank" rel="noopener">\${esc(p.n)}</a>
        \${version ? \`<span class="package-score">\${version}</span>\` : ''}
      </div>
      <div class="package-description">\${esc(p.d || '')}</div>
      <div class="package-meta">\${updated}</div>
      <div class="package-tags">\${tags}</div>
    </div>\`;
  }

  function render(list, title, subtitle) {
    document.getElementById('results-title').textContent = title;
    document.getElementById('results-count').textContent = subtitle || '';
    document.getElementById('results').innerHTML = list.length
      ? list.map(card).join('')
      : '<p class="no-results"><span>No packages found. Try a different search term.</span></p>';
  }

  /**
   * Return a priority score for a single token against one package field group.
   * Higher score = more prominent match. Zero means no match.
   *   4 — name
   *   3 — description
   *   2 — tags
   *   1 — author / owner
   */
  function tokenScore(p, token) {
    if (p.n.toLowerCase().includes(token)) return 4;
    if (p.d && p.d.toLowerCase().includes(token)) return 3;
    if (p.t && p.t.some(t => t.toLowerCase().includes(token))) return 2;
    if (p.o && p.o.toLowerCase().includes(token)) return 1;
    return 0;
  }

  function doSearch() {
    const q = document.getElementById('q').value.trim().toLowerCase();
    if (!q) {
      render(NEWEST, 'Newest Packages', '');
      return;
    }

    // Split on whitespace so e.g. "http json" becomes two required tokens (AND logic)
    const tokens = q.split(/\\s+/).filter(Boolean);

    const scored = [];
    for (const p of P) {
      const scores = tokens.map(token => tokenScore(p, token));
      // Every token must match at least one field — if any token scores 0, skip the package
      if (scores.some(s => s === 0)) continue;
      // Sum scores: name matches (4) outrank description (3) > tags (2) > author (1),
      // and packages matching more tokens in high-priority fields naturally rank higher
      scored.push({ p, score: scores.reduce((a, b) => a + b, 0) });
    }

    scored.sort((a, b) => b.score - a.score);
    const results = scored.map(s => s.p);
    render(results, 'Search Results', results.length + ' package' + (results.length === 1 ? '' : 's') + ' found');
  }

  // Support ?q= in URL (e.g. from bookmarks or ld+json SearchAction)
  (function init() {
    const params = new URLSearchParams(location.search);
    const q = params.get('q') || '';
    if (q) {
      document.getElementById('q').value = q;
      doSearch();
    } else {
      render(NEWEST, 'Newest Packages', '');
    }
  })();

  document.getElementById('q').addEventListener('input', doSearch);
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Nimpackages build ===");
  const githubToken = process.env.GITHUB_TOKEN ?? "";
  if (!githubToken) {
    console.warn("⚠  GITHUB_TOKEN not set — GitHub enrichment will be skipped");
  }

  // --- Phase 1: fetch packages.json ---
  console.log("\n[1/3] Fetching packages.json…");
  let raw: RawPackage[];

  const localCache = "packages.json";
  if (process.env.NODE_ENV !== "production" && fs.existsSync(localCache)) {
    console.log("  Using local cache (set NODE_ENV=production to force download)");
    raw = JSON.parse(fs.readFileSync(localCache, "utf8"));
  } else {
    const data = await fetchJson(
      "https://raw.githubusercontent.com/nim-lang/packages/refs/heads/master/packages.json",
    ) as RawPackage[];
    raw = data;
    // Cache locally for faster dev iterations
    if (process.env.NODE_ENV !== "production") {
      fs.writeFileSync(localCache, JSON.stringify(raw));
    }
  }

  console.log(`  ${raw.length} packages loaded`);

  // Build initial slim package array — preserve original order
  const packages: Package[] = raw
    .filter((r) => r.name && r.url)
    .map((r) => ({
      n: r.name!,
      u: r.url!,
      d: r.description ?? "",
      t: r.tags ?? [],
      // Extract owner from the repo URL so it is searchable (e.g. "ThomasTJdev")
      o: parseRepoUrl(r.url!)?.owner ?? "",
      v: "",
      a: "",
    }));

  // --- Phase 2: enrich with repo info ---
  // Set SKIP_ENRICHMENT=1 (via `npm run build:dev`) to skip all API calls during local development
  const skipEnrichment = process.env.SKIP_ENRICHMENT === "1";
  console.log("\n[2/3] Enriching with repository info…");
  if (skipEnrichment) {
    console.log("  Skipping enrichment (SKIP_ENRICHMENT=1)");
  }

  // Separate by platform
  const githubPkgs: Array<Package & { owner: string; repo: string; alias: string }> = [];
  const restPkgs: Array<{ pkg: Package; owner: string; repo: string; platform: "gitlab" | "codeberg" }> = [];

  if (!skipEnrichment) {
    for (const pkg of packages) {
      const info = parseRepoUrl(pkg.u);
      if (!info) continue;
      if (info.platform === "github" && githubToken) {
        githubPkgs.push({ ...pkg, owner: info.owner, repo: info.repo, alias: toAlias(`${info.owner}_${info.repo}`) });
      } else if (info.platform === "gitlab" || info.platform === "codeberg") {
        restPkgs.push({ pkg, owner: info.owner, repo: info.repo, platform: info.platform });
      }
    }
  }

  // GitHub: batched GraphQL
  if (githubPkgs.length > 0 && githubToken) {
    console.log(`  Enriching ${githubPkgs.length} GitHub packages via GraphQL…`);
    await enrichGithub(githubPkgs, githubToken);
    // Write enriched data back to the packages array by reference
    for (const ep of githubPkgs) {
      const orig = packages.find((p) => p.n === ep.n);
      if (orig) { orig.v = ep.v; orig.a = ep.a; }
    }
  }

  // GitLab / Codeberg: sequential REST
  if (restPkgs.length > 0) {
    console.log(`  Enriching ${restPkgs.length} GitLab/Codeberg packages via REST…`);
    for (let i = 0; i < restPkgs.length; i++) {
      const { pkg, owner, repo, platform } = restPkgs[i];
      process.stdout.write(`\r  ${i + 1}/${restPkgs.length}`);
      const token = platform === "gitlab" ? process.env.GITLAB_TOKEN : process.env.CODEBERG_TOKEN;
      const info = await fetchRestRepoInfo(platform, owner, repo, token);
      pkg.v = info.version;
      pkg.a = info.updatedAt;
      await new Promise((r) => setTimeout(r, 300)); // polite delay
    }
    process.stdout.write("\n");
  }

  // --- Phase 3: generate HTML ---
  console.log("\n[3/3] Generating dist/index.html…");

  const css = fs.readFileSync(path.join(process.cwd(), "style.css"), "utf8")
    // Minify CSS slightly: collapse whitespace
    .replace(/\s*([{}:;,>~+])\s*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  const builtAt = new Date().toISOString().slice(0, 10);

  // Optional analytics — set both env vars to enable
  const trackingUrl = process.env.TRACKING_SCRIPT_URL;
  const trackingId  = process.env.TRACKING_WEBSITE_ID;
  const trackingScript = trackingUrl && trackingId
    ? `<script defer src="${trackingUrl}" data-website-id="${trackingId}"></script>`
    : undefined;
  if (trackingScript) console.log("  Analytics script injected");

  const html = buildHtml(packages, css, builtAt, trackingScript);

  fs.mkdirSync("dist", { recursive: true });
  fs.writeFileSync("dist/index.html", html, "utf8");

  // Copy all static files (favicon, images, etc.) from files/ into dist/
  const staticDir = path.join(process.cwd(), "files");
  if (fs.existsSync(staticDir)) {
    for (const file of fs.readdirSync(staticDir)) {
      fs.copyFileSync(path.join(staticDir, file), path.join("dist", file));
    }
    console.log(`  Copied static files from files/`);
  }

  const sizeKb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(1);
  console.log(`  dist/index.html written (${sizeKb} KB)`);
  console.log("\n✓ Build complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
