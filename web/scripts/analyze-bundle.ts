// Bundle analysis — Polish R3.
//
// Walks the Astro dist tree and reports per-route HTML size plus
// the total page weight (HTML + shared CSS/JS chunks the browser
// actually loads). The DEPLOY-RUNBOOK.md "each page < 50 KB"
// budget refers to the HTML payload; the shared-asset total is
// reported separately as the "total weight" metric.
//
// Run with:    npx tsx web/scripts/analyze-bundle.ts
// From web/:   npx tsx scripts/analyze-bundle.ts
//
// The script is intentionally dependency-free (only node:fs and
// node:path) so it can run on any CI runner without an npm ci
// step. It is not bundled into the production site — it is a
// build-time inspector that the operator runs after npm run build
// to validate the DEPLOY-RUNBOOK.md per-page budget.
//
// Exit code 0 regardless of budget violations. Budget drift is a
// soft failure (operator reviews) rather than a hard CI gate — see
// DEPLOY-RUNBOOK.md "Frontend (static)".

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PAGE_BUDGET_HTML_BYTES = 50 * 1024;
const TOTAL_DIST_BUDGET_BYTES = 2_500 * 1024;

// Resolve DIST_ROOT robustly — the operator can run this from the
// repo root (`tsx web/scripts/analyze-bundle.ts`) or from `web/`
// directly (`tsx scripts/analyze-bundle.ts`). Walk up from the
// script location and pick the first `web/dist` directory we find.
function findDistRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "web", "dist");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback — best-effort guess for cwd-driven workflows.
  return join(process.cwd(), "web", "dist");
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = findDistRoot(SCRIPT_DIR);

interface AssetSize {
  path: string;
  bytes: number;
}

interface SharedChunk {
  html: AssetSize[];
  css: AssetSize[];
  js: AssetSize[];
  totalBytes: number;
}

interface PageReport {
  /** Route as it appears in the URL: "/" for index.html, "/replica" for replica/index.html. */
  route: string;
  /** Just the page's own HTML payload (DEPLOY-RUNBOOK.md budget). */
  htmlBytes: number;
  /** Total bytes loaded when visiting this page (HTML + shared CSS/JS chunks). */
  totalBytes: number;
  /** Paths of shared chunks attached to this page (CSS + JS). */
  sharedChunks: AssetSize[];
}

interface BundleReport {
  pages: PageReport[];
  shared: SharedChunk;
  totals: {
    htmlBytes: number;
    cssBytes: number;
    jsBytes: number;
    transferBytes: number;
    allBytes: number;
    pageCount: number;
    fileCount: number;
  };
  budgets: {
    pageHtmlBudgetBytes: number;
    totalDistBudgetBytes: number;
    pagesOverHtmlBudget: string[];
    totalDistOverBudget: boolean;
  };
  generatedAt: string;
}

function listFilesRecursive(dir: string, exts?: readonly string[]): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...listFilesRecursive(full, exts));
    } else if (st.isFile() && (exts === undefined || exts.some((e) => entry.endsWith(e)))) {
      out.push(full);
    }
  }
  return out;
}

function sumAllBytes(): number {
  const all = listFilesRecursive(DIST_ROOT);
  let total = 0;
  for (const f of all) total += statSync(f).size;
  return total;
}

function routeFromIndexHtml(absPath: string): string {
  const rel = relative(DIST_ROOT, absPath).split(sep);
  if (rel.length === 1 && rel[0] === "index.html") return "/";
  if (rel.length >= 2 && rel[rel.length - 1] === "index.html") {
    return "/" + rel.slice(0, -1).join("/");
  }
  return "/" + rel.join("/");
}

function extOf(name: string): "html" | "css" | "js" | null {
  if (name.endsWith(".html")) return "html";
  if (name.endsWith(".css")) return "css";
  if (name.endsWith(".js")) return "js";
  return null;
}

function analyzeBundle(): BundleReport {
  const files = listFilesRecursive(DIST_ROOT, [".html", ".css", ".js"]);

  const shared: SharedChunk = { html: [], css: [], js: [], totalBytes: 0 };
  const pages: PageReport[] = [];

  for (const abs of files) {
    const st = statSync(abs);
    const rel = relative(DIST_ROOT, abs).split(sep);
    const name = rel[rel.length - 1]!;
    const ext = extOf(name);
    if (!ext) continue;

    const isPageHtml =
      ext === "html" &&
      // dist/index.html
      ((rel.length === 1 && name === "index.html") ||
        // dist/<route>/index.html
        (rel.length >= 2 && name === "index.html"));

    if (isPageHtml) {
      const route = routeFromIndexHtml(abs);
      pages.push({
        route,
        htmlBytes: st.size,
        totalBytes: st.size,
        sharedChunks: [],
      });
      continue;
    }

    // Anything else is a shared chunk (CSS/JS under _astro/, root-level
    // files, non-page HTML, etc.).
    const entry: AssetSize = { path: rel.join("/"), bytes: st.size };
    shared[ext].push(entry);
    shared.totalBytes += st.size;
  }

  // Attach shared chunks to every page to compute total page weight.
  for (const page of pages) {
    for (const css of shared.css) {
      page.sharedChunks.push(css);
      page.totalBytes += css.bytes;
    }
    for (const js of shared.js) {
      page.sharedChunks.push(js);
      page.totalBytes += js.bytes;
    }
  }

  pages.sort((a, b) => a.route.localeCompare(b.route));

  const totals = pages.reduce(
    (acc, p) => ({
      htmlBytes: acc.htmlBytes + p.htmlBytes,
      cssBytes: shared.css.reduce((s, a) => s + a.bytes, 0),
      jsBytes: shared.js.reduce((s, a) => s + a.bytes, 0),
      transferBytes: 0,
      allBytes: 0,
      pageCount: acc.pageCount + 1,
      fileCount: 0,
    }),
    {
      htmlBytes: 0,
      cssBytes: 0,
      jsBytes: 0,
      transferBytes: 0,
      allBytes: 0,
      pageCount: 0,
      fileCount: 0,
    },
  );
  // "transfer" = HTML/CSS/JS the browser pulls (DEPLOY-RUNBOOK.md
  // sub-budget). "all" = full dist including images, fonts, robots.txt,
  // og-image.jpg, etc. — the S3/CloudFront total.
  totals.transferBytes = totals.htmlBytes + shared.totalBytes;
  totals.allBytes = sumAllBytes();
  totals.fileCount = listFilesRecursive(DIST_ROOT).length;

  const pagesOverHtmlBudget = pages
    .filter((p) => p.htmlBytes > PAGE_BUDGET_HTML_BYTES)
    .map((p) => `${p.route} (${(p.htmlBytes / 1024).toFixed(1)} KB)`);

  return {
    pages,
    shared,
    totals,
    budgets: {
      pageHtmlBudgetBytes: PAGE_BUDGET_HTML_BYTES,
      totalDistBudgetBytes: TOTAL_DIST_BUDGET_BYTES,
      pagesOverHtmlBudget,
      totalDistOverBudget: totals.allBytes > TOTAL_DIST_BUDGET_BYTES,
    },
    generatedAt: new Date().toISOString(),
  };
}

