import { NextResponse } from "next/server";
import { verifyMessage } from "viem";
import { approvalMessage } from "@leash/guard";
import { PUBLIC_MODE, reader } from "../../../../lib/server";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (PUBLIC_MODE) return NextResponse.json({ error: "owner console is not public" }, { status: 403 });
  const { id } = await params;
  const { action, signature } = (await req.json()) as { action: "approve" | "reject" | "reject-block"; signature?: `0x${string}` };
  const store = reader().store;
  store.expireApprovals(Date.now() / 1000);
  const a = store.getApproval(id);
  if (!a) return NextResponse.json({ error: "unknown approval" }, { status: 404 });
  if (a.status !== "pending") return NextResponse.json({ error: `approval is ${a.status}` }, { status: 409 });

  if (action === "reject" || action === "reject-block") {
    store.resolveApproval(id, "rejected");
    // Local to this machine: it never touches the shared registry.
    if (action === "reject-block") store.blockLocally(String(a.card.payTo), Date.now() / 1000);
    return NextResponse.json({ status: "rejected", blockedLocally: action === "reject-block" });
  }
  const owner = process.env.LEASH_OWNER_ADDRESS as `0x${string}` | undefined;
  if (!owner || !signature) return NextResponse.json({ error: "signature required" }, { status: 400 });
  const ok = await verifyMessage({ address: owner, message: approvalMessage(a), signature }).catch(() => false);
  if (!ok) return NextResponse.json({ error: "signature is not from the owner wallet" }, { status: 403 });
  store.resolveApproval(id, "approved", signature);
  return NextResponse.json({ status: "approved" });
}
