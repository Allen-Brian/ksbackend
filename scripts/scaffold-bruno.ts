#!/usr/bin/env bun
/**
 * Generate skeleton Bruno requests (bruno/v1/**) for every documented OpenAPI
 * operation that doesn't have one yet. Existing files are NEVER overwritten, so
 * hand-tuned bodies/scripts survive. Coverage (spec ⇄ bruno/v1) is enforced by
 * test/api/bruno-coverage.api.test.ts. Run via `bun run bruno:scaffold`.
 *
 * The spec is built in-process: `getOpenAPI31Document` only needs the registered
 * routes, so no server, database, or env is involved (same trick as
 * test/api/openapi.api.test.ts).
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { PgClient } from "@effect/sql-pg";
import { Layer, ManagedRuntime, Redacted } from "effect";
import { z } from "zod";
import { createApp } from "../src/http/app";
import { makeAuth } from "../src/infra/auth";
import { pgTypeConfig } from "../src/infra/db";
import { makeConsoleClient } from "../src/infra/email";
import { fakeInfra, makeAppLayer } from "../src/runtime";

const BRUNO_V1_DIR = join(import.meta.dir, "..", "bruno", "v1");

// ---------------------------------------------------------------------------
// Minimal decoders for the parts of the document the scaffolder reads.
// ---------------------------------------------------------------------------

const Parameter = z.looseObject({
  name: z.string(),
  in: z.string(),
  schema: z.unknown().optional(),
});

const Operation = z.looseObject({
  summary: z.string().optional(),
  parameters: z.array(Parameter).optional(),
  requestBody: z
    .looseObject({
      content: z.record(z.string(), z.looseObject({ schema: z.unknown() })).optional(),
    })
    .optional(),
});

const Specification = z.looseObject({
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
  components: z.looseObject({ schemas: z.record(z.string(), z.unknown()).optional() }).optional(),
});

type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | {
      readonly [key: string]: JsonValue;
    };

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/** The slice of a JSON-Schema node the placeholder generator understands. */
type RequestSchemaNode = {
  readonly $ref?: string;
  readonly type?: string | ReadonlyArray<string>;
  readonly format?: string;
  readonly enum?: ReadonlyArray<JsonValue>;
  readonly example?: JsonValue;
  readonly default?: JsonValue;
  readonly properties?: Readonly<Record<string, RequestSchemaNode>>;
  readonly items?: RequestSchemaNode;
  readonly anyOf?: ReadonlyArray<RequestSchemaNode>;
  readonly oneOf?: ReadonlyArray<RequestSchemaNode>;
  readonly allOf?: ReadonlyArray<RequestSchemaNode>;
};

const SchemaNode: z.ZodType<RequestSchemaNode> = z.lazy(() =>
  z.object({
    $ref: z.string().optional(),
    type: z.union([z.string(), z.array(z.string())]).optional(),
    format: z.string().optional(),
    enum: z.array(JsonValueSchema).optional(),
    example: JsonValueSchema.optional(),
    default: JsonValueSchema.optional(),
    properties: z.record(z.string(), SchemaNode).optional(),
    items: SchemaNode.optional(),
    anyOf: z.array(SchemaNode).optional(),
    oneOf: z.array(SchemaNode).optional(),
    allOf: z.array(SchemaNode).optional(),
  }),
);

// ---------------------------------------------------------------------------
// Placeholder body values derived from the request schema.
// ---------------------------------------------------------------------------

const placeholder = (
  node: RequestSchemaNode,
  resolveRef: (ref: string) => RequestSchemaNode | undefined,
  depth: number,
): JsonValue => {
  if (depth > 4) return null;
  if (node.$ref !== undefined) {
    const resolved = resolveRef(node.$ref);
    return resolved === undefined ? null : placeholder(resolved, resolveRef, depth + 1);
  }
  if (node.example !== undefined) return node.example;
  if (node.default !== undefined) return node.default;
  if (node.enum !== undefined && node.enum.length > 0) return node.enum[0] ?? null;
  const variant = node.anyOf?.[0] ?? node.oneOf?.[0] ?? node.allOf?.[0];
  if (variant !== undefined) return placeholder(variant, resolveRef, depth + 1);
  const type = Array.isArray(node.type) ? node.type[0] : node.type;
  if (type === "object" || (type === undefined && node.properties !== undefined)) {
    return Object.fromEntries(
      Object.entries(node.properties ?? {}).map(([key, value]) => [
        key,
        placeholder(value, resolveRef, depth + 1),
      ]),
    );
  }
  if (type === "array") {
    return node.items === undefined ? [] : [placeholder(node.items, resolveRef, depth + 1)];
  }
  if (type === "string") {
    if (node.format === "uuid") return "00000000-0000-4000-8000-000000000000";
    if (node.format === "date") return "2026-01-01";
    if (node.format === "date-time") return "2026-01-01T09:00:00Z";
    if (node.format === "email") return "user@example.com";
    return "text";
  }
  if (type === "integer" || type === "number") return 1;
  if (type === "boolean") return false;
  return null;
};

// ---------------------------------------------------------------------------
// .bru rendering.
// ---------------------------------------------------------------------------

