const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /sk-proj-[A-Za-z0-9_-]{12,}/g,
  /(api[_-]?key["']?\s*[:=]\s*["']?)[A-Za-z0-9_.-]{12,}/gi,
  /(private[_-]?key["']?\s*[:=]\s*["']?)[A-Za-z0-9_.-]{12,}/gi,
];

export function redact(value: unknown): string {
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, "$1[REDACTED]");
  }
  return text;
}

export const logger = {
  info(message: string): void {
    console.log(message);
  },
  warn(message: string): void {
    console.warn(`WARN: ${message}`);
  },
  error(message: string, error?: unknown): void {
    console.error(`ERROR: ${message}`);
    if (error) console.error(redact(error));
  },
};
