import path from "node:path";
import { mkdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export interface PlanRow {
  id: string;
  kind: string;
  input: unknown;
  changes: Change[];
  changes_hash: string;
  confirm_code: string;
  created_at: string;
  expires_at: string;
  status: "pending" | "partial" | "done";
  done: string[];
}

export interface Change {
  op: string;
  target: string;
  summary: string;
  params: Record<string, unknown>;
}

export interface AuditRow {
  id: number;
  ts: string;
  actor: string;
  tool: string;
  plan_id: string | null;
  target: string | null;
  result: string;
  detail: unknown;
}

export interface AppDecision {
  app_slug: string;
  installation_id: number | null;
  permissions: Record<string, string>;
  repository_selection: string | null;
  tier: string;
  verdict: "approve" | "reject";
  reason: string;
  approvers: string[];
  decided_by: string;
  decided_at: string;
}

export interface AppRequestRow {
  request_id: string;
  app_slug: string;
  app_name: string;
  requester: string | null;
  review_url: string;
  received_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, input TEXT NOT NULL, changes TEXT NOT NULL,
  changes_hash TEXT NOT NULL, confirm_code TEXT NOT NULL, created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, status TEXT NOT NULL, done TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL, tool TEXT NOT NULL,
  plan_id TEXT, target TEXT, result TEXT NOT NULL, detail TEXT
);
CREATE TABLE IF NOT EXISTS app_reviews (
  app_slug TEXT PRIMARY KEY, installation_id INTEGER, permissions TEXT NOT NULL, repository_selection TEXT,
  tier TEXT NOT NULL, verdict TEXT NOT NULL, reason TEXT NOT NULL, approvers TEXT NOT NULL,
  decided_by TEXT NOT NULL, decided_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_requests (
  request_id TEXT PRIMARY KEY, app_slug TEXT NOT NULL, app_name TEXT NOT NULL, requester TEXT,
  review_url TEXT NOT NULL, received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS repo_flags (repo TEXT NOT NULL, flag TEXT NOT NULL, PRIMARY KEY (repo, flag));
`;

const j = (v: unknown) => JSON.stringify(v ?? null);
const p = <T>(v: unknown, fallback: T): T => (typeof v === "string" ? (JSON.parse(v) as T) : fallback);

export class StateDb {
  constructor(private readonly db: DatabaseSync) {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA);
  }

  // ---- plans
  insertPlan(row: PlanRow) {
    this.db
      .prepare(
        "INSERT INTO plans (id, kind, input, changes, changes_hash, confirm_code, created_at, expires_at, status, done) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(row.id, row.kind, j(row.input), j(row.changes), row.changes_hash, row.confirm_code, row.created_at, row.expires_at, row.status, j(row.done));
  }

  getPlan(id: string): PlanRow | null {
    const r = this.db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: String(r.id),
      kind: String(r.kind),
      input: p(r.input, {}),
      changes: p(r.changes, []),
      changes_hash: String(r.changes_hash),
      confirm_code: String(r.confirm_code),
      created_at: String(r.created_at),
      expires_at: String(r.expires_at),
      status: String(r.status) as PlanRow["status"],
      done: p(r.done, []),
    };
  }

  updatePlanProgress(id: string, status: PlanRow["status"], done: string[]) {
    this.db.prepare("UPDATE plans SET status = ?, done = ? WHERE id = ?").run(status, j(done), id);
  }

  // ---- audit (append-only)
  audit(entry: Omit<AuditRow, "id" | "ts"> & { ts?: string }) {
    this.db
      .prepare("INSERT INTO audit (ts, actor, tool, plan_id, target, result, detail) VALUES (?,?,?,?,?,?,?)")
      .run(entry.ts ?? new Date().toISOString(), entry.actor, entry.tool, entry.plan_id, entry.target, entry.result, j(entry.detail));
  }

  queryAudit(f: { since?: string; tool?: string; limit: number }): AuditRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.since) {
      where.push("ts >= ?");
      args.push(f.since);
    }
    if (f.tool) {
      where.push("tool = ?");
      args.push(f.tool);
    }
    const sql = `SELECT * FROM audit ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, f.limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      ts: String(r.ts),
      actor: String(r.actor),
      tool: String(r.tool),
      plan_id: (r.plan_id as string) ?? null,
      target: (r.target as string) ?? null,
      result: String(r.result),
      detail: p(r.detail, null),
    }));
  }

  // ---- app decisions
  saveDecision(d: AppDecision) {
    this.db
      .prepare(
        `INSERT INTO app_reviews (app_slug, installation_id, permissions, repository_selection, tier, verdict, reason, approvers, decided_by, decided_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(app_slug) DO UPDATE SET installation_id=excluded.installation_id, permissions=excluded.permissions,
           repository_selection=excluded.repository_selection, tier=excluded.tier, verdict=excluded.verdict, reason=excluded.reason,
           approvers=excluded.approvers, decided_by=excluded.decided_by, decided_at=excluded.decided_at`,
      )
      .run(d.app_slug, d.installation_id, j(d.permissions), d.repository_selection, d.tier, d.verdict, d.reason, j(d.approvers), d.decided_by, d.decided_at);
  }

  decisions(): AppDecision[] {
    return (this.db.prepare("SELECT * FROM app_reviews").all() as Record<string, unknown>[]).map((r) => ({
      app_slug: String(r.app_slug),
      installation_id: (r.installation_id as number) ?? null,
      permissions: p(r.permissions, {}),
      repository_selection: (r.repository_selection as string) ?? null,
      tier: String(r.tier),
      verdict: String(r.verdict) as AppDecision["verdict"],
      reason: String(r.reason),
      approvers: p(r.approvers, []),
      decided_by: String(r.decided_by),
      decided_at: String(r.decided_at),
    }));
  }

  decision(slug: string): AppDecision | null {
    return this.decisions().find((d) => d.app_slug === slug) ?? null;
  }

  // ---- app requests (from GitHub notification emails)
  upsertRequest(r: AppRequestRow) {
    this.db
      .prepare(
        `INSERT INTO app_requests (request_id, app_slug, app_name, requester, review_url, received_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(request_id) DO UPDATE SET received_at = MAX(received_at, excluded.received_at)`,
      )
      .run(r.request_id, r.app_slug, r.app_name, r.requester, r.review_url, r.received_at);
  }

  requests(slug?: string): AppRequestRow[] {
    const rows = (slug
      ? this.db.prepare("SELECT * FROM app_requests WHERE app_slug = ? ORDER BY received_at DESC").all(slug)
      : this.db.prepare("SELECT * FROM app_requests ORDER BY received_at DESC").all()) as Record<string, unknown>[];
    return rows.map((r) => ({
      request_id: String(r.request_id),
      app_slug: String(r.app_slug),
      app_name: String(r.app_name),
      requester: (r.requester as string) ?? null,
      review_url: String(r.review_url),
      received_at: String(r.received_at),
    }));
  }

  // ---- repo flags (e.g. rulesets unsupported on the org's plan)
  setFlag(repo: string, flag: string) {
    this.db.prepare("INSERT OR IGNORE INTO repo_flags (repo, flag) VALUES (?, ?)").run(repo, flag);
  }

  hasFlag(repo: string, flag: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM repo_flags WHERE repo = ? AND flag = ?").get(repo, flag);
  }

  // ---- event close
  personalDataCounts() {
    const n = (sql: string) => Number((this.db.prepare(sql).get() as { n: number }).n);
    return {
      plans: n("SELECT COUNT(*) AS n FROM plans"),
      audit_with_detail: n("SELECT COUNT(*) AS n FROM audit WHERE detail IS NOT NULL AND detail != 'null'"),
      audit_user_targets: n("SELECT COUNT(*) AS n FROM audit WHERE (target LIKE 'user:%' OR target LIKE '%/user:%') AND target NOT LIKE '%user:(removed)'"),
      app_request_requesters: n("SELECT COUNT(*) AS n FROM app_requests WHERE requester IS NOT NULL"),
    };
  }

  purgePersonalData() {
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM plans");
      this.db.exec("UPDATE audit SET detail = NULL");
      this.db.exec("UPDATE audit SET target = 'user:(removed)' WHERE target LIKE 'user:%'");
      this.db.exec("UPDATE audit SET target = substr(target, 1, instr(target, '/user:') - 1) || '/user:(removed)' WHERE target LIKE '%/user:%'");
      this.db.exec("UPDATE app_requests SET requester = NULL");
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.db.exec("VACUUM");
  }
}

const open = new Map<string, StateDb>();

/** One SQLite file per event: events/<id>/state.db. `:memory:` for tests. */
export async function openState(dir: string | ":memory:"): Promise<StateDb> {
  const key = dir;
  const hit = open.get(key);
  if (hit) return hit;
  const { DatabaseSync } = await import("node:sqlite");
  let file = ":memory:";
  if (dir !== ":memory:") {
    mkdirSync(dir, { recursive: true });
    file = path.join(dir, "state.db");
  }
  const db = new StateDb(new DatabaseSync(file));
  if (dir !== ":memory:") open.set(key, db);
  return db;
}
