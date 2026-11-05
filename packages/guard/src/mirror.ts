import { PublicKey } from "@hiero-ledger/sdk";
import { safeError, type Store } from "./store.ts";

export interface TxFacts {
  found: boolean;
  success: boolean;
  payer?: string;
  payee?: string;
  token?: string;
  amountAtomic?: number;
  consensusTs?: number;
}

/** 0.0.5@1755500000.000000123 becomes 0.0.5-1755500000-000000123 */
export function toMirrorTxId(txId: string): string {
  if (!txId.includes("@")) return txId;
  const [acct, time] = txId.split("@") as [string, string];
  const [sec, nano = "0"] = time.split(".");
  return `${acct}-${sec}-${nano.padEnd(9, "0")}`;
}

/**
 * The account in a Hedera x402 transaction id is the facilitator, which pays fees.
 * The payer is the account with the negative transfer of the asset.
 */
export function parseTransfer(tx: any, token: string): Pick<TxFacts, "payer" | "payee" | "token" | "amountAtomic"> | null {
  const moves = ((tx?.token_transfers ?? []) as { token_id: string; account: string; amount: number }[]).filter((t) => t.token_id === token);
  const out = moves.filter((m) => m.amount < 0);
  const inn = moves.filter((m) => m.amount > 0);
  if (out.length !== 1 || inn.length !== 1) return null;
  return { payer: out[0]!.account, payee: inn[0]!.account, token, amountAtomic: inn[0]!.amount };
}

export class Mirror {
  constructor(private base: string, private token: string, private store: Store, private timeoutMs = 5000) {}

  private async get(path: string): Promise<any> {
    const now = Date.now() / 1000;
    try {
      const r = await fetch(`${this.base}/api/v1${path}`, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (r.status !== 404 && !r.ok) throw new Error(`mirror ${r.status}`);
      this.store.setHealth("mirror", true, now);
      return r.status === 404 ? null : r.json();
    } catch (e) {
      this.store.setHealth("mirror", false, now, safeError(e));
      throw e;
    }
  }

  /** Throws when Mirror Node is unavailable. `found: false` may just mean indexing lag. */
  async tx(txId: string): Promise<TxFacts> {
    const cached = this.store.txGet(txId);
    if (cached) return cached;
    const body = await this.get(`/transactions/${toMirrorTxId(txId)}`);
    const list: any[] = body?.transactions ?? [];
    if (!list.length) return { found: false, success: false };
    const ok = list.find((t) => t.result === "SUCCESS");
    if (!ok) {
      const facts = { found: true, success: false };
      this.store.txPut(txId, facts);
      return facts;
    }
    const facts: TxFacts = { found: true, success: true, consensusTs: Number(ok.consensus_timestamp), ...parseTransfer(ok, this.token) };
    this.store.txPut(txId, facts); // consensus results are final, so cached forever
    return facts;
  }

  /** Key, age and funding cluster of an account. */
  async account(id: string): Promise<{ keyType: string; key: string; createdTs: number; funder: string } | null> {
    const cached = this.store.accountGet(id);
    if (cached) return cached;
    const a = await this.get(`/accounts/${id}`);
    if (!a) return null;
    // An unbounded asc query can return an empty page, so start at the creation time.
    const first = await this.get(`/transactions?account.id=${id}&timestamp=gte:${a.created_timestamp}&order=asc&limit=1`);
    const funder = first?.transactions?.[0]?.transaction_id?.split("-")[0] ?? id;
    const v = { keyType: a.key?._type ?? "", key: a.key?.key ?? "", createdTs: Number(a.created_timestamp), funder };
    this.store.accountPut(id, v);
    return v;
  }

  async health(): Promise<boolean> {
    return !!(await this.get("/network/nodes?limit=1"));
  }
}

export function verifyHederaSignature(keyType: string, key: string, message: string, sigHex: string): boolean {
  try {
    let pk: PublicKey;
    if (keyType === "ECDSA_SECP256K1") pk = PublicKey.fromStringECDSA(key);
    else if (keyType === "ED25519") pk = PublicKey.fromStringED25519(key);
    else return false; // complex keys are ignored
    return pk.verify(Buffer.from(message), Buffer.from(sigHex, "hex"));
  } catch {
    return false;
  }
}
