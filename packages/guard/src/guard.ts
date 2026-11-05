import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { AccountId, Client, PrivateKey, TopicMessageSubmitTransaction, Transaction } from "@hiero-ledger/sdk";
import { createPublicClient, http, verifyMessage, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { normalize } from "viem/ens";
import {
  DEFAULT_LIMITS, PROFILES, challengeHash, decide, normalizeUrl, replay,
  type Challenge, type Decision, type Limits, type PolicyParams, type StandingView,
} from "@herd/core";
import { Arkiv, type RebuttalRow } from "./arkiv.ts";
import { deliveryCheck } from "./delivery.ts";
import { Ens, validName, type DeclarationResult } from "./ens.ts";
import { PUBLIC_FUNDERS, digest, holdsRebuttalRole, readVerifiedEvidence, reportMessage, verifyRebuttalSignature } from "./evidence.ts";
import { Mirror } from "./mirror.ts";
import { Store, type Approval } from "./store.ts";

const nowSec = () => Date.now() / 1000;
const SAFE_MODE_DEPS = ["ens", "arkiv", "mirror"];
const MAX_REPORT_ATTEMPTS = 40;

export const approvalMessage = (a: { id: string; challengeHash: string; expiresAt: number }) =>
  `herd.approval:v1|${a.id}|${a.challengeHash}|${a.expiresAt}`;

export class HerdDenied extends Error {
  constructor(readonly decision: Decision) {
    super(`herd:DENY:${decision.reasons.join(",")}`);
  }
}
export class HerdEscalated extends Error {
  constructor(readonly decision: Decision, readonly approvalId: string) {
    super(`herd:ESCALATE:${decision.reasons.join(",")}`);
  }
}

export interface GuardConfig {
  agent: string;
  hederaAccount: string;
  hederaKey: string;
  ownerAddress: `0x${string}`;
  arkivAccessKey: string;
  arkivRpcUrl?: string;
  namespace: string;
  dbPath?: string;
  policyProfile?: keyof typeof PROFILES;
  mirrorUrl?: string;
  sepoliaRpcUrl?: string;
  usdc?: string;
  hcsTopicId?: string;
  limits?: Partial<Limits>;
  proberAddresses?: string[];
  publicFunders?: string[];
  mode?: "enforce" | "observe";
  autoReport?: boolean;
  awaitApprovalMs?: number;
}

interface RequestCtx {
  url: string;
  origin: string;
  receivedAt: number;
  idempotent: boolean;
  decision?: Decision;
  approvalId?: string;
  paid?: { txId: string; payee: string; ens: string; amountMicroUsd: number; schema: string[]; hash: string; decisionId: string };
}

export function createHerdGuard(cfg: GuardConfig) {
  const params: PolicyParams = PROFILES[cfg.policyProfile ?? "production"];
  const usdc = cfg.usdc ?? "0.0.429274";
  const limits: Limits = { ...DEFAULT_LIMITS, allowedAssets: [usdc], ...cfg.limits };
  const store = new Store(cfg.dbPath ?? ".herd/herd.sqlite");
  const mirror = new Mirror(cfg.mirrorUrl ?? "https://testnet.mirrornode.hedera.com", usdc, store);
  const ens = new Ens(cfg.sepoliaRpcUrl, store, params);
  const arkiv = new Arkiv(cfg.arkivAccessKey, cfg.namespace, cfg.arkivRpcUrl);
  const sepoliaClient = createPublicClient({ chain: sepolia, transport: http(cfg.sepoliaRpcUrl) }) as PublicClient;
  const session = randomUUID();
  const als = new AsyncLocalStorage<RequestCtx>();
  const hederaKey = PrivateKey.fromStringECDSA(cfg.hederaKey);
  const evmKey = (cfg.hederaKey.startsWith("0x") ? cfg.hederaKey : `0x${cfg.hederaKey}`) as `0x${string}`;
  const arkivOwner = privateKeyToAccount(evmKey).address;
  const proberOwners = new Set((cfg.proberAddresses ?? []).map((a) => a.toLowerCase()));
  const publicFunders = new Set([...PUBLIC_FUNDERS, ...(cfg.publicFunders ?? [])]);
  let hcsClient: Client | undefined;

  const safeMode = () => store.healthAll().filter((h) => SAFE_MODE_DEPS.includes(h.dep) && !h.ok).length >= 2;

  async function verifyRebuttal(r: RebuttalRow): Promise<boolean> {
    if (!(await verifyRebuttalSignature(cfg.namespace, r))) return false;
    const resolver = await sepoliaClient.getEnsResolver({ name: normalize(r.ens) });
    return holdsRebuttalRole(sepoliaClient, resolver, r.signer as `0x${string}`);
  }

  /** Fresh read, else the staleness rules in core decide what the cached view is worth. */
  async function standing(payee: string, now: number): Promise<{ status: "fresh" | "stale" | "none"; view?: StandingView; unverified: number }> {
    const cached = store.standingGet(payee);
    // A cached block past its end must be re-read: core derives what comes next, not the cache.
    const expired = cached?.blockEnd != null && cached.blockEnd <= now;
    if (cached && !expired && now - cached.computedAt <= params.standingFreshSec) {
      return { status: "fresh", view: cached, unverified: 0 };
    }
    try {
      const v = await readVerifiedEvidence({ arkiv, mirror, ns: cfg.namespace, payee, usdc, publicFunders, proberOwners, verifyRebuttal });
      const view = replay(v.evidence, now, params);
      store.standingPut(payee, view);
      store.setHealth("arkiv", true, now);
      return { status: "fresh", view, unverified: v.unverifiedBadClusters };
    } catch (e) {
      store.setHealth("arkiv", false, now, String(e).slice(0, 120));
      return cached ? { status: "stale", view: cached, unverified: 0 } : { status: "none", unverified: 0 };
    }
  }
  function toChallenge(req: any, resourceUrl: string): Challenge {
    return {
      scheme: req.scheme, network: req.network, asset: req.asset, amountUsd: Number(req.amount) / 1e6, payTo: req.payTo,
      resourceUrl, maxTimeoutSeconds: req.maxTimeoutSeconds, extra: req.extra,
    };
  }

  async function evaluate(req: any, ctx: RequestCtx | undefined): Promise<{ decision: Decision; declaration: DeclarationResult }> {
    const now = nowSec();
    store.expireApprovals(now);
    const challenge = toChallenge(req, ctx?.url ?? `unknown://${req.payTo}`);
    const claim = validName(req.extra?.herdEns) ? (req.extra.herdEns as string) : null;
    const [declaration, reg] = await Promise.all([ens.resolve(claim, now), standing(req.payTo, now)]);
    const merchant = claim && declaration.value ? claim : req.payTo;
    const decision = decide({
      now, challenge, claim, declaration,
      realOrigin: ctx?.origin ?? null,
      registry: { status: reg.status, view: reg.view },
      ledger: store.ledger(cfg.agent, session, merchant, normalizeUrl(challenge.resourceUrl), now),
      challengeState: { receivedAt: ctx?.receivedAt ?? now, paidAt: store.paidAt(cfg.agent, challengeHash(challenge)) },
      idempotent: ctx?.idempotent,
      escalationsLastHour: store.countNewEscalations(cfg.agent, now),
      unverifiedBadClusters: reg.unverified,
      safeMode: safeMode(),
      limits, params,
    });
    return { decision, declaration };
  }

  function pendingApproval(d: Decision, req: any): string {
    const open = store.listApprovals("pending", 200).find((a) => a.agent === cfg.agent && a.challengeHash === d.challengeHash);
    if (open) return open.id;
    const id = randomUUID();
    const remaining = Math.max(0, d.limits.cap24h - d.limits.capUsed24h);
    store.createApproval({
      id, agent: cfg.agent, decisionId: d.id, challengeHash: d.challengeHash, createdAt: d.at, expiresAt: d.at + limits.replayWindowSec,
      // Structured fields only. Raw merchant text is never rendered.
      card: {
        merchant: d.merchantKey, payTo: String(req.payTo), standing: d.standing, amountUsd: d.amountUsd,
        score: Math.round(d.score * 10) / 10, reasons: d.reasons.slice(0, 3), remainingCap24h: remaining,
      },
    });
    return id;
  }

  /** Verified against the owner's key at use, so a tampered database row cannot approve. */
  async function useApproval(hash: string, now: number): Promise<Approval | undefined> {
    const candidate = store.listApprovals("approved", 200).find((a) => a.agent === cfg.agent && a.challengeHash === hash && a.expiresAt >= now);
    if (!candidate?.signature) return undefined;
    const ok = await verifyMessage({ address: cfg.ownerAddress, message: approvalMessage(candidate), signature: candidate.signature as `0x${string}` }).catch(() => false);
    return ok ? store.consumeApproval(cfg.agent, hash, now) : undefined;
  }

  const audit = (type: string, dedupe: string, body: Record<string, unknown>) => {
    if (cfg.hcsTopicId) store.enqueue("hcs", `hcs:${type}:${dedupe}`, { type, ...body });
  };
  const auditDecision = (d: Decision) =>
    audit("decision", d.id, { id: d.id, agent: cfg.agent, verdict: d.verdict, reasons: d.reasons, merchant: d.merchantKey, standing: d.standing, score: Math.round(d.score * 10) / 10, amountUsd: d.amountUsd, challengeHash: d.challengeHash, at: d.at });

  function attach(client: { onBeforePaymentCreation: Function; onAfterPaymentCreation: Function }) {
    client.onBeforePaymentCreation(async (hook: any) => {
      const ctx = als.getStore();
      const req = hook.selectedRequirements;
      const { decision, declaration } = await evaluate(req, ctx);
      store.saveDecision(cfg.agent, decision);
      auditDecision(decision);
      if (ctx) ctx.decision = decision;
      console.error(JSON.stringify({ herd: "decision", agent: cfg.agent, id: decision.id, verdict: decision.verdict, reasons: decision.reasons, standing: decision.standing, score: decision.score, merchant: decision.merchantKey }));
      (hook as any).__declaration = declaration;
      if (ctx) (ctx as any).schema = declaration.value?.schema ?? [];
      if (cfg.mode === "observe" || decision.verdict === "ALLOW") return;
      const reason = `herd:${decision.verdict}:${decision.reasons.join(",")}`;
      if (decision.verdict === "DENY") return { abort: true, reason };
      if (await useApproval(decision.challengeHash, decision.at)) return;
      const approvalId = pendingApproval(decision, req);
      if (ctx) ctx.approvalId = approvalId;
      return { abort: true, reason };
    });

    client.onAfterPaymentCreation(async (hook: any) => {
      const ctx = als.getStore();
      const req = hook.selectedRequirements;
      const d = ctx?.decision;
      if (!ctx || !d) return;
      const tx = Transaction.fromBytes(Buffer.from(String(hook.paymentPayload.payload.transaction), "base64"));
      const at = nowSec();
      store.markPaid(cfg.agent, d.challengeHash, at);
      store.recordSpend({ agent: cfg.agent, session, merchant: d.merchantKey, resource: normalizeUrl(ctx.url), standing: d.standing, amount: d.amountUsd, at });
      ctx.paid = {
        txId: tx.transactionId!.toString(), payee: req.payTo, ens: validName(req.extra?.herdEns) ? req.extra.herdEns : "",
        amountMicroUsd: Number(req.amount), schema: (ctx as any).schema ?? [], hash: d.challengeHash, decisionId: d.id,
      };
    });
  }

  async function guardedFetchImpl(inner: typeof fetch, input: Parameters<typeof fetch>[0], init?: RequestInit & { herdIdempotent?: boolean }) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const ctx: RequestCtx = { url, origin: new URL(url).origin, receivedAt: nowSec(), idempotent: !!init?.herdIdempotent };
    let res: Response;
    try {
      res = await als.run(ctx, () => inner(input, init));
    } catch (e) {
      const d = ctx.decision;
      if (d?.verdict === "DENY") throw new HerdDenied(d);
      if (d?.verdict === "ESCALATE" && ctx.approvalId) throw new HerdEscalated(d, ctx.approvalId);
      if (ctx.paid) queueReport(ctx, "bad", "transport-failure");
      throw e;
    }
    if (ctx.paid) {
      const body = await res.clone().text();
      const check = deliveryCheck({ status: res.status, contentType: res.headers.get("content-type"), body, schema: ctx.paid.schema });
      queueReport(ctx, check.ok ? "good" : "bad", check.ok ? "delivered" : check.reason);
      (res as any).herd = { decisionId: ctx.paid.decisionId, txId: ctx.paid.txId, delivered: check.ok };
    }
    return res;
  }

  function queueReport(ctx: RequestCtx, outcome: "good" | "bad", reason: string) {
    if (cfg.autoReport === false || !ctx.paid) return;
    const p = ctx.paid;
    store.enqueue("report", `${cfg.agent}:${p.txId}`, {
      txId: p.txId, payee: p.payee, ens: p.ens, domain: ctx.origin, outcome, reason, amountMicroUsd: p.amountMicroUsd,
      account: cfg.hederaAccount, agent: cfg.agent,
    });
  }

  async function deliverOutboxItem(item: { kind: string; payload: any; attempts: number }): Promise<"done" | "retry"> {
    const p = item.payload;
    if (item.kind === "hcs") {
      if (!cfg.hcsTopicId) return "done";
      hcsClient ??= Client.forTestnet().setOperator(AccountId.fromString(cfg.hederaAccount), hederaKey);
      await new TopicMessageSubmitTransaction().setTopicId(cfg.hcsTopicId).setMessage(JSON.stringify(p)).execute(hcsClient);
      store.setHealth("hcs", true, nowSec());
      return "done";
    }
    if (item.kind === "report") {
      const facts = await mirror.tx(p.txId);
      if (!facts.found) return item.attempts >= MAX_REPORT_ATTEMPTS ? "done" : "retry"; // settlement never landed
      if (!facts.success) return "done";
      const message = reportMessage({ ns: cfg.namespace, txId: p.txId, payee: p.payee, outcome: p.outcome, amountMicroUsd: p.amountMicroUsd, owner: arkivOwner });
      const payerSig = Buffer.from(hederaKey.sign(Buffer.from(message))).toString("hex");
      const { entityKey } = await arkiv.writeReport(evmKey, {
        payee: p.payee, ens: p.ens, domain: p.domain, outcome: p.outcome, txId: p.txId, payer: facts.payer ?? cfg.hederaAccount, payerSig,
        consensusTs: facts.consensusTs!, amountMicroUsd: p.amountMicroUsd, reason: p.reason,
      }, params.reportTtlSec);
      audit("report", p.txId, { txId: p.txId, payee: p.payee, outcome: p.outcome, reason: p.reason, entityKey });
      store.db.prepare("DELETE FROM cache_standing WHERE payee=?").run(p.payee);
      console.error(JSON.stringify({ herd: "report", agent: cfg.agent, outcome: p.outcome, reason: p.reason, txId: p.txId, entityKey }));
      return "done";
    }
    return "done";
  }

  async function flush() {
    const now = nowSec();
    for (const item of store.dueOutbox(now, 25)) {
      // A report is signed by its own payer, so each guard delivers only its own.
      if (item.kind === "report" && item.payload.agent !== cfg.agent) continue;
      if (!store.claimOutbox(item.id, now)) continue;
      try {
        if ((await deliverOutboxItem(item)) === "done") store.outboxDone(item.id);
        else store.outboxRetry(item.id, item.attempts, now);
      } catch (e) {
        store.setHealth(item.kind === "hcs" ? "hcs" : "arkiv", false, now, String(e).slice(0, 120));
        store.outboxRetry(item.id, item.attempts, now);
      }
    }
  }

  const timer = setInterval(() => void flush(), 2000);
  timer.unref();

  async function waitForApproval(approvalId: string, timeoutMs: number): Promise<"approved" | "rejected" | "expired" | "still_pending"> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      store.expireApprovals(nowSec());
      const a = store.getApproval(approvalId);
      if (!a) return "expired";
      if (a.status === "approved" || a.status === "used") return "approved";
      if (a.status === "rejected") return "rejected";
      if (a.status === "expired") return "expired";
      if (Date.now() >= end) return "still_pending";
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return {
    config: cfg,
    params,
    store,
    mirror,
    ens,
    arkiv,
    arkivOwner,
    attach,
    flush,
    waitForApproval,
    /** Dry run: gives the verdict for a challenge without paying. */
    async check(a: { url: string; requirements: any }) {
      const ctx: RequestCtx = { url: a.url, origin: new URL(a.url).origin, receivedAt: nowSec(), idempotent: false };
      const { decision: d } = await evaluate(a.requirements, ctx);
      store.saveDecision(cfg.agent, d);
      auditDecision(d);
      return d;
    },
    explain: (id: string) => store.getDecision(id),
    guardedFetch: (inner: typeof fetch) => (input: Parameters<typeof fetch>[0], init?: RequestInit & { herdIdempotent?: boolean }) => guardedFetchImpl(inner, input, init),
    async merchant(key: string) {
      const now = nowSec();
      const r = await standing(key, now);
      return r;
    },
    close() {
      clearInterval(timer);
      hcsClient?.close();
      store.db.close();
    },
    digest,
  };
}

export type HerdGuard = ReturnType<typeof createHerdGuard>;
