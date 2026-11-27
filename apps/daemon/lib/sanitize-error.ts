const MAX_ERROR_LENGTH = 500;

const SECRET_PATTERNS: readonly { pattern: RegExp; replacement: string }[] = [
  // Bearer / Basic auth headers
  { pattern: /(\bBearer\s+)[^\s"';,]+/gi, replacement: "$1[REDACTED]" },
  { pattern: /(\bBasic\s+)[^\s"';,]+/gi, replacement: "$1[REDACTED]" },
  // Key-value headers or fields (apiKey=..., x-api-key: ..., authorization: ...)
  {
    pattern:
      /(\b(?:authorization|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|secret)\s*[:=]\s*["']?)[^\s"',;}{]+/gi,
    replacement: "$1[REDACTED]",
  },
  // URL query string credentials
  {
    pattern: /([?&](?:api[-_]?key|key|token|access[-_]?token|secret)=)[^&\s"']+/gi,
    replacement: "$1[REDACTED]",
  },
  // Common provider API key formats (OpenAI, Anthropic, OpenRouter, Slack, GitHub, Google, AWS, JWT)
  {
    pattern: /\bsk-(?:ant-|proj-|svcacct-|or-|live-|test-)?[A-Za-z0-9_-]{8,}\b/g,
    replacement: "[REDACTED]",
  },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, replacement: "[REDACTED]" },
  { pattern: /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}\b/g, replacement: "[REDACTED]" },
  { pattern: /\bAIza[0-9A-Za-z_-]{16,}\b/g, replacement: "[REDACTED]" },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b/g, replacement: "[REDACTED]" },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{5,})?\b/g,
    replacement: "[REDACTED]",
  },
];

/** Scrub API keys, bearer tokens, and credential-like values before surfacing errors to clients. */
export function sanitizeErrorMessage(raw: string, fallback = "Model request failed."): string {
  let sanitized = raw.trim();
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  sanitized = sanitized.replace(/\s+/g, " ").trim();
  if (sanitized.length === 0) {
    return fallback;
  }
  if (sanitized.length > MAX_ERROR_LENGTH) {
    return `${sanitized.slice(0, MAX_ERROR_LENGTH - 3)}...`;
  }
  return sanitized;
}
