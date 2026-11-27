import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface MainAgentDefinition {
  name: string;
  description: string;
  model?: string;
  instructions: string;
  sourcePath: string;
}

type AgentFrontmatter = {
  name?: unknown;
  description?: unknown;
  model?: unknown;
};

const DEFAULT_AGENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "agents");

export interface ResolveMainAgentOptions {
  explicitPath?: string;
  agentsDir?: string;
}

/** Resolve the Main Agent Markdown path: explicit option -> env var -> main.local.md -> main.example.md. */
export function resolveMainAgentDefinitionPath(options: ResolveMainAgentOptions = {}): string {
  const { explicitPath, agentsDir = DEFAULT_AGENTS_DIR } = options;

  if (explicitPath !== undefined && explicitPath.trim().length > 0) {
    const resolved = resolve(explicitPath);
    if (!existsSync(resolved)) {
      throw new Error(`Main Agent definition file not found: ${resolved}`);
    }
    return resolved;
  }

  const envPath = process.env.ALFRED_MAIN_AGENT_PATH?.trim();
  if (envPath !== undefined && envPath.length > 0) {
    const resolved = resolve(envPath);
    if (!existsSync(resolved)) {
      throw new Error(
        `Main Agent definition file not found at ALFRED_MAIN_AGENT_PATH: ${resolved}`,
      );
    }
    return resolved;
  }

  const localPath = resolve(agentsDir, "main.local.md");
  if (existsSync(localPath)) {
    return localPath;
  }

  const examplePath = resolve(agentsDir, "main.example.md");
  if (existsSync(examplePath)) {
    return examplePath;
  }

  throw new Error(`Default Main Agent definition file not found: ${examplePath}`);
}

/** Load and validate a pi-subagents-style Markdown agent definition with YAML frontmatter. */
export function loadMainAgentDefinition(
  options: ResolveMainAgentOptions = {},
): MainAgentDefinition {
  const sourcePath = resolveMainAgentDefinitionPath(options);
  const content = readFileSync(sourcePath, "utf8");
  const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);

  const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  if (name.length === 0) {
    throw new Error(
      `Main Agent definition "${sourcePath}" is missing a non-empty frontmatter "name".`,
    );
  }

  const description =
    typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  if (description.length === 0) {
    throw new Error(
      `Main Agent definition "${sourcePath}" is missing a non-empty frontmatter "description".`,
    );
  }

  const model =
    typeof frontmatter.model === "string" && frontmatter.model.trim().length > 0
      ? frontmatter.model.trim()
      : undefined;

  return {
    name,
    description,
    ...(model !== undefined ? { model } : {}),
    instructions: body.trim(),
    sourcePath,
  };
}
