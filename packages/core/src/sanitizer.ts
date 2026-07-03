import type { AgentEvent } from "./types.js";

type RedactionRule = {
  pattern: RegExp;
  replacement: string;
};

const SECRET_RULES: RedactionRule[] = [
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]"
  },
  {
    pattern: /https?:\/\/169\.254\.169\.254[^\s"'<>]*/gi,
    replacement: "[REDACTED_METADATA_URL]"
  },
  {
    pattern: /\/\/169\.254\.169\.254[^\s"'<>]*/gi,
    replacement: "//[REDACTED_METADATA_URL]"
  },
  {
    pattern: /(authorization\s*:\s*bearer\s+)[A-Za-z0-9._\-]+/gi,
    replacement: "$1[REDACTED]"
  },
  {
    pattern: /(cookie\s*:\s*)[^\r\n]+/gi,
    replacement: "$1[REDACTED]"
  },
  {
    pattern: /([A-Za-z0-9_]*password[A-Za-z0-9_]*\s*[:=]\s*)["']?[^"'\s]+/gi,
    replacement: "$1[REDACTED]"
  },
  {
    pattern: /([A-Za-z0-9_]*token[A-Za-z0-9_]*\s*[:=]\s*)["']?[^"'\s]+/gi,
    replacement: "$1[REDACTED]"
  },
  {
    pattern: /([A-Za-z0-9_]*secret[A-Za-z0-9_]*\s*[:=]\s*)["']?[^"'\s]+/gi,
    replacement: "$1[REDACTED]"
  },
  {
    pattern: /([A-Za-z0-9_]*credential[A-Za-z0-9_]*\s*[:=]\s*)["']?[^"'\s]+/gi,
    replacement: "$1[REDACTED]"
  },
  {
    pattern: /(api[_-]?key\s*[:=]\s*)["']?[^"'\s]+/gi,
    replacement: "$1[REDACTED]"
  },
  {
    pattern: /(\/\/[^:\s/]+:)[^@\s]+(@)/g,
    replacement: "$1[REDACTED]$2"
  },
  {
    pattern: /(_authToken=)[^\s]+/gi,
    replacement: "$1[REDACTED]"
  }
];

export class Sanitizer {
  sanitize(event: AgentEvent): AgentEvent {
    return redactUnknown(event) as AgentEvent;
  }
}

export function redactText(input: string): string {
  return SECRET_RULES.reduce((text, rule) => text.replace(rule.pattern, rule.replacement), input);
}

export function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (/token|secret|credential|cookie|authorization|api[_-]?key|private[_-]?key/i.test(key)) {
        result[key] = "[REDACTED]";
      } else if (key === "path" && typeof nested === "string" && nested.includes(".env")) {
        result[key] = "[REDACTED_PATH]";
      } else {
        result[key] = redactUnknown(nested);
      }
    }
    return result;
  }
  return value;
}
