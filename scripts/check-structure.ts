#!/usr/bin/env bun
/**
 * Structural checks that oxlint cannot express, run in `bun run check` and CI:
 *
 *   1. File-naming patterns per area (see docs/conventions.md → "Naming & files"):
 *      - test/api/**            → `*.api.test.ts`
 *      - test/integration/**    → `*.integration.test.ts`
 *      - src/modules/<feature>/ → `<feature>.<role>[.test].ts`,
 *        role ∈ {routes, service, repo, policy, contract}
 *
 *   2. Import-boundary rules (see docs/architecture.md → "Layers"):
 *      dependencies point inward only — `domain ← modules ← http`, over shared
 *      `infra`; `lib` and `db` are leaves. Violations FAIL the build.
 */
import { Glob } from "bun";
import * as path from "node:path";

const ROLES = ["routes", "service", "repo", "policy", "contract"] as const;
const isRole = (s: string | undefined): boolean => (ROLES as readonly string[]).includes(s ?? "");

const errors: string[] = [];
const fail = (file: string, message: string): void => {
  errors.push(`  ${file}\n    → ${message}`);
};

const scan = (pattern: string): string[] =>
  [...new Glob(pattern).scanSync(".")].map((p) => p.replaceAll("\\", "/"));

const files = [...scan("src/**/*.ts"), ...scan("test/**/*.ts")].toSorted();

// ---------------------------------------------------------------------------
// 1. File-naming patterns
// ---------------------------------------------------------------------------
for (const file of files) {
  const parts = file.split("/");
  const name = parts.at(-1) ?? file;

  if (file.startsWith("test/api/") && !name.endsWith(".api.test.ts")) {
    fail(file, "API test files must be named `*.api.test.ts`");
  }

  if (file.startsWith("test/integration/") && !name.endsWith(".integration.test.ts")) {
    fail(file, "integration test files must be named `*.integration.test.ts`");
  }

  if (file.startsWith("src/modules/")) {
    const feature = parts[2];
    if (feature === undefined) continue;

    let core = name.slice(0, -".ts".length);
    if (core.endsWith(".test")) core = core.slice(0, -".test".length);
    const segments = core.split(".");

    if (segments[0] !== feature) {
      fail(file, `must start with its feature name "${feature}." (got "${segments[0] ?? ""}")`);
    } else if (!isRole(segments[1])) {
      fail(file, `role must be one of: ${ROLES.join(", ")} (e.g. ${feature}.service.ts)`);
    } else if (segments.length > 2) {
      fail(file, "too many name segments; expected `<feature>.<role>[.test].ts`");
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Import boundaries
// ---------------------------------------------------------------------------
type Area = "lib" | "domain" | "db" | "infra" | "modules" | "free";

const areaOf = (file: string): Area => {
  if (file.startsWith("src/lib/")) return "lib";
  if (file.startsWith("src/domain/")) return "domain";
  if (file.startsWith("src/db/")) return "db";
  if (file.startsWith("src/infra/")) return "infra";
  if (file.startsWith("src/modules/")) return "modules";
  return "free"; // src/http, top-level src files, test/, scripts/
};

/** Resolve an import specifier to a repo-relative path ("" for packages). */
const resolveInternal = (file: string, spec: string): string => {
  if (spec.startsWith("@/")) return `src/${spec.slice("@/".length)}`;
  if (!spec.startsWith(".")) return "";
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
};

const packageOf = (spec: string): string => {
  if (spec.startsWith(".") || spec.startsWith("@/") || spec.startsWith("node:")) return "";
  const segments = spec.split("/");
  return spec.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? spec);
};

const importsOf = async (file: string): Promise<ReadonlyArray<string>> => {
  const content = await Bun.file(file).text();
  const specs = new Set<string>();
  for (const match of content.matchAll(/(?:import|export)\s[^"']*?from\s*["']([^"']+)["']/g)) {
    if (match[1]) specs.add(match[1]);
  }
  for (const match of content.matchAll(/import\s*["']([^"']+)["']/g)) {
    if (match[1]) specs.add(match[1]);
  }
  return [...specs];
};

// Routes/contract files are the module's HTTP surface — they alone may touch
// the http helpers and hono packages.
const isHttpSurface = (file: string): boolean =>
  file.endsWith(".routes.ts") || file.endsWith(".contract.ts");

const boundedFiles = files.filter((file) => areaOf(file) !== "free");
const importsByFile = await Promise.all(boundedFiles.map(importsOf));

for (const [index, file] of boundedFiles.entries()) {
  const area = areaOf(file);

  for (const spec of importsByFile[index] ?? []) {
    const internal = resolveInternal(file, spec);
    const pkg = packageOf(spec);

    switch (area) {
      case "lib": {
        if (internal !== "" && !internal.startsWith("src/lib")) {
          fail(file, `lib/ must not import internal code (imports "${spec}")`);
        }
        const banned = ["effect", "hono", "drizzle-orm", "zod", "better-auth"];
        if (banned.includes(pkg) || pkg.startsWith("@effect/") || pkg.startsWith("@hono/")) {
          fail(file, `lib/ is framework-agnostic — must not import "${spec}"`);
        }
        break;
      }
      case "domain": {
        if (internal !== "" && !internal.startsWith("src/domain")) {
          fail(file, `domain/ may only import from domain/ (imports "${spec}")`);
        }
        if (pkg !== "" && pkg !== "effect") {
          fail(file, `domain/ is pure — only "effect" is allowed (imports "${spec}")`);
        }
        break;
      }
      case "db": {
        if (internal !== "" && !internal.startsWith("src/db")) {
          fail(file, `db/schema must not import app code (imports "${spec}")`);
        }
        if (pkg !== "" && pkg !== "drizzle-orm") {
          fail(file, `db/schema may only import "drizzle-orm" (imports "${spec}")`);
        }
        break;
      }
      case "infra": {
        if (internal.startsWith("src/modules") || internal.startsWith("src/http")) {
          fail(file, `infra/ must not depend on modules/ or http/ (imports "${spec}")`);
        }
        break;
      }
      case "modules": {
        if (internal.startsWith("src/http") && !isHttpSurface(file)) {
          fail(file, `only *.routes.ts / *.contract.ts may import http/ (imports "${spec}")`);
        }
        if ((pkg === "hono" || pkg.startsWith("@hono/")) && !isHttpSurface(file)) {
          fail(file, `only *.routes.ts / *.contract.ts may import hono (imports "${spec}")`);
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. No raw try/catch/finally anywhere (src, test, scripts) — errors ride
//    Effect's typed channel; cleanup uses .finally()/beforeAll-afterAll.
// ---------------------------------------------------------------------------
const noTryFiles = [...files, ...scan("scripts/**/*.ts")];
const noTryContents = await Promise.all(noTryFiles.map((file) => Bun.file(file).text()));
noTryFiles.forEach((file, index) => {
  if (/\btry\s*\{/.test(noTryContents[index] ?? "")) {
    fail(
      file,
      "raw try/catch is banned — use Effect.try / Effect.tryPromise (or .finally for cleanup)",
    );
  }
});

if (errors.length > 0) {
  console.error(`✗ Structure check failed (${errors.length} issue(s)):\n${errors.join("\n")}`);
  process.exit(1);
}
console.log(`✓ Structure check passed (${files.length} files: naming, imports, no try/catch).`);
