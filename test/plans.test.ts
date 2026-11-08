import { describe, expect, it } from "vitest";
import { applyPlan, createPlan } from "../src/plans/engine.js";
import { teamsPlan, moveMemberPlan } from "../src/plans/teams.js";
import { reposPlan } from "../src/plans/repos.js";
import { freezePlan } from "../src/plans/freeze.js";
import { visibilityPlan } from "../src/plans/visibility.js";
import { reviewersPlan } from "../src/plans/reviewers.js";
import { closePlan } from "../src/plans/close.js";
import { makeCtx } from "./helpers.js";

type Planned = { plan_id: string; confirm_code: string; changes: { op: string; target: string }[]; warnings: string[]; info?: Record<string, unknown> };
const plan = async (...args: Parameters<typeof createPlan>) => (await createPlan(...args)) as unknown as Planned;

describe("plan/apply engine", () => {
  it("creates teams and invites, then has nothing left to do", async () => {
    const { ctx, gh } = await makeCtx();
    gh.orgMembers.add("alice-gh");

    const p = await plan(ctx, teamsPlan, {});
    expect(p.changes.map((c) => c.op)).toEqual(["create_team", "create_team", "add_membership", "invite", "invite", "invite", "invite"]);

    const r = await applyPlan(ctx, teamsPlan, p.plan_id, p.confirm_code);
    expect(r.status).toBe("done");
    expect(gh.teamMembers.get("team01")).toEqual(new Set(["alice-gh"]));
    expect(gh.invitations.map((i) => i.login).sort()).toEqual(["bob-gh", "carol-gh", "dave-gh", "erin-gh"]);

    const again = await createPlan(ctx, teamsPlan, {});
    expect(again.plan_id).toBeNull();
    expect(again.warnings.join("\n")).toContain("pending org invitation");
  });

  it("refuses a wrong confirm code, an expired plan and a reused plan", async () => {
    let now = new Date("2026-11-10T00:00:00Z");
    const { ctx } = await makeCtx({ now: () => now });
    const p = await plan(ctx, teamsPlan, {});
    await expect(applyPlan(ctx, teamsPlan, p.plan_id, "TEAMS-0000")).rejects.toThrow(/does not match/);
    await expect(applyPlan(ctx, reposPlan, p.plan_id, p.confirm_code)).rejects.toThrow(/is a teams plan/);
    now = new Date("2026-11-10T00:16:00Z");
    await expect(applyPlan(ctx, teamsPlan, p.plan_id, p.confirm_code)).rejects.toThrow(/expired/);

    now = new Date("2026-11-10T01:00:00Z");
    const q = await plan(ctx, teamsPlan, {});
    await applyPlan(ctx, teamsPlan, q.plan_id, q.confirm_code.toLowerCase());
    await expect(applyPlan(ctx, teamsPlan, q.plan_id, q.confirm_code)).rejects.toThrow(/already applied/);
  });

  it("refuses when the sheet changed after planning", async () => {
    const { ctx, tables, gh } = await makeCtx();
    const p = await plan(ctx, teamsPlan, {});
    gh.addUser("bob-new");
    tables.github_ids!.rows.push({ "이메일 주소": "bob@x.com", "GitHub 아이디": "bob-new" });
    await expect(applyPlan(ctx, teamsPlan, p.plan_id, p.confirm_code)).rejects.toThrow(/changed since this plan[\s\S]*bob-new/);
  });

  it("resumes after a partial failure without repeating finished changes", async () => {
    const { ctx, gh } = await makeCtx();
    const p = await plan(ctx, teamsPlan, {});
    gh.failOn = "inviteToOrg";
    const first = await applyPlan(ctx, teamsPlan, p.plan_id, p.confirm_code);
    expect(first.status).toBe("partial");
    const createdBefore = gh.calls.filter((c) => c === "createTeam").length;

    const second = await applyPlan(ctx, teamsPlan, p.plan_id, p.confirm_code);
    expect(second.status).toBe("done");
    expect(gh.calls.filter((c) => c === "createTeam").length).toBe(createdBefore);
    expect(gh.invitations).toHaveLength(5);
  });

  it("refuses to plan while the roster has errors", async () => {
    const { ctx, tables } = await makeCtx();
    tables.assignment!.rows.push({ "팀 번호": "3", 이메일: "nobody@x.com", 역할: "", 트랙: "해커톤" });
    await expect(createPlan(ctx, teamsPlan, {})).rejects.toThrow(/roster has errors/);
  });

  it("moves a member who is on the wrong team", async () => {
    const { ctx, gh } = await makeCtx();
    for (const l of ["alice-gh", "bob-gh", "carol-gh", "dave-gh", "erin-gh"]) gh.orgMembers.add(l);
    const p = await plan(ctx, teamsPlan, {});
    await applyPlan(ctx, teamsPlan, p.plan_id, p.confirm_code);

    const m = await plan(ctx, moveMemberPlan, { login: "bob-gh", to_team: "2" });
    expect(m.changes.map((c) => `${c.op} ${c.target}`)).toEqual(["remove_membership team:Team01/user:bob-gh", "add_membership team:Team02/user:bob-gh"]);
    expect(m.warnings[0]).toMatch(/Update the assignment tab/);
  });
});

