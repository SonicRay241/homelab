/** Canonical runtime object guard for untrusted JSON boundaries (request bodies, stored transcripts). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
