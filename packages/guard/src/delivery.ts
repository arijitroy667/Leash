export interface DeliveryInput {
  status: number;
  contentType: string | null;
  body: string;
  /** Fields required by the merchant's herd.schema. */
  schema: string[];
}

/** Payment is not delivery. A failed check is a bad report at once. */
export function deliveryCheck(i: DeliveryInput): { ok: true } | { ok: false; reason: string } {
  if (i.status < 200 || i.status >= 300) return { ok: false, reason: "http-status" };
  if (!i.body.trim()) return { ok: false, reason: "empty-body" };
  if (!i.schema.length) return { ok: true };
  if (!i.contentType?.includes("json")) return { ok: false, reason: "content-type" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(i.body);
  } catch {
    return { ok: false, reason: "malformed-json" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "schema-mismatch" };
  for (const field of i.schema) {
    const v = (parsed as Record<string, unknown>)[field];
    if (v === undefined || v === null) return { ok: false, reason: "schema-mismatch" };
  }
  return { ok: true };
}