function fmtKB(bytes: number): string {
  return (bytes / 1024).toFixed(2) + " KB";
}

function main(): void {
  const report = analyzeBundle();

  console.log("\n📦 Bundle analysis — Polish R3");
  console.log(`   dist:           ${DIST_ROOT}`);
  console.log(`   pages:          ${report.totals.pageCount}`);
  console.log(`   shared chunks:  ${report.shared.html.length + report.shared.css.length + report.shared.js.length}`);
  console.log(`   transfer total: ${fmtKB(report.totals.transferBytes)}  (HTML + CSS + JS)`);
  console.log(`   dist total:     ${fmtKB(report.totals.allBytes)}  (${report.totals.fileCount} files, all assets)`);

  console.log("\nPer-page HTML payload (DEPLOY-RUNBOOK.md budget = 50 KB):");
  console.table(
    report.pages.map((p) => ({
      route: p.route,
      html: fmtKB(p.htmlBytes),
      over_50kb: p.htmlBytes > PAGE_BUDGET_HTML_BYTES ? "⚠️" : "ok",
    })),
  );

  console.log("Total page weight (HTML + shared CSS/JS the browser loads):");
  console.table(
    report.pages.map((p) => ({
      route: p.route,
      html: fmtKB(p.htmlBytes),
      css: fmtKB(report.shared.css.reduce((s, a) => s + a.bytes, 0)),
      js: fmtKB(report.shared.js.reduce((s, a) => s + a.bytes, 0)),
      total: fmtKB(p.totalBytes),
    })),
  );

  console.log("Shared chunks:");
  const allShared: Array<{ kind: string; path: string; bytes: number }> = [];
  for (const c of report.shared.css)
    allShared.push({ kind: "css", path: c.path, bytes: c.bytes });
  for (const c of report.shared.js)
    allShared.push({ kind: "js", path: c.path, bytes: c.bytes });
  for (const c of report.shared.html)
    allShared.push({ kind: "html", path: c.path, bytes: c.bytes });
  allShared.sort((a, b) => b.bytes - a.bytes);
  console.table(allShared.slice(0, 10));

  console.log("Budget verdict:");
  if (report.budgets.pagesOverHtmlBudget.length === 0) {
    console.log(
      `   ✅ every page HTML ≤ ${PAGE_BUDGET_HTML_BYTES / 1024} KB (DEPLOY-RUNBOOK.md target)`,
    );
  } else {
    console.log(
      `   ⚠️  ${report.budgets.pagesOverHtmlBudget.length} page(s) over 50 KB HTML:`,
    );
    for (const line of report.budgets.pagesOverHtmlBudget) console.log(`      - ${line}`);
  }
  if (report.budgets.totalDistOverBudget) {
    console.log(
      `   ⚠️  total dist > ${TOTAL_DIST_BUDGET_BYTES / 1024} KB (${fmtKB(report.totals.allBytes)})`,
    );
  } else {
    console.log(
      `   ✅ total dist ≤ ${TOTAL_DIST_BUDGET_BYTES / 1024} KB (${fmtKB(report.totals.allBytes)})`,
    );
  }

  console.log("\nRecommendations:");
  const largestJs = [...report.shared.js].sort((a, b) => b.bytes - a.bytes)[0];
  if (largestJs && largestJs.bytes > 100 * 1024) {
    console.log(
      `   - ${largestJs.path} is ${fmtKB(largestJs.bytes)} (shared JS) — split React islands if it grows > 200 KB.`,
    );
  }
  const heaviestHtml = [...report.pages].sort(
    (a, b) => b.htmlBytes - a.htmlBytes,
  )[0];
  if (heaviestHtml && heaviestHtml.htmlBytes > 30 * 1024) {
    console.log(
      `   - ${heaviestHtml.route} is the heaviest HTML (${fmtKB(heaviestHtml.htmlBytes)}) — review for embedded media or large inline data.`,
    );
  }

  console.log("");
}

main();
