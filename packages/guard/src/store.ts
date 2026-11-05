import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Decision, StandingView } from "@herd/core";

const DAY = 86400;

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
    `);
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
  countNewEscalations(agent: string, now: number): number {
    return Number((this.db.prepare("SELECT COUNT(*) c FROM approvals WHERE agent=? AND created_at>?").get(agent, now - 3600) as { c: number }).c);
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
    this.db.prepare("INSERT OR REPLACE INTO health VALUES (?,?,?,?)").run(dep, ok ? 1 : 0, at, detail);
  }
  healthAll(): { dep: string; ok: boolean; at: number; detail: string }[] {
    return (this.db.prepare("SELECT * FROM health").all() as any[]).map((r) => ({ dep: r.dep, ok: !!r.ok, at: r.at, detail: r.detail }));
  }

  probeSpent(day: string): number {
    const r = this.db.prepare("SELECT spent FROM probe_budget WHERE day=?").get(day) as { spent: number } | undefined;
    return r?.spent ?? 0;
  }
  addProbeSpend(day: string, amount: number) {
    this.db.prepare("INSERT INTO probe_budget VALUES (?,?) ON CONFLICT(day) DO UPDATE SET spent=spent+?").run(day, amount, amount);
  }
}
