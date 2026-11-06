import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { AccountId, Client, PrivateKey, TopicMessageSubmitTransaction, Transaction } from "@hiero-ledger/sdk";
import { createPublicClient, http, verifyMessage, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import {
  DEFAULT_LIMITS, PROFILES, challengeHash, decide, normalizeUrl, replay,
  type Challenge, type Decision, type Limits, type PolicyParams, type StandingView,
} from "@leash/core";
import { Arkiv } from "./arkiv.ts";
import { deliveryCheck } from "./delivery.ts";
import { Ens, validAccount, validName, type DeclarationResult } from "./ens.ts";
import { PUBLIC_FUNDERS, digest, readVerifiedEvidence, reportMessage, verifyRebuttalRow } from "./evidence.ts";
import { Mirror } from "./mirror.ts";
import { safeError, Store, type Approval } from "./store.ts";

const nowSec = () => Date.now() / 1000;
const MAX_REPORT_ATTEMPTS = 40;
/** A signed payment may still land for this long after it is sent, so "not on Mirror" means nothing before then. */
const SETTLEMENT_LANDING_SEC = 180;

export const approvalMessage = (a: { id: string; challengeHash: string; expiresAt: number }) =>
  `leash.approval:v1|${a.id}|${a.challengeHash}|${a.expiresAt}`;

export class LeashDenied extends Error {
  constructor(readonly decision: Decision) {
    super(`leash:DENY:${decision.reasons.join(",")}`);
  }
}
export class LeashEscalated extends Error {
  constructor(readonly decision: Decision, readonly approvalId: string) {
    super(`leash:ESCALATE:${decision.reasons.join(",")}`);
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
  /** A tuned policy, such as liveProfile(18, [60, 120, 300]). Overrides policyProfile. */
  policy?: PolicyParams;
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

export function createLeashGuard(cfg: GuardConfig) {
  const params: PolicyParams = cfg.policy ?? PROFILES[cfg.policyProfile ?? "production"];
  const usdc = cfg.usdc ?? "0.0.429274";
  const limits: Limits = { ...DEFAULT_LIMITS, allowedAssets: [usdc], ...cfg.limits };
  const store = new Store(cfg.dbPath ?? ".leash/leash.sqlite");
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

  const evidence = (payee: string) => readVerifiedEvidence({
    arkiv, mirror, ns: cfg.namespace, payee, usdc, publicFunders, proberOwners, badPerPayeeWindowSec: params.badPerPayeeWindowSec,
    verifyRebuttal: (r) => verifyRebuttalRow(r, cfg.namespace, ens, sepoliaClient),
  });

  /** In safe mode caches can hide a recovery, so each decision really probes. Three healthy reads in a row end it. */
  async function probeDependencies(now: number) {
    const probe = (dep: string, read: () => Promise<boolean>) =>
      read().then((ok) => store.setHealth(dep, ok, now)).catch((e) => store.setHealth(dep, false, now, safeError(e)));
    await Promise.all([probe("ens", () => ens.health()), probe("arkiv", () => arkiv.health()), probe("mirror", () => mirror.health())]);
  }

  /** Fresh read, else the staleness rules in core decide what the cached view is worth. */
  async function standing(payee: string, now: number): Promise<{ status: "fresh" | "stale" | "none"; view?: StandingView; incomplete: boolean }> {
    const cached = store.standingGet(payee);
    // A cached block past its end must be re-read: core derives what comes next, not the cache.
    const expired = cached?.blockEnd != null && cached.blockEnd <= now;
    if (cached && !expired && now - cached.computedAt <= params.standingFreshSec) {
      return { status: "fresh", view: cached, incomplete: false };
    }
    try {
      const v = await evidence(payee);
      const view = replay(v.evidence, now, params);
      // With Mirror down the view is missing evidence, so caching it would turn the next call into a false ALLOW.
      if (!v.incomplete) store.standingPut(payee, view);
      store.setHealth("arkiv", true, now);
      return { status: "fresh", view, incomplete: v.incomplete };
    } catch (e) {
      store.setHealth("arkiv", false, now, safeError(e));
      return cached ? { status: "stale", view: cached, incomplete: false } : { status: "none", incomplete: false };
    }
  }
  /**
   * The 402 is merchant text. A payTo that is not a plain account id, or an amount that is not a whole number, is
   * refused, and replaced here so that it never reaches a log, a card or a tool result.
   */
  function toChallenge(req: any, url?: string): { challenge: Challenge; malformed: boolean } {
    const payTo = validAccount(req.payTo) ? req.payTo : "invalid";
    const amountOk = /^\d{1,18}$/.test(String(req.amount));
    return {
      challenge: {
        scheme: req.scheme, network: req.network, asset: req.asset, amountUsd: amountOk ? Number(req.amount) / 1e6 : 0, payTo,
        resourceUrl: url ?? `unknown://${payTo}`, maxTimeoutSeconds: req.maxTimeoutSeconds, extra: req.extra,
      },
      malformed: !amountOk || payTo !== req.payTo,
    };
  }

  /** After a failed settle, Mirror Node decides whether another attempt could double-pay. */
  async function settlementUnknown(hash: string, now: number): Promise<boolean> {
    const open = store.settlementGet(cfg.agent, hash);
    if (!open) return false;
    try {
      const facts = await mirror.tx(open.txId);
      if (!facts.found && now - open.at < SETTLEMENT_LANDING_SEC) return true;
      store.settlementClose(cfg.agent, hash);
      return false;
    } catch {
      return true;
    }
  }

  async function evaluate(req: any, ctx: RequestCtx | undefined): Promise<{ decision: Decision; declaration: DeclarationResult; challenge: Challenge }> {
    const started = performance.now();
    const now = nowSec();
    store.expireApprovals(now);
    if (store.safeMode()) await probeDependencies(now);
    const { challenge, malformed } = toChallenge(req, ctx?.url);
    const hash = challengeHash(challenge);
    const claim = validName(req.extra?.leashEns) ? (req.extra.leashEns as string) : null;
    const [declaration, reg] = await Promise.all([ens.resolve(claim, now), standing(challenge.payTo, now)]);
    const merchant = claim && declaration.value ? claim : challenge.payTo;
    const decision = decide({
      now, challenge, claim, declaration,
      realOrigin: ctx?.origin ?? null,
      registry: { status: reg.status, view: reg.view },
      ledger: store.ledger(cfg.agent, session, merchant, normalizeUrl(challenge.resourceUrl), now),
      challengeState: { receivedAt: ctx?.receivedAt ?? now, paidAt: store.paidAt(cfg.agent, hash) },
      idempotent: ctx?.idempotent,
      escalationsLastHour: store.countNewEscalations(cfg.agent, now, hash),
      unverifiedEvidence: reg.incomplete,
      malformedChallenge: malformed,
      safeMode: store.safeMode(),
      settlementUnknown: await settlementUnknown(hash, now),
      locallyBlocked: store.isLocallyBlocked(challenge.payTo),
      limits, params,
    });
    decision.latencyMs = Math.round(performance.now() - started);
    return { decision, declaration, challenge };
  }

  function pendingApproval(d: Decision, payTo: string, declaration: DeclarationResult): string {
    const open = store.listApprovals("pending", 200).find((a) => a.agent === cfg.agent && a.challengeHash === d.challengeHash);
    if (open) return open.id;
    const id = randomUUID();
    const remaining = Math.max(0, d.limits.cap24h - d.limits.capUsed24h);
    store.createApproval({
      id, agent: cfg.agent, decisionId: d.id, challengeHash: d.challengeHash, createdAt: d.at, expiresAt: d.at + limits.replayWindowSec,
      // Structured fields only. Raw merchant text is never rendered.
      card: {
        merchant: d.merchantKey, payTo, standing: d.standing, amountUsd: d.amountUsd,
        score: Math.round(d.score * 10) / 10, reasons: d.reasons.slice(0, 3), remainingCap24h: remaining,
        declaredMaxUsd: declaration.value?.maxPriceUsd ?? null,
      },
    });
    audit("approval", id, { id, state: "requested", agent: cfg.agent, merchant: d.merchantKey, amountUsd: d.amountUsd, challengeHash: d.challengeHash, at: d.at });
    return id;
  }

  /** Verified against the owner's key at use, so a tampered database row cannot approve. */
  async function useApproval(hash: string, now: number): Promise<Approval | undefined> {
    const candidate = store.listApprovals("approved", 200).find((a) => a.agent === cfg.agent && a.challengeHash === hash && a.expiresAt >= now);
    if (!candidate?.signature) return undefined;
    const ok = await verifyMessage({ address: cfg.ownerAddress, message: approvalMessage(candidate), signature: candidate.signature as `0x${string}` }).catch(() => false);
    const used = ok ? store.consumeApproval(cfg.agent, hash, now) : undefined;
    if (used) audit("approval", `${used.id}:used`, { id: used.id, state: "used", agent: cfg.agent, challengeHash: hash, at: now, signature: used.signature });
    return used;
  }

  const audit = (type: string, dedupe: string, body: Record<string, unknown>) => {
    if (cfg.hcsTopicId) store.enqueue("hcs", `hcs:${type}:${dedupe}`, { type, ...body });
  };
  /** Every decision, paid or dry run: one stored row, one structured log line and one audit message (NFR-07). */
  function record(d: Decision) {
    store.saveDecision(cfg.agent, d);
    audit("decision", d.id, { id: d.id, agent: cfg.agent, verdict: d.verdict, reasons: d.reasons, merchant: d.merchantKey, standing: d.standing, score: Math.round(d.score * 10) / 10, amountUsd: d.amountUsd, challengeHash: d.challengeHash, at: d.at });
    console.error(JSON.stringify({ leash: "decision", agent: cfg.agent, ...d }));
  }

  function attach(client: { onBeforePaymentCreation: Function; onAfterPaymentCreation: Function }) {
    client.onBeforePaymentCreation(async (hook: any) => {
      const ctx = als.getStore();
      const req = hook.selectedRequirements;
      let { decision, declaration, challenge } = await evaluate(req, ctx);
      // Parallel calls for one challenge can all be allowed before any of them pays. Only the first takes it; the others
      // decide again and now see a replay. ponytail: an allowed call that fails before signing keeps its mark, so a
      // retry inside the 120 s window is refused as a replay; release the claim on that path if it ever matters.
      if (decision.verdict === "ALLOW" && !ctx?.idempotent && !store.claimChallenge(cfg.agent, decision.challengeHash, decision.at, limits.replayWindowSec)) {
        ({ decision, declaration, challenge } = await evaluate(req, ctx));
      }
      record(decision);
      if (ctx) ctx.decision = decision;
      (hook as any).__declaration = declaration;
      if (ctx) (ctx as any).schema = declaration.value?.schema ?? [];
      if (cfg.mode === "observe" || decision.verdict === "ALLOW") return;
      const reason = `leash:${decision.verdict}:${decision.reasons.join(",")}`;
      if (decision.verdict === "DENY") return { abort: true, reason };
      if (await useApproval(decision.challengeHash, decision.at)) return;
      const approvalId = pendingApproval(decision, challenge.payTo, declaration);
      decision.approvalId = approvalId;
      store.saveDecision(cfg.agent, decision);
      if (ctx) ctx.approvalId = approvalId;
      return { abort: true, reason };
    });

    client.onAfterPaymentCreation(async (hook: any) => {
      const ctx = als.getStore();
      const req = hook.selectedRequirements;
      const d = ctx?.decision;
      if (!ctx || !d) {
        // Outside guardedFetch, so there is no response to check or report on. The owner approved it, and it still counts.
        const { challenge } = toChallenge(req);
        const at = nowSec();
        store.markPaid(cfg.agent, challengeHash(challenge), at);
        store.recordSpend({ agent: cfg.agent, session, merchant: challenge.payTo, resource: normalizeUrl(challenge.resourceUrl), standing: "UNKNOWN", amount: challenge.amountUsd, at });
        return;
      }
      const tx = Transaction.fromBytes(Buffer.from(String(hook.paymentPayload.payload.transaction), "base64"));
      const at = nowSec();
      store.markPaid(cfg.agent, d.challengeHash, at);
      store.recordSpend({ agent: cfg.agent, session, merchant: d.merchantKey, resource: normalizeUrl(ctx.url), standing: d.standing, amount: d.amountUsd, at });
      ctx.paid = {
        txId: tx.transactionId!.toString(), payee: req.payTo, ens: validName(req.extra?.leashEns) ? req.extra.leashEns : "",
        amountMicroUsd: Number(req.amount), schema: (ctx as any).schema ?? [], hash: d.challengeHash, decisionId: d.id,
      };
    });
  }

  async function guardedFetchImpl(inner: typeof fetch, input: Parameters<typeof fetch>[0], init?: RequestInit & { leashIdempotent?: boolean }) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const ctx: RequestCtx = { url, origin: new URL(url).origin, receivedAt: nowSec(), idempotent: !!init?.leashIdempotent };
    let res: Response;
    try {
      res = await als.run(ctx, () => inner(input, init));
    } catch (e) {
      const d = ctx.decision;
      if (d?.verdict === "DENY") throw new LeashDenied(d);
      if (d?.verdict === "ESCALATE" && ctx.approvalId) {
        if (cfg.awaitApprovalMs && (await waitForApproval(ctx.approvalId, cfg.awaitApprovalMs)) === "approved") return guardedFetchImpl(inner, input, init);
        throw new LeashEscalated(d, ctx.approvalId);
      }
      if (ctx.paid) {
        store.settlementOpen(cfg.agent, ctx.paid.hash, ctx.paid.txId, nowSec());
        queueReport(ctx, "bad", "transport-failure");
      }
      throw e;
    }
    if (ctx.paid) {
      if (!res.ok) store.settlementOpen(cfg.agent, ctx.paid.hash, ctx.paid.txId, nowSec());
      const body = await res.clone().text();
      const check = deliveryCheck({ status: res.status, contentType: res.headers.get("content-type"), body, schema: ctx.paid.schema });
      queueReport(ctx, check.ok ? "good" : "bad", check.ok ? "delivered" : check.reason);
      (res as any).leash = { decisionId: ctx.paid.decisionId, txId: ctx.paid.txId, delivered: check.ok };
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
      let facts;
      try {
        facts = await mirror.tx(p.txId);
      } catch {
        return "retry"; // held until Mirror can confirm settlement; Mirror reports its own health
      }
      if (!facts.found) return item.attempts >= MAX_REPORT_ATTEMPTS ? "done" : "retry"; // settlement never landed
      if (!facts.success) return "done";
      // Delivery is at-least-once: a write that outlived its claim, or a crash after writing, would otherwise file twice.
      if (await arkiv.hasReport(p.txId, arkivOwner)) return "done";
      const message = reportMessage({ ns: cfg.namespace, txId: p.txId, payee: p.payee, outcome: p.outcome, amountMicroUsd: p.amountMicroUsd, owner: arkivOwner });
      const payerSig = Buffer.from(hederaKey.sign(Buffer.from(message))).toString("hex");
      const { entityKey } = await arkiv.writeReport(evmKey, {
        payee: p.payee, ens: p.ens, domain: p.domain, outcome: p.outcome, txId: p.txId, payer: facts.payer ?? cfg.hederaAccount, payerSig,
        consensusTs: facts.consensusTs!, amountMicroUsd: p.amountMicroUsd, reason: p.reason,
      }, params.reportTtlSec);
      audit("report", p.txId, { txId: p.txId, payee: p.payee, outcome: p.outcome, reason: p.reason, entityKey });
      store.db.prepare("DELETE FROM cache_standing WHERE payee=?").run(p.payee);
      console.error(JSON.stringify({ leash: "report", agent: cfg.agent, outcome: p.outcome, reason: p.reason, txId: p.txId, entityKey }));
      return "done";
    }
    return "done";
  }

  async function flush() {
    const now = nowSec();
    for (const item of store.dueOutbox(now, 25, cfg.agent)) {
      if (!store.claimOutbox(item.id, now)) continue;
      try {
        if ((await deliverOutboxItem(item)) === "done") store.outboxDone(item.id);
        else store.outboxRetry(item.id, item.attempts, now);
      } catch (e) {
        store.setHealth(item.kind === "hcs" ? "hcs" : "arkiv", false, now, safeError(e));
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
    limits,
    session,
    evidence,
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
      record(d);
      return d;
    },
    explain: (id: string) => store.getDecision(id),
    guardedFetch: (inner: typeof fetch) => (input: Parameters<typeof fetch>[0], init?: RequestInit & { leashIdempotent?: boolean }) => guardedFetchImpl(inner, input, init),
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

export type LeashGuard = ReturnType<typeof createLeashGuard>;
