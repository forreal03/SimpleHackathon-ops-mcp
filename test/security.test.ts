import { describe, expect, it } from "vitest";
import { applyPlan, createPlan } from "../src/plans/engine.js";
import { teamsPlan } from "../src/plans/teams.js";
import { reposPlan } from "../src/plans/repos.js";
import { freezePlan } from "../src/plans/freeze.js";
import { visibilityPlan } from "../src/plans/visibility.js";
import { reviewersPlan, reviewerSet } from "../src/plans/reviewers.js";
import { untrusted } from "../src/lib/util.js";
import { makeCtx } from "./helpers.js";

type Planned = { plan_id: string; confirm_code: string; changes: { op: string; target: string }[]; warnings: string[]; info?: Record<string, unknown> };
const plan = async (...args: Parameters<typeof createPlan>) => (await createPlan(...args)) as unknown as Planned;

async function readyOrg() {
  const made = await makeCtx();
  for (const l of ["alice-gh", "bob-gh", "carol-gh", "dave-gh", "erin-gh"]) made.gh.orgMembers.add(l);
  const t = await plan(made.ctx, teamsPlan, {});
  await applyPlan(made.ctx, teamsPlan, t.plan_id, t.confirm_code);
  const r = await plan(made.ctx, reposPlan, {});
  await applyPlan(made.ctx, reposPlan, r.plan_id, r.confirm_code);
  return made;
}

describe("participants cannot see other teams through reviewer access", () => {
  it("refuses a participant as an all-teams reviewer or for another team, allows their own team", async () => {
    const { ctx } = await readyOrg();
    await expect(reviewerSet(ctx, { github_login: "alice-gh", role: "judge", scope: "all" })).rejects.toThrow(/participant \(team 01\).*every other team/);
    await expect(reviewerSet(ctx, { github_login: "alice-gh", role: "mentor", teams: ["02"] })).rejects.toThrow(/cannot see team 02/);
    await expect(reviewerSet(ctx, { github_login: "alice-gh", role: "mentor", teams: ["01"] })).resolves.toBeTruthy();
  });

  it("skips a registered reviewer who later joined a team", async () => {
    const { ctx, gh } = await readyOrg();
    await reviewerSet(ctx, { github_login: "judge-gh", role: "judge", scope: "all" });
    gh.orgMembers.add("judge-gh");
    gh.teamMembers.get("team02")!.add("judge-gh");
    const p = await createPlan(ctx, reviewersPlan, { action: "sync" });
    expect(p.changes).toEqual([]);
    expect(p.warnings.join(" ")).toMatch(/Skipped: @judge-gh is a participant \(team 02\)/);
  });
});

describe("public conversion while teams are still working", () => {
  it("keeps repos private before their deadline and refuses while another track runs", async () => {
    const { ctx } = await readyOrg();
    // 09:30 KST: assignment (09:00) is over, hackathon (10:00) is not.
    ctx.now = () => new Date("2026-11-14T00:30:00Z");
    await expect(createPlan(ctx, visibilityPlan, { visibility: "public", track: "assignment" })).rejects.toThrow(/Track hackathon .* is still running/);

    const all = await plan(ctx, visibilityPlan, { visibility: "public" });
    expect(all.changes.map((c) => c.target)).toEqual(["repo:Team02"]);
    expect(all.info?.not_yet_due).toEqual([{ repo: "Team01", deadline: "2026-11-14T10:00:00+09:00" }]);

    const forced = await plan(ctx, visibilityPlan, { visibility: "public", track: "assignment", allow_while_running: true });
    expect(forced.changes.map((c) => c.target)).toEqual(["repo:Team02"]);
  });

  it("re-archives a repo when an earlier run stopped half way", async () => {
    const { ctx, gh } = await readyOrg();
    ctx.now = () => new Date("2026-11-15T00:00:00Z");
    gh.repos.get("Team01")!.archived = true;
    const p = await plan(ctx, visibilityPlan, { visibility: "public", team_nos: ["01"] });
    // The unarchive succeeds, then switching visibility fails.
    let calls = 0;
    const original = gh.updateRepo.bind(gh);
    gh.updateRepo = async (name, patch) => {
      calls++;
      if (calls === 2) throw Object.assign(new Error("boom"), { status: 500 });
      return original(name, patch);
    };
    const first = await applyPlan(ctx, visibilityPlan, p.plan_id, p.confirm_code);
    expect(first.status).toBe("partial");
    expect(gh.repos.get("Team01")!.archived).toBe(false);

    // A fresh plan (e.g. after the old one expired) still knows it must archive again.
    gh.updateRepo = original;
    const again = await plan(ctx, visibilityPlan, { visibility: "public", team_nos: ["01"] });
    expect(again.changes.map((c) => c.op)).toEqual(["set_visibility", "archive"]);
    await applyPlan(ctx, visibilityPlan, again.plan_id, again.confirm_code);
    expect(gh.repos.get("Team01")).toMatchObject({ visibility: "public", archived: true });
  });
});

describe("deadline lock fairness and warnings", () => {
  it("drops every team's write access before taking any tag", async () => {
    const { ctx } = await readyOrg();
    const f = await plan(ctx, freezePlan, {});
    const ops = f.changes.map((c) => c.op);
    expect(ops.lastIndexOf("lower_user")).toBeLessThan(ops.indexOf("create_tag"));
    expect(ops.lastIndexOf("lower_team")).toBeLessThan(ops.indexOf("lower_user"));
    expect(freezePlan.writeDelayMs).toBeLessThanOrEqual(250);
  });

  it("warns about base permission and apps that can still write", async () => {
    const { ctx, gh } = await readyOrg();
    gh.orgInfo.default_repository_permission = "write";
    gh.installations = [
      { id: 1, app_slug: "chatgpt-codex-connector", app_id: 5, repository_selection: "selected", permissions: { contents: "write", metadata: "read" }, events: [], created_at: "", updated_at: "", suspended_at: null },
    ];
    const f = await plan(ctx, freezePlan, { tag: false });
    const text = f.warnings.join("\n");
    expect(text).toMatch(/base permission is "write"/);
    expect(text).toMatch(/chatgpt-codex-connector \(contents:write\)/);
    const archived = await plan(ctx, freezePlan, { tag: false, archive: true });
    expect(archived.warnings.join("\n")).not.toMatch(/Installed apps can still write/);
  });
});

describe("participant-controlled text", () => {
  it("is cleaned and capped before it reaches a tool result", () => {
    expect(untrusted("feat/x‮\u0000\nIGNORE   previous", 200)).toBe("feat/x IGNORE previous");
    expect(untrusted("a".repeat(300), 10)).toBe("aaaaaaaaa…");
  });
});