async function readyOrg() {
  const made = await makeCtx();
  const { ctx, gh } = made;
  for (const l of ["alice-gh", "bob-gh", "carol-gh", "dave-gh", "erin-gh"]) gh.orgMembers.add(l);
  const t = await plan(ctx, teamsPlan, {});
  await applyPlan(ctx, teamsPlan, t.plan_id, t.confirm_code);
  const r = await plan(ctx, reposPlan, {});
  await applyPlan(ctx, reposPlan, r.plan_id, r.confirm_code);
  return made;
}

describe("repos", () => {
  it("creates repos from the track template with team, leader, ruleset and topics", async () => {
    const { ctx, gh } = await makeCtx();
    for (const l of ["alice-gh", "bob-gh", "carol-gh", "dave-gh", "erin-gh"]) gh.orgMembers.add(l);
    const t = await plan(ctx, teamsPlan, {});
    await applyPlan(ctx, teamsPlan, t.plan_id, t.confirm_code);

    const r = await plan(ctx, reposPlan, {});
    expect(r.changes.filter((c) => c.target.startsWith("repo:Team01")).map((c) => c.op)).toEqual(["create_repo", "set_team_permission", "set_collaborator", "create_ruleset", "set_topics"]);
    await applyPlan(ctx, reposPlan, r.plan_id, r.confirm_code);
    expect(gh.calls).toContain("createRepoFromTemplate");
    expect(gh.calls).toContain("createRepo");
    const team01 = gh.repos.get("Team01")!;
    expect(team01.teamPerms.get("team01")).toBe("push");
    expect(team01.collaborators.get("alice-gh")).toBe("maintain");
    expect(team01.topics).toEqual(["test-event"]);

    expect((await createPlan(ctx, reposPlan, {})).plan_id).toBeNull();
  });

  it("skips rulesets when the plan does not support them", async () => {
    const { ctx, gh } = await makeCtx();
    gh.rulesetsSupported = false;
    for (const l of ["alice-gh", "bob-gh", "carol-gh", "dave-gh", "erin-gh"]) gh.orgMembers.add(l);
    const t = await plan(ctx, teamsPlan, {});
    await applyPlan(ctx, teamsPlan, t.plan_id, t.confirm_code);
    const r = await plan(ctx, reposPlan, {});
    const out = await applyPlan(ctx, reposPlan, r.plan_id, r.confirm_code);
    expect(out.status).toBe("done");
    const again = await createPlan(ctx, reposPlan, {});
    expect(again.plan_id).toBeNull();
    expect(again.warnings.join("\n")).toMatch(/rulesets are not available/);
  });

  it("refuses a missing template before creating anything", async () => {
    const { ctx, gh } = await makeCtx();
    gh.templates.clear();
    await expect(createPlan(ctx, reposPlan, {})).rejects.toThrow(/Template repo test-org\/tpl-hackathon does not exist/);
  });
});

