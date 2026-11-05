import { NextResponse } from "next/server";
import { validName } from "@herd/guard";
import { ACCOUNT_ID, knownMerchants, merchantRow, reader } from "../../../lib/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get("key")?.trim();
  const r = reader();
  const base = { now: Date.now() / 1000, profile: r.params.name, namespace: r.ns };
  if (key) {
    if (!validName(key) && !ACCOUNT_ID.test(key)) return NextResponse.json({ ...base, error: "Enter an ENS name or a Hedera account id" }, { status: 400 });
    return NextResponse.json({ ...base, merchants: [await merchantRow(key)] });
  }
  return NextResponse.json({ ...base, merchants: await Promise.all(knownMerchants().map((m) => merchantRow(m.name ?? m.payTo!, m.payTo))) });
}
