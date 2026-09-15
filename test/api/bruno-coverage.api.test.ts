import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { AppRuntime } from "@/http/app-env";
import { createApp } from "@/http/app";
import { makeAuth } from "@/infra/auth";
import { makeConsoleClient } from "@/infra/email";
import { fakeInfra, makeAppLayer } from "@/runtime";
import { TestDatabaseLive } from "../support/testcontainers";

// Only the path -> method keys matter here; decode rather than cast the document.
const Specification = z.object({ paths: z.record(z.string(), z.record(z.string(), z.unknown())) });

const BRUNO_V1_DIR = join(import.meta.dirname, "..", "..", "bruno", "v1");

// Bruno spells parameters `:id`; OpenAPI spells them `{id}`.
const toOpenApiPath = (path: string): string => path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, "{$1}");

/** `"<method> <path>"` for one .bru request file, or a loud marker naming the broken file. */
const requestKey = (content: string, file: string): string => {
  const method = content.match(/^(get|post|put|patch|delete|options|head) \{/m)?.[1];
  const url = content.match(/^ {2}url: (\S+)$/m)?.[1];
  if (method === undefined || url === undefined) return `unparseable .bru file: ${file}`;
  const path = url.replace("{{baseUrl}}", "").split("?")[0] ?? "";
  return `${method} ${toOpenApiPath(path)}`;
};

/**
 * bruno/v1 is the demoable mirror of the API: every documented operation must have
 * a committed Bruno request, and every request must match a documented operation.
 * Both lists are derived — the documented one from the generated spec, the other
 * from the real .bru files on disk — so adding an endpoint without running
 * `bun run bruno:scaffold` (or deleting/renaming a request file) turns this red,
 * and the failure names the exact operation. Same no-database trick as
 * openapi.api.test.ts: only the route registry and the generator are exercised.
 */
describe("Bruno collection coverage", () => {
  let runtime: AppRuntime;
  let auth: ReturnType<typeof makeAuth>;
  let documented: ReadonlyArray<string>;
  let collected: ReadonlyArray<string>;

  beforeAll(async () => {
    runtime = ManagedRuntime.make(makeAppLayer(TestDatabaseLive, fakeInfra));
    auth = makeAuth({
      databaseUrl: "postgres://user:pass@localhost:5432/db",
      secret: "test-secret-min-32-chars-0000000000",
      baseURL: "http://localhost:3000",
      defaultLocale: "en",
      emailClient: makeConsoleClient(),
    });
    const app = createApp(runtime, auth.instance);

    const response = await app.request("/openapi.json");
    expect(response.status).toBe(200);
    const specification = Specification.parse(await response.json());
    documented = Object.entries(specification.paths)
      .flatMap(([path, operations]) => Object.keys(operations).map((method) => `${method} ${path}`))
      .toSorted();

    const files = (await readdir(BRUNO_V1_DIR, { recursive: true })).filter((file) =>
      file.endsWith(".bru"),
    );
    collected = [
      ...new Set(
        await Promise.all(
          files.map(async (file) =>
            requestKey(await readFile(join(BRUNO_V1_DIR, file), "utf8"), file),
          ),
        ),
      ),
    ].toSorted();
  });

  afterAll(async () => {
    await runtime.dispose();
    await auth.close();
  });

  it("has a Bruno request for every documented operation (run `bun run bruno:scaffold`)", () => {
    expect(documented.filter((operation) => !collected.includes(operation))).toEqual([]);
  });

  it("has a documented operation for every Bruno request", () => {
    expect(collected.filter((operation) => !documented.includes(operation))).toEqual([]);
  });
});
