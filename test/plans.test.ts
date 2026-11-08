import { describe, expect, it } from "vitest";
import { applyPlan, createPlan } from "../src/plans/engine.js";
import { teamsPlan, moveMemberPlan } from "../src/plans/teams.js";
import { reposPlan } from "../src/plans/repos.js";
import { freezePlan } from "../src/plans/freeze.js";
import { visibilityPlan } from "../src/plans/visibility.js";
import { reviewerRemove, reviewersPlan, reviewerSet } from "../src/plans/reviewers.js";
import { closePlan } from "../src/plans/close.js";
import { orgSettingsPlan } from "../src/plans/orgsettings.js";
import { loadRoster } from "../src/roster/roster.js";
import { TabMissingError } from "../src/roster/sources.js";
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

describe("deadline lock", () => {
  it("lowers every team, person and invitation to read, tags, and unfreeze puts back exactly what was there", async () => {
    const { ctx, gh } = await readyOrg();
    const repo = gh.repos.get("Team01")!;
    repo.collaborators.set("helper", "push"); // access someone granted by hand
    gh.users.set("helper", { id: 900, login: "helper", type: "User" });
    gh.owners.add("boss");
    repo.collaborators.set("boss", "admin"); // org owner: GitHub will not lower it
    repo.invitations.push({ id: 77, login: "late-joiner", email: null, permission: "push" });

    const f = await plan(ctx, freezePlan, {});
    expect(f.changes.filter((c) => c.target.startsWith("repo:Team01")).map((c) => `${c.op} ${c.target}`)).toEqual([
      "lower_team repo:Team01/team:team01",
      "lower_user repo:Team01/user:alice-gh",
      "lower_user repo:Team01/user:helper",
      "lower_invitation repo:Team01/invitation:77",
      "create_tag repo:Team01/tag",
    ]);
    expect(f.warnings.join("\n")).toMatch(/Org owners \(1\) keep admin/);

    repo.refs.set("heads/main", "sha-final");
    await applyPlan(ctx, freezePlan, f.plan_id, f.confirm_code);
    expect(repo.teamPerms.get("team01")).toBe("pull");
    expect(repo.collaborators.get("alice-gh")).toBe("pull");
    expect(repo.collaborators.get("helper")).toBe("pull");
    expect(repo.collaborators.get("boss")).toBe("admin");
    expect(repo.invitations[0]!.permission).toBe("pull");
    expect(repo.refs.get("tags/submission-test-event")).toBe("sha-final");

    // A second freeze has nothing left to do and must not overwrite the saved permissions.
    expect((await createPlan(ctx, freezePlan, { tag: false })).plan_id).toBeNull();

    const u = await plan(ctx, freezePlan, { unfreeze: true });
    await applyPlan(ctx, freezePlan, u.plan_id, u.confirm_code);
    expect(repo.teamPerms.get("team01")).toBe("push");
    expect(repo.collaborators.get("alice-gh")).toBe("maintain");
    expect(repo.collaborators.get("helper")).toBe("push");
    expect(repo.invitations[0]!.permission).toBe("push");
    expect(ctx.db.snapshots()).toEqual([]);
  });

  it("locks one track at a time", async () => {
    const { ctx, gh } = await readyOrg();
    const f = await plan(ctx, freezePlan, { track: "assignment", tag: false });
    expect([...new Set(f.changes.map((c) => c.target.split("/")[0]))]).toEqual(["repo:Team02"]);
    expect(f.info?.repos).toEqual([{ repo: "Team02", team_no: "02", track: "assignment", deadline: "2026-11-14T09:00:00+09:00" }]);
    await applyPlan(ctx, freezePlan, f.plan_id, f.confirm_code);
    expect(gh.repos.get("Team01")!.teamPerms.get("team01")).toBe("push");
    expect(gh.repos.get("Team02")!.teamPerms.get("team02")).toBe("pull");
    await expect(createPlan(ctx, freezePlan, { track: "nope" })).rejects.toThrow(/Unknown track "nope"/);
  });

  it("archives on request and unarchives on unfreeze", async () => {
    const { ctx, gh } = await readyOrg();
    const f = await plan(ctx, freezePlan, { team_nos: ["1"], archive: true, tag: false });
    expect(f.changes.map((c) => c.op)).toEqual(["lower_team", "lower_user", "archive"]);
    await applyPlan(ctx, freezePlan, f.plan_id, f.confirm_code);
    expect(gh.repos.get("Team01")!.archived).toBe(true);
    const u = await plan(ctx, freezePlan, { team_nos: ["01"], unfreeze: true });
    expect(u.changes.map((c) => c.op)).toEqual(["unarchive", "restore_team", "restore_user"]);
  });

  it("goes public except repos with secret-looking files, and handles archived repos", async () => {
    const { ctx, gh } = await readyOrg();
    ctx.now = () => new Date("2026-11-15T00:00:00Z");
    gh.repos.get("Team02")!.tree = ["README.md", "server/.env"];
    gh.repos.get("Team01")!.archived = true;
    gh.repos.get("Team01")!.readme = "## 서비스 링크\nhttps://team01.example\n## 기술 스택\n";

    const p = await plan(ctx, visibilityPlan, { visibility: "public" });
    expect(p.changes.map((c) => `${c.op} ${c.target}`)).toEqual(["unarchive repo:Team01", "set_visibility repo:Team01", "archive repo:Team01"]);
    expect(p.info?.blocked).toEqual([{ repo: "Team02", files: [{ path: "server/.env", why: "environment file" }] }]);
    expect(p.info?.readme_gaps).toEqual([{ repo: "Team01", has_readme: true, missing: [], empty: ["기술 스택"] }]);

    await applyPlan(ctx, visibilityPlan, p.plan_id, p.confirm_code);
    expect(gh.repos.get("Team01")).toMatchObject({ visibility: "public", archived: true });

    const forced = await plan(ctx, visibilityPlan, { visibility: "public", track: "assignment", force_repos: ["Team02"] });
    expect(forced.changes.map((c) => `${c.op} ${c.target}`)).toEqual(["set_visibility repo:Team02"]);
  });

  it("flags late pushes, force pushes, early work and one-person repos", async () => {
    const { ctx, gh } = await readyOrg();
    const repo = gh.repos.get("Team02")!;
    repo.commits = [
      { sha: "c3", date: "2026-11-14T00:30:00Z", author_login: "carol-gh", author_key: "carol-gh", parents: 1 },
      { sha: "c2", date: "2026-11-13T12:00:00Z", author_login: "carol-gh", author_key: "carol-gh", parents: 1 },
      { sha: "c1", date: "2026-10-01T00:00:00Z", author_login: "carol-gh", author_key: "carol-gh", parents: 1 },
      { sha: "c0", date: "2026-09-30T00:00:00Z", author_login: null, author_key: "x", parents: 0 },
    ];
    gh.activity.set("Team02", [
      { type: "push", timestamp: "2026-11-14T00:30:05Z", actor: "carol-gh", ref: "refs/heads/main" },
      { type: "force_push", timestamp: "2026-11-13T13:00:00Z", actor: "carol-gh", ref: "refs/heads/main" },
    ]);
    const { reposActivity } = await import("../src/ops/read.js");
    const out = await reposActivity(ctx, { track: "assignment" });
    const r = out.repos[0]!;
    expect(r.deadline).toBe("2026-11-14T09:00:00+09:00");
    expect(r.by_commit_date).toEqual({ early: 1, preparation: null, during_event: 1, after_deadline: 1 });
    expect(r.flags).toEqual([
      "1 commit(s) dated before the start: check for work made in advance (e.g. a capstone project)",
      "1 push(es) after the assignment deadline (server time)",
      "1 force push(es): history was rewritten",
      "all commits come from one person",
    ]);
  });
});

