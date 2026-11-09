import { describe, expect, it } from "vitest";
import { applyPlan, createPlan } from "../src/plans/engine.js";
import { teamsPlan } from "../src/plans/teams.js";
import { makeCtx } from "./helpers.js";

type Planned = { plan_id: string; confirm_code: string; changes: { op: string; target: string; summary: string }[]; warnings: string[] };
const plan = async (...args: Parameters<typeof createPlan>) => (await createPlan(...args)) as unknown as Planned;

describe("team leaders", () => {
  it("adds the leader as team maintainer and everyone else as member", async () => {
    const { ctx, gh } = await makeCtx();
    for (const l of ["alice-gh", "bob-gh", "carol-gh", "dave-gh", "erin-gh"]) gh.orgMembers.add(l);
    const p = await plan(ctx, teamsPlan, {});
    expect(p.changes.find((c) => c.target === "team:Team01/user:alice-gh")?.summary).toMatch(/as maintainer \(leader\)/);
    await applyPlan(ctx, teamsPlan, p.plan_id, p.confirm_code);
    expect([...gh.teamMaintainers.get("team01")!]).toEqual(["alice-gh"]);
    expect([...gh.teamMaintainers.get("team02")!]).toEqual(["carol-gh"]);
    expect((await createPlan(ctx, teamsPlan, {})).plan_id).toBeNull();
  });

  it("invites a leader as member, then promotes them once they accepted", async () => {
    const { ctx, gh } = await makeCtx();
    const p = await plan(ctx, teamsPlan, {});
    expect(p.warnings.join(" ")).toMatch(/Leader Alice \(@alice-gh\) is invited as a member; run teams_plan again/);
    await applyPlan(ctx, teamsPlan, p.plan_id, p.confirm_code);

    // Alice accepts: she is now an org member and a plain member of Team01.
    gh.invitations = gh.invitations.filter((i) => i.login !== "alice-gh");
    gh.orgMembers.add("alice-gh");
    gh.teamMembers.get("team01")!.add("alice-gh");
    const again = await plan(ctx, teamsPlan, {});
    expect(again.changes.map((c) => `${c.op} ${c.target}`)).toEqual(["set_team_role team:Team01/user:alice-gh"]);
    await applyPlan(ctx, teamsPlan, again.plan_id, again.confirm_code);
    expect(gh.teamMaintainers.get("team01")!.has("alice-gh")).toBe(true);
  });

  it("moves the maintainer role when the sheet names another leader", async () => {
    const { ctx, gh, tables } = await makeCtx();
    for (const l of ["alice-gh", "bob-gh", "carol-gh", "dave-gh", "erin-gh"]) gh.orgMembers.add(l);
    const p = await plan(ctx, teamsPlan, {});
    await applyPlan(ctx, teamsPlan, p.plan_id, p.confirm_code);

    for (const row of tables.assignment!.rows) if (row["팀 번호"] === "1") row["역할"] = row["이메일"] === "bob@x.com" ? "조장" : "";
    const swap = await plan(ctx, teamsPlan, {});
    expect(swap.changes.map((c) => c.summary)).toEqual([
      "Make Alice (@alice-gh) a regular member of Team01 (not the leader)",
      "Make leader Bob (@bob-gh) a maintainer of Team01",
    ]);
  });

  it("keeps leaders as members when leader_team_role is member", async () => {
    const { ctx, gh } = await makeCtx();
    ctx.ev.cfg.github.leader_team_role = "member";
    for (const l of ["alice-gh", "bob-gh", "carol-gh", "dave-gh", "erin-gh"]) gh.orgMembers.add(l);
    const p = await plan(ctx, teamsPlan, {});
    await applyPlan(ctx, teamsPlan, p.plan_id, p.confirm_code);
    expect(gh.teamMaintainers.get("team01")?.size ?? 0).toBe(0);
  });
});