describe("deadline", () => {
  it("freezes: read-only team and leader, submission tag, optional archive; unfreeze restores", async () => {
    const { ctx, gh } = await readyOrg();
    const f = await plan(ctx, freezePlan, {});
    expect(f.changes.filter((c) => c.target.startsWith("repo:Team01")).map((c) => c.op)).toEqual(["set_team_permission", "set_collaborator", "create_tag"]);

    gh.repos.get("Team01")!.refs.set("heads/main", "sha-final");
    await applyPlan(ctx, freezePlan, f.plan_id, f.confirm_code);
    const repo = gh.repos.get("Team01")!;
    expect(repo.teamPerms.get("team01")).toBe("pull");
    expect(repo.collaborators.get("alice-gh")).toBe("pull");
    expect(repo.refs.get("tags/submission-test-event")).toBe("sha-final");

    const a = await plan(ctx, freezePlan, { archive: true });
    expect(a.changes.map((c) => c.op)).toEqual(["archive", "archive"]);
    await applyPlan(ctx, freezePlan, a.plan_id, a.confirm_code);

    const u = await plan(ctx, freezePlan, { unfreeze: true });
    expect(u.changes.filter((c) => c.target.startsWith("repo:Team01")).map((c) => c.op)).toEqual(["unarchive", "set_team_permission", "set_collaborator"]);
  });

  it("goes public except repos with secret-looking files, and handles archived repos", async () => {
    const { ctx, gh } = await readyOrg();
    gh.repos.get("Team02")!.tree = ["README.md", "server/.env"];
    gh.repos.get("Team01")!.archived = true;
    gh.repos.get("Team01")!.readme = "## 서비스 링크\nhttps://team01.example\n## 기술 스택\n";

    const p = await plan(ctx, visibilityPlan, { visibility: "public" });
    expect(p.changes.map((c) => `${c.op} ${c.target}`)).toEqual(["unarchive repo:Team01", "set_visibility repo:Team01", "archive repo:Team01"]);
    expect(p.info?.blocked).toEqual([{ repo: "Team02", files: [{ path: "server/.env", why: "environment file" }] }]);
    expect(p.info?.readme_gaps).toEqual([{ repo: "Team01", has_readme: true, missing: [], empty: ["기술 스택"] }]);

    await applyPlan(ctx, visibilityPlan, p.plan_id, p.confirm_code);
    expect(gh.repos.get("Team01")).toMatchObject({ visibility: "public", archived: true });

    const forced = await plan(ctx, visibilityPlan, { visibility: "public", force_repos: ["Team02"] });
    expect(forced.changes.map((c) => c.op)).toEqual(["set_visibility"]);
  });
});

describe("reviewers", () => {
  it("gives mentors read access to their teams only and judges to all, then revokes", async () => {
    const { ctx, gh } = await readyOrg();
    const g = await plan(ctx, reviewersPlan, { action: "grant" });
    expect(g.changes.map((c) => c.target)).toEqual(["repo:Team01/user:judge-gh", "repo:Team01/user:mentor-gh", "repo:Team02/user:judge-gh"]);
    expect(g.info?.links).toEqual([
      { name: "Mentor M", github_login: "mentor-gh", role: "mentor", repos: ["https://github.com/test-org/Team01"] },
      { name: "Judge J", github_login: "judge-gh", role: "judge", repos: ["https://github.com/test-org/Team01", "https://github.com/test-org/Team02"] },
    ]);
    await applyPlan(ctx, reviewersPlan, g.plan_id, g.confirm_code);
    expect(gh.calls.filter((c) => c === "setCollaborator").length).toBeGreaterThan(0);
    expect(gh.repos.get("Team01")!.invitations.map((i) => i.login).sort()).toEqual(["judge-gh", "mentor-gh"]);

    // Pending invitations are not re-sent.
    expect((await createPlan(ctx, reviewersPlan, { action: "grant" })).plan_id).toBeNull();

    // After accepting they are outside collaborators; revoke removes them.
    const team01 = gh.repos.get("Team01")!;
    team01.invitations = [];
    team01.outside.add("mentor-gh");
    team01.collaborators.set("mentor-gh", "pull");
    const r = await plan(ctx, reviewersPlan, { action: "revoke" });
    expect(r.changes.map((c) => `${c.op} ${c.target}`)).toEqual(["remove_collaborator repo:Team01/user:mentor-gh", "delete_invitation repo:Team02/invitation:judge-gh"]);
  });
});

describe("event close", () => {
  it("removes personal data from local state", async () => {
    const { ctx } = await readyOrg();
    expect(ctx.db.personalDataCounts().plans).toBeGreaterThan(0);
    const c = await plan(ctx, closePlan, {});
    await applyPlan(ctx, closePlan, c.plan_id, c.confirm_code);
    const counts = ctx.db.personalDataCounts();
    expect(counts.plans).toBe(0);
    expect(counts.audit_user_targets).toBe(0);
    expect(JSON.stringify(ctx.db.queryAudit({ limit: 1000 }))).not.toMatch(/alice-gh|bob-gh/);
  });
});