describe("mentors and judges", () => {
  it("mentors see their team, judges everything, only private repos, and scope is a toggle", async () => {
    const { ctx, gh } = await readyOrg();
    await reviewerSet(ctx, { github_login: "mentor-gh", name: "Mentor M", role: "mentor", teams: ["1"] });
    await reviewerSet(ctx, { github_login: "@judge-gh", name: "Judge J", role: "judge" });
    gh.repos.get("Team02")!.visibility = "public";

    const s = await plan(ctx, reviewersPlan, { action: "sync" });
    expect(s.changes.map((c) => c.target)).toEqual(["repo:Team01/user:judge-gh", "repo:Team01/user:mentor-gh"]);
    await applyPlan(ctx, reviewersPlan, s.plan_id, s.confirm_code);
    expect(gh.repos.get("Team01")!.invitations.map((i) => i.login).sort()).toEqual(["judge-gh", "mentor-gh"]);
    expect((await createPlan(ctx, reviewersPlan, { action: "sync" })).plan_id).toBeNull();

    // Toggle the mentor to every repo: Team02 goes back to private, so they get it.
    gh.repos.get("Team02")!.visibility = "private";
    await reviewerSet(ctx, { github_login: "mentor-gh", role: "mentor", scope: "all" });
    const toggled = await plan(ctx, reviewersPlan, { action: "sync" });
    expect(toggled.changes.map((c) => c.target)).toEqual(["repo:Team02/user:judge-gh", "repo:Team02/user:mentor-gh"]);

    // Accepted invitations become outside collaborators; removing the mentor takes access away.
    const team01 = gh.repos.get("Team01")!;
    team01.invitations = team01.invitations.filter((i) => i.login !== "mentor-gh");
    team01.outside.add("mentor-gh");
    await reviewerRemove(ctx, { github_login: "mentor-gh" });
    const removed = await plan(ctx, reviewersPlan, { action: "sync" });
    expect(removed.changes.map((c) => `${c.op} ${c.target}`)).toEqual(["add_collaborator repo:Team02/user:judge-gh", "remove_collaborator repo:Team01/user:mentor-gh"]);

    const all = await plan(ctx, reviewersPlan, { action: "revoke_all" });
    expect(all.changes.map((c) => c.op).sort()).toEqual(["delete_invitation", "remove_collaborator"]);
  });

  it("refuses a mentor without teams and unknown team numbers", async () => {
    const { ctx } = await readyOrg();
    await expect(reviewerSet(ctx, { github_login: "mentor-gh", role: "mentor" })).rejects.toThrow(/give the team numbers/);
    await expect(reviewerSet(ctx, { github_login: "mentor-gh", role: "mentor", teams: ["09"] })).rejects.toThrow(/No repo for team\(s\) 09/);
    await expect(reviewerSet(ctx, { github_login: "nobody-here", role: "judge" })).rejects.toThrow(/does not exist/);
  });
});