const indent = (text: string): string =>
  text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

const renderRequest = (input: {
  readonly name: string;
  readonly seq: number;
  readonly method: string;
  readonly path: string;
  readonly pathParams: ReadonlyArray<string>;
  readonly queryParams: ReadonlyArray<string>;
  readonly jsonBody: JsonValue | undefined;
}): string => {
  const brunoPath = input.path.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, ":$1");
  const blocks = [
    `meta {\n  name: ${input.name}\n  type: http\n  seq: ${input.seq}\n}`,
    `${input.method} {\n  url: {{baseUrl}}${brunoPath}\n  body: ${
      input.jsonBody === undefined ? "none" : "json"
    }\n  auth: inherit\n}`,
  ];
  if (input.queryParams.length > 0) {
    // `~` marks the param disabled — visible in the GUI, not sent until enabled.
    const lines = input.queryParams.map((name) => `  ~${name}: `).join("\n");
    blocks.push(`params:query {\n${lines}\n}`);
  }
  if (input.pathParams.length > 0) {
    const lines = input.pathParams.map((name) => `  ${name}: `).join("\n");
    blocks.push(`params:path {\n${lines}\n}`);
  }
  if (input.jsonBody !== undefined) {
    blocks.push(`body:json {\n${indent(JSON.stringify(input.jsonBody, null, 2))}\n}`);
  }
  return `${blocks.join("\n\n")}\n`;
};

// ---------------------------------------------------------------------------
// Build the document and scaffold the missing files.
// ---------------------------------------------------------------------------

const databaseLayer = PgDrizzle.layer.pipe(
  Layer.provideMerge(
    // Never connected: the scaffolder only reads the route registry.
    PgClient.layer({
      url: Redacted.make("postgres://user:pass@localhost:5432/db"),
      types: pgTypeConfig,
    }),
  ),
);
const runtime = ManagedRuntime.make(makeAppLayer(databaseLayer, fakeInfra));
const auth = makeAuth({
  databaseUrl: "postgres://user:pass@localhost:5432/db",
  secret: "scaffold-secret-min-32-chars-0000000000",
  baseURL: "http://localhost:3000",
  defaultLocale: "en",
  emailClient: makeConsoleClient(),
});
const app = createApp(runtime, auth.instance);
const document = Specification.parse(
  app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: "KanaSanté API", version: "0.0.0" },
  }),
);
await auth.close();
await runtime.dispose();

// Parse every component schema once at the boundary; unmodellable ones resolve to nothing.
const componentSchemas = new Map<string, RequestSchemaNode>(
  Object.entries(document.components?.schemas ?? {}).flatMap(([name, raw]) => {
    const parsed = SchemaNode.safeParse(raw);
    return parsed.success ? [[name, parsed.data]] : [];
  }),
);
const resolveRef = (ref: string): RequestSchemaNode | undefined =>
  ref.startsWith("#/components/schemas/")
    ? componentSchemas.get(ref.slice("#/components/schemas/".length))
    : undefined;

const toFileName = (method: string, path: string): string =>
  `${method}-${path.replace("/v1/", "").replace(/[{}]/g, "").replaceAll("/", "-")}.bru`;

let created = 0;
let skipped = 0;

const operations = Object.entries(document.paths)
  .flatMap(([path, byMethod]) =>
    Object.entries(byMethod).map(([method, operation]) => ({ path, method, operation })),
  )
  .toSorted((a, b) =>
    a.path === b.path ? (a.method < b.method ? -1 : 1) : a.path < b.path ? -1 : 1,
  );

const byFolder = new Map<string, typeof operations>();
for (const entry of operations) {
  const folder = entry.path.split("/")[2] ?? "misc";
  byFolder.set(folder, [...(byFolder.get(folder) ?? []), entry]);
}

for (const [folder, entries] of byFolder) {
  const directory = join(BRUNO_V1_DIR, folder);
  await mkdir(directory, { recursive: true });
  const existing = new Set(await readdir(directory));
  let seq = existing.size;
  for (const { path, method, operation } of entries) {
    const fileName = toFileName(method, path);
    if (existing.has(fileName)) {
      skipped += 1;
      continue;
    }
    const decoded = Operation.parse(operation);
    const rawJsonSchema = decoded.requestBody?.content?.["application/json"]?.schema;
    const jsonSchema =
      rawJsonSchema === undefined ? undefined : SchemaNode.safeParse(rawJsonSchema);
    const pathParams = [...path.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((m) => m[1] ?? "");
    const queryParams = (decoded.parameters ?? [])
      .filter((parameter) => parameter.in === "query")
      .map((parameter) => parameter.name);
    seq += 1;
    const content = renderRequest({
      name: decoded.summary ?? `${method.toUpperCase()} ${path}`,
      seq,
      method,
      path,
      pathParams,
      queryParams,
      jsonBody:
        jsonSchema === undefined
          ? undefined
          : jsonSchema.success
            ? placeholder(jsonSchema.data, resolveRef, 0)
            : {},
    });
    await writeFile(join(directory, fileName), content);
    created += 1;
  }
}

console.log(`✓ bruno scaffold: ${created} request(s) created, ${skipped} already present`);
