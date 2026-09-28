export function normalizeHostname(value: unknown): string {
  return String(value || "").trim().toLowerCase().replace(/\.+$/, "");
}

export function shortHostname(value: unknown): string {
  const normalized = normalizeHostname(value);
  const dot = normalized.indexOf(".");
  return dot > 0 ? normalized.slice(0, dot) : normalized;
}