describe("roster before teams exist", () => {
  it("reports participants when the assignment tab is not there yet, and blocks team plans", async () => {
    const { ctx, tables } = await makeCtx();
    const read = ctx.read!;
    ctx.read = async (name) => {
      if (name === "assignment" || name === "github_ids") throw new TabMissingError(name, "missing");
      return read(name);
    };
    delete tables.assignment;
    const roster = await loadRoster(ctx.ev, ctx.read);
    expect(roster.registered).toBe(5);
    expect(roster.teams).toEqual([]);
    expect(roster.problems.map((p) => p.kind)).toEqual(["assignment_tab_missing", "github_ids_tab_missing"]);
    await expect(createPlan(ctx, teamsPlan, {})).rejects.toThrow(/no "assignment" tab yet/);
  });
});

describe("org settings", () => {
  it("changes API settings and reports who 2FA enforcement would remove", async () => {
    const { ctx, gh } = await makeCtx();
    gh.orgInfo.members_can_create_repositories = true;
    gh.orgInfo.two_factor_requirement_enabled = false;
    gh.without2fa = ["no2fa-a", "no2fa-b"];

    const p = await plan(ctx, orgSettingsPlan, { members_can_create_repositories: false, default_repository_permission: "none", require_two_factor: true });
    expect(p.changes.map((c) => c.summary)).toEqual(["members_can_create_repositories: true -> false"]);
    const tfa = p.info?.two_factor as { members_without_2fa: string[]; effect: string; how: string };
    expect(tfa.members_without_2fa).toEqual(["no2fa-a", "no2fa-b"]);
    expect(tfa.effect).toMatch(/REMOVES these 2 people/);
    expect(tfa.how).toMatch(/no API/);

    await applyPlan(ctx, orgSettingsPlan, p.plan_id, p.confirm_code);
    expect(gh.orgInfo.members_can_create_repositories).toBe(false);

    const only2fa = await createPlan(ctx, orgSettingsPlan, { require_two_factor: false });
    expect(only2fa.plan_id).toBeNull();
    expect((only2fa as { info?: { two_factor: { effect: string } } }).info?.two_factor.effect).toMatch(/Already not required/);
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
