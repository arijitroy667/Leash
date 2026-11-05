import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Decision, StandingView } from "@leash/core";

const DAY = 86400;
const HEALTHY_READS_TO_RECOVER = 3;

export interface Approval {
  id: string;
  agent: string;
  decisionId: string;
  challengeHash: string;
  card: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "used" | "expired";
  createdAt: number;
  expiresAt: number;
  signature?: string;
}

export interface OutboxItem {
  id: number;
  kind: string;
  payload: any;
  attempts: number;
}

/** Durable local state. One file, shared by the guard, MCP server, dashboard and prober. */
/** RPC urls can carry access keys, and error text quotes them. Use this for anything logged or displayed. */
export const safeError = (e: unknown) =>
  String((e as { shortMessage?: string })?.shortMessage ?? e).replace(/https?:\/\/\S+/g, "[url]").replace(/ark_live_\w+/g, "[key]").slice(0, 160);

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, agent TEXT, at REAL, verdict TEXT, merchant TEXT, body TEXT);
      CREATE INDEX IF NOT EXISTS decisions_at ON decisions(at);
      CREATE TABLE IF NOT EXISTS challenges (agent TEXT, hash TEXT, paid_at REAL, PRIMARY KEY (agent, hash));
      CREATE TABLE IF NOT EXISTS spend_ledger (agent TEXT, session TEXT, merchant TEXT, resource TEXT, standing TEXT, amount REAL, at REAL);
      CREATE INDEX IF NOT EXISTS spend_at ON spend_ledger(agent, at);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, agent TEXT, decision_id TEXT, challenge_hash TEXT, card TEXT, status TEXT, created_at REAL, expires_at REAL, signature TEXT);
      CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, dedupe TEXT UNIQUE, kind TEXT, payload TEXT, attempts INTEGER DEFAULT 0, next_at REAL DEFAULT 0, done INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS cache_policy (name TEXT PRIMARY KEY, body TEXT, fetched_at REAL);
      CREATE TABLE IF NOT EXISTS cache_standing (payee TEXT PRIMARY KEY, body TEXT, fetched_at REAL);
      CREATE TABLE IF NOT EXISTS cache_tx (tx_id TEXT PRIMARY KEY, body TEXT);
      CREATE TABLE IF NOT EXISTS cache_account (account TEXT PRIMARY KEY, body TEXT);
      CREATE TABLE IF NOT EXISTS probe_budget (day TEXT PRIMARY KEY, spent REAL);
      CREATE TABLE IF NOT EXISTS health (dep TEXT PRIMARY KEY, ok INTEGER, at REAL, detail TEXT);
      CREATE TABLE IF NOT EXISTS settlements (agent TEXT, hash TEXT, tx_id TEXT, at REAL, PRIMARY KEY (agent, hash));
      CREATE TABLE IF NOT EXISTS local_blocks (payee TEXT PRIMARY KEY, at REAL);
    `);
    // Databases from before safe-mode recovery have no such column. Healthy is NULL, otherwise healthy reads so far.
    try {
      this.db.exec("ALTER TABLE health ADD COLUMN recovering INTEGER");
    } catch {
      /* already there */
    }
  }

  saveDecision(agent: string, d: Decision) {
    this.db.prepare("INSERT OR REPLACE INTO decisions VALUES (?,?,?,?,?,?)").run(d.id, agent, d.at, d.verdict, d.merchantKey, JSON.stringify(d));
  }
  getDecision(id: string): Decision | undefined {
    const r = this.db.prepare("SELECT body FROM decisions WHERE id=?").get(id) as { body: string } | undefined;
    return r && JSON.parse(r.body);
  }
  recentDecisions(limit = 100): (Decision & { agent: string })[] {
    const rows = this.db.prepare("SELECT agent, body FROM decisions ORDER BY at DESC LIMIT ?").all(limit) as { agent: string; body: string }[];
    return rows.map((r) => ({ ...JSON.parse(r.body), agent: r.agent }));
  }

  paidAt(agent: string, hash: string): number | null {
    const r = this.db.prepare("SELECT paid_at FROM challenges WHERE agent=? AND hash=?").get(agent, hash) as { paid_at: number } | undefined;
    return r?.paid_at ?? null;
  }
  markPaid(agent: string, hash: string, at: number) {
    this.db.prepare("INSERT OR REPLACE INTO challenges VALUES (?,?,?)").run(agent, hash, at);
  }

  recordSpend(e: { agent: string; session: string; merchant: string; resource: string; standing: string; amount: number; at: number }) {
    this.db.prepare("INSERT INTO spend_ledger VALUES (?,?,?,?,?,?,?)").run(e.agent, e.session, e.merchant, e.resource, e.standing, e.amount, e.at);
  }
  ledger(agent: string, session: string, merchant: string, resource: string, now: number) {
    const sum = (where: string, ...args: (string | number)[]) =>
      Number((this.db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM spend_ledger WHERE agent=? AND ${where}`).get(agent, ...args) as { s: number }).s);
    const from = now - DAY;
    return {
      merchantSpent24h: sum("merchant=? AND at>?", merchant, from),
      sessionSpent: sum("session=?", session),
      dailySpent: sum("at>?", from),
      newIdentitySpentToday: sum("standing='NEW' AND at>?", from),
      recentPrices: (this.db.prepare("SELECT amount FROM spend_ledger WHERE agent=? AND resource=? ORDER BY at DESC LIMIT 5").all(agent, resource) as { amount: number }[]).map((r) => r.amount),
    };
  }

  createApproval(a: Omit<Approval, "status">) {
    this.db.prepare("INSERT OR REPLACE INTO approvals VALUES (?,?,?,?,?,?,?,?,NULL)").run(a.id, a.agent, a.decisionId, a.challengeHash, JSON.stringify(a.card), "pending", a.createdAt, a.expiresAt);
  }
  private toApproval(r: any): Approval {
    return { id: r.id, agent: r.agent, decisionId: r.decision_id, challengeHash: r.challenge_hash, card: JSON.parse(r.card), status: r.status, createdAt: r.created_at, expiresAt: r.expires_at, signature: r.signature ?? undefined };
  }
  getApproval(id: string): Approval | undefined {
    const r = this.db.prepare("SELECT * FROM approvals WHERE id=?").get(id);
    return r ? this.toApproval(r) : undefined;
  }
  listApprovals(status?: Approval["status"], limit = 50): Approval[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM approvals WHERE status=? ORDER BY created_at DESC LIMIT ?").all(status, limit)
      : this.db.prepare("SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?").all(limit);
    return rows.map((r) => this.toApproval(r));
  }
  expireApprovals(now: number) {
    this.db.prepare("UPDATE approvals SET status='expired' WHERE status IN ('pending','approved') AND expires_at<?").run(now);
  }
  resolveApproval(id: string, status: "approved" | "rejected", signature?: string) {
    return Number(this.db.prepare("UPDATE approvals SET status=?, signature=? WHERE id=? AND status='pending'").run(status, signature ?? null, id).changes) === 1;
  }
  /** Atomic: only one caller can ever use an approval. */
  consumeApproval(agent: string, hash: string, now: number): Approval | undefined {
    const r = this.db.prepare("SELECT * FROM approvals WHERE agent=? AND challenge_hash=? AND status='approved' AND expires_at>=? ORDER BY created_at DESC LIMIT 1").get(agent, hash, now);
    if (!r) return undefined;
    const a = this.toApproval(r);
    const changed = this.db.prepare("UPDATE approvals SET status='used' WHERE id=? AND status='approved'").run(a.id).changes;
    return Number(changed) === 1 ? a : undefined;
  }
  /** The challenge being decided is not new if it already has an approval, or an approved payment could never run. */
  countNewEscalations(agent: string, now: number, exceptHash = ""): number {
    return Number((this.db.prepare("SELECT COUNT(*) c FROM approvals WHERE agent=? AND created_at>? AND challenge_hash<>?").get(agent, now - 3600, exceptHash) as { c: number }).c);
  }
  escalationsByAgent(now: number): { agent: string; count: number }[] {
    return (this.db.prepare("SELECT agent, COUNT(*) c FROM approvals WHERE created_at>? GROUP BY agent").all(now - 3600) as { agent: string; c: number }[])
      .map((r) => ({ agent: r.agent, count: Number(r.c) }));
  }

  /** A payment that did not visibly deliver may still have settled. Kept until Mirror Node can say. */
  settlementOpen(agent: string, hash: string, txId: string, at: number) {
    this.db.prepare("INSERT OR REPLACE INTO settlements VALUES (?,?,?,?)").run(agent, hash, txId, at);
  }
  settlementGet(agent: string, hash: string): { txId: string; at: number } | undefined {
    const r = this.db.prepare("SELECT tx_id, at FROM settlements WHERE agent=? AND hash=?").get(agent, hash) as { tx_id: string; at: number } | undefined;
    return r && { txId: r.tx_id, at: r.at };
  }
  settlementClose(agent: string, hash: string) {
    this.db.prepare("DELETE FROM settlements WHERE agent=? AND hash=?").run(agent, hash);
  }

  blockLocally(payee: string, at: number) {
    this.db.prepare("INSERT OR REPLACE INTO local_blocks VALUES (?,?)").run(payee, at);
  }
  isLocallyBlocked(payee: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM local_blocks WHERE payee=?").get(payee);
  }

  /** Spend for the budget view: session, rolling day, and each merchant with its latest cap. */
  budget(agent: string, session: string, now: number) {
    const from = now - DAY;
    const total = (where: string, ...args: (string | number)[]) =>
      Number((this.db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM spend_ledger WHERE agent=? AND ${where}`).get(agent, ...args) as { s: number }).s);
    const merchants = this.db.prepare("SELECT merchant, SUM(amount) spent FROM spend_ledger WHERE agent=? AND at>? GROUP BY merchant").all(agent, from) as { merchant: string; spent: number }[];
    return {
      sessionSpent: total("session=?", session),
      dailySpent: total("at>?", from),
      perMerchant: merchants.map((m) => {
        const last = this.db.prepare("SELECT body FROM decisions WHERE agent=? AND merchant=? ORDER BY at DESC LIMIT 1").get(agent, m.merchant) as { body: string } | undefined;
        const cap24h: number | null = last ? JSON.parse(last.body).limits.cap24h : null;
        return { merchant: m.merchant, spent: m.spent, cap24h, remaining: cap24h === null ? null : Math.max(0, cap24h - m.spent) };
      }),
    };
  }

  enqueue(kind: string, dedupe: string, payload: unknown) {
    this.db.prepare("INSERT OR IGNORE INTO outbox (dedupe, kind, payload) VALUES (?,?,?)").run(dedupe, kind, JSON.stringify(payload));
  }
  dueOutbox(now: number, limit = 10): OutboxItem[] {
    const rows = this.db.prepare("SELECT id, kind, payload, attempts FROM outbox WHERE done=0 AND next_at<=? ORDER BY id LIMIT ?").all(now, limit) as any[];
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }
  /** Atomic across guards and processes, so an item is never delivered twice at once. */
  claimOutbox(id: number, now: number): boolean {
    return Number(this.db.prepare("UPDATE outbox SET next_at=? WHERE id=? AND done=0 AND next_at<=?").run(now + 30, id, now).changes) === 1;
  }
  outboxDone(id: number) {
    this.db.prepare("UPDATE outbox SET done=1 WHERE id=?").run(id);
  }
  outboxRetry(id: number, attempts: number, now: number) {
    this.db.prepare("UPDATE outbox SET attempts=?, next_at=? WHERE id=?").run(attempts + 1, now + Math.min(60, 2 ** attempts), id);
  }
  outboxDepth(): { depth: number; oldest: number | null } {
    const r = this.db.prepare("SELECT COUNT(*) c, MIN(id) m FROM outbox WHERE done=0").get() as { c: number; m: number | null };
    return { depth: Number(r.c), oldest: r.m };
  }

  policyGet(name: string) {
    const r = this.db.prepare("SELECT body, fetched_at FROM cache_policy WHERE name=?").get(name) as { body: string; fetched_at: number } | undefined;
    return r && { value: JSON.parse(r.body), fetchedAt: r.fetched_at };
  }
  policyPut(name: string, value: unknown, at: number) {
    this.db.prepare("INSERT OR REPLACE INTO cache_policy VALUES (?,?,?)").run(name, JSON.stringify(value), at);
  }
  standingGet(payee: string): StandingView | undefined {
    const r = this.db.prepare("SELECT body FROM cache_standing WHERE payee=?").get(payee) as { body: string } | undefined;
    return r && JSON.parse(r.body);
  }
  standingPut(payee: string, v: StandingView) {
    this.db.prepare("INSERT OR REPLACE INTO cache_standing VALUES (?,?,?)").run(payee, JSON.stringify(v), v.computedAt);
  }
  txGet(txId: string) {
    const r = this.db.prepare("SELECT body FROM cache_tx WHERE tx_id=?").get(txId) as { body: string } | undefined;
    return r && JSON.parse(r.body);
  }
  txPut(txId: string, v: unknown) {
    this.db.prepare("INSERT OR REPLACE INTO cache_tx VALUES (?,?)").run(txId, JSON.stringify(v));
  }
  accountGet(id: string) {
    const r = this.db.prepare("SELECT body FROM cache_account WHERE account=?").get(id) as { body: string } | undefined;
    return r && JSON.parse(r.body);
  }
  accountPut(id: string, v: unknown) {
    this.db.prepare("INSERT OR REPLACE INTO cache_account VALUES (?,?)").run(id, JSON.stringify(v));
  }

  setHealth(dep: string, ok: boolean, at: number, detail = "") {
    const prev = (this.db.prepare("SELECT recovering FROM health WHERE dep=?").get(dep) as { recovering: number | null } | undefined)?.recovering ?? null;
    const recovering = !ok ? 0 : prev === null || prev + 1 >= HEALTHY_READS_TO_RECOVER ? null : prev + 1;
    this.db.prepare("INSERT OR REPLACE INTO health (dep, ok, at, detail, recovering) VALUES (?,?,?,?,?)").run(dep, ok ? 1 : 0, at, detail, recovering);
  }
  healthAll(): { dep: string; ok: boolean; at: number; detail: string; recovering: boolean }[] {
    return (this.db.prepare("SELECT * FROM health").all() as any[]).map((r) => ({ dep: r.dep, ok: !!r.ok, at: r.at, detail: r.detail, recovering: !!r.ok && r.recovering !== null }));
  }
  /** Two or more of ENS, Arkiv and Mirror failing, or not yet back for three healthy reads in a row. */
  safeMode(): boolean {
    const r = this.db.prepare("SELECT COUNT(*) c FROM health WHERE dep IN ('ens','arkiv','mirror') AND recovering IS NOT NULL").get() as { c: number };
    return Number(r.c) >= 2;
  }

  probeSpent(day: string): number {
    const r = this.db.prepare("SELECT spent FROM probe_budget WHERE day=?").get(day) as { spent: number } | undefined;
    return r?.spent ?? 0;
  }
  addProbeSpend(day: string, amount: number) {
    this.db.prepare("INSERT INTO probe_budget VALUES (?,?) ON CONFLICT(day) DO UPDATE SET spent=spent+?").run(day, amount, amount);
  }
}
