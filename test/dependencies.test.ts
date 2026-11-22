import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Requirement 0001 (RN14): the server stands on its own. It imports
 * nothing of another product, no provider SDK, no agent
 * framework and no MCP SDK: the model adapters and the MCP client speak
 * `fetch`.
 */
const root = join(import.meta.dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sources(join(dir, entry.name)) : /\.(tsx?|mjs)$/.test(entry.name) ? [join(dir, entry.name)] : [],
  );
}

const imports = (file: string) => [...readFileSync(file, "utf8").matchAll(/(?:from\s+|import\(\s*)["']([^"']+)["']/g)].map((match) => match[1]!);

const PROVIDER =
  /^(@anthropic-ai\/|openai$|@openai\/|@aws-sdk\/|aws-sdk$|aws4$|@smithy\/|@azure\/|google-auth-library$|@google-cloud\/|@google\/genai$|@google-ai\/|ai$|@ai-sdk\/|langchain$|@langchain\/|llamaindex$|@llamaindex\/|@mastra\/|portkey-ai$|litellm|@openrouter\/|@modelcontextprotocol\/)/;

describe("the server's dependencies (RN14)", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, Record<string, string>>;
  const packages = [...Object.keys(manifest["dependencies"] ?? {}), ...Object.keys(manifest["devDependencies"] ?? {})];

  it("negative: no @fairlead/* package, in the manifest or in any import", () => {
    for (const name of packages) expect(name).not.toMatch(/^@fairlead\//);
    for (const dir of ["src", "test"]) {
      const files = sources(join(root, dir));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) for (const name of imports(file)) expect(name, relative(root, file)).not.toMatch(/^@fairlead\//);
    }
  });

  it("negative: no provider SDK, agent framework, provider gateway or MCP SDK", () => {
    for (const name of packages) expect(name).not.toMatch(PROVIDER);
  });

  it("the code outside the server's entry imports Node's built-ins and its own files only", () => {
    for (const file of sources(join(root, "src"))) {
      if (file.includes("/src/server/")) continue;
      for (const name of imports(file)) expect(name, relative(root, file)).toMatch(/^(node:|\.\.?\/)/);
    }
  });
});
