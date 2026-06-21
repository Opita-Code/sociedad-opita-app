// Performance budget — Polish R8.
//
// HARD-FAIL script that the operator (or CI) runs after `astro build`.
// Exits 1 if any budget is exceeded; exits 0 otherwise.
//
// Budgets are documented in DEPLOY-RUNBOOK.md "Frontend (static)":
//   - per-page HTML  <= 50 KB
//   - shared CSS     <= 30 KB (Tailwind 4 base + @theme + a11y styles.
//                              Was 20 KB in early R8 spec; R8 ships at
//                              ~23 KB with skip-to-content, reduced-motion,
//                              print styles, and focus-visible ring.
//                              30 KB leaves headroom for future additions.)
//   - total dist     <= 3 MB (R3 used 2.5 MB; R8 relaxes to 3 MB to
//                             accommodate the new sitemap and any
//                             future additions without re-tuning.)
//
// Pages are listed explicitly (no auto-discovery of all HTML) so a new
// route without a budget entry is caught explicitly here.
//
// Usage:   npx tsx web/scripts/check-perf-budget.ts
// From web/: npx tsx scripts/check-perf-budget.ts

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PER_PAGE_HTML_MAX = 50 * 1024; // 50 KB
const PER_PAGE_CSS_MAX = 30 * 1024; // 30 KB (Tailwind 4 base + @theme + R8 a11y)
const TOTAL_DIST_MAX = 3 * 1024 * 1024; // 3 MB

// Pages we expect to be present in dist/. Each maps to a route and the
// absolute path to its emitted HTML file.
const EXPECTED_PAGES: ReadonlyArray<{ route: string; indexPath: string }> = [
  { route: "/", indexPath: "index.html" },
  { route: "/replica", indexPath: "replica/index.html" },
  { route: "/taller", indexPath: "taller/index.html" },
  { route: "/ventana", indexPath: "ventana/index.html" },
  { route: "/puente", indexPath: "puente/index.html" },
  { route: "/pronto", indexPath: "pronto/index.html" },
];

function findDistRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "dist");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), "dist");
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = findDistRoot(SCRIPT_DIR);

function listFilesRecursive(dir: string): string[] {
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
      out.push(...listFilesRecursive(full));
    } else if (st.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function totalDistBytes(): number {
  return listFilesRecursive(DIST_ROOT).reduce((sum, f) => sum + statSync(f).size, 0);
}

function sharedCssBytes(): number {
  return listFilesRecursive(join(DIST_ROOT, "_astro"))
    .filter((f) => f.endsWith(".css"))
    .reduce((sum, f) => sum + statSync(f).size, 0);
}

function fmtKB(bytes: number): string {
  return (bytes / 1024).toFixed(2) + " KB";
}

interface Violation {
  page?: string;
  metric: string;
  value: number;
  limit: number;
}

function main(): void {
  if (!existsSync(DIST_ROOT)) {
    console.error(`❌ dist directory not found: ${DIST_ROOT}`);
    console.error("   run `pnpm build` first.");
    process.exit(1);
  }

  const violations: Violation[] = [];
  const cssSharedBytes = sharedCssBytes();

  console.log("📏 Performance budget — Polish R8");
  console.log(`   dist:          ${DIST_ROOT}`);
  console.log(`   page budget:   ${fmtKB(PER_PAGE_HTML_MAX)} HTML / page`);
  console.log(`   css budget:    ${fmtKB(PER_PAGE_CSS_MAX)} shared CSS`);
  console.log(`   total budget:  ${(TOTAL_DIST_MAX / 1024 / 1024).toFixed(1)} MB dist\n`);

  console.log("Per-page HTML:");
  for (const p of EXPECTED_PAGES) {
    const abs = join(DIST_ROOT, p.indexPath);
    if (!existsSync(abs)) {
      violations.push({
        page: p.route,
        metric: "page exists",
        value: 0,
        limit: 1,
      });
      console.log(`   ❌ ${p.route.padEnd(10)} MISSING`);
      continue;
    }
    const size = statSync(abs).size;
    const ok = size <= PER_PAGE_HTML_MAX;
    console.log(
      `   ${ok ? "✅" : "❌"} ${p.route.padEnd(10)} ${fmtKB(size).padStart(10)}  ${ok ? "" : `> ${fmtKB(PER_PAGE_HTML_MAX)}`}`
    );
    if (!ok) {
      violations.push({
        page: p.route,
        metric: "page HTML",
        value: size,
        limit: PER_PAGE_HTML_MAX,
      });
    }
  }

  console.log("\nShared CSS:");
  const cssOk = cssSharedBytes <= PER_PAGE_CSS_MAX;
  console.log(
    `   ${cssOk ? "✅" : "❌"} _astro/*.css  ${fmtKB(cssSharedBytes).padStart(10)}  ${cssOk ? "" : `> ${fmtKB(PER_PAGE_CSS_MAX)}`}`
  );
  if (!cssOk) {
    violations.push({
      metric: "shared CSS",
      value: cssSharedBytes,
      limit: PER_PAGE_CSS_MAX,
    });
  }

  const total = totalDistBytes();
  console.log("\nTotal dist:");
  const totalOk = total <= TOTAL_DIST_MAX;
  console.log(
    `   ${totalOk ? "✅" : "❌"} ${fmtKB(total).padStart(10)}  ${totalOk ? "" : `> ${fmtKB(TOTAL_DIST_MAX)}`}`
  );
  if (!totalOk) {
    violations.push({
      metric: "total dist",
      value: total,
      limit: TOTAL_DIST_MAX,
    });
  }

  console.log("");
  if (violations.length === 0) {
    console.log("✅ All performance budgets met.");
    process.exit(0);
  }

  console.error(`❌ ${violations.length} budget violation(s):`);
  for (const v of violations) {
    const where = v.page ? `${v.page}: ${v.metric}` : v.metric;
    console.error(`   - ${where}: ${fmtKB(v.value)} > ${fmtKB(v.limit)}`);
  }
  console.error("\nFix the bloat or update DEPLOY-RUNBOOK.md if the budget");
  console.error("should be revised. Do not silently raise the limit.");
  process.exit(1);
}

main();
