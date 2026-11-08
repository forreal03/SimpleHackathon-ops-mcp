import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEvent } from "../src/config/load.js";
import { describeSchedule, setSchedule, toEventTime } from "../src/ops/schedule.js";
import { reposActivity } from "../src/ops/read.js";
import { freezePlan } from "../src/plans/freeze.js";
import { createPlan } from "../src/plans/engine.js";
import { EVENT_YAML, makeCtx } from "./helpers.js";

const home = mkdtempSync(path.join(tmpdir(), "hackathon-ops-schedule-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

function eventOnDisk() {
  process.env.HACKATHON_OPS_HOME = home;
  const dir = path.join(home, "events", "test-event");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "event.yaml"), "# my comment\ntimezone: Asia/Seoul\n" + EVENT_YAML);
  return { file: path.join(dir, "event.yaml"), ev: loadEvent("test-event") };
}

describe("schedule_set", () => {
  it("reads local times in the event time zone", () => {
    expect(toEventTime("2026-11-14 10:00", "Asia/Seoul")).toBe("2026-11-14T10:00:00+09:00");
    expect(toEventTime("2026-11-04", "Asia/Seoul")).toBe("2026-11-04T00:00:00+09:00");
    expect(toEventTime("2026-11-14T01:00:00Z", "Asia/Seoul")).toBe("2026-11-14T01:00:00Z");
    expect(() => toEventTime("next friday", "Asia/Seoul")).toThrow(/not a date/);
  });

  it("toggles the preparation period and deadlines, per track too, keeping comments", () => {
    const { file, ev } = eventOnDisk();
    const out = setSchedule(ev, { prep_enabled: true, prep_from: "2026-11-04 00:00" });
    expect(out.changed).toEqual(["schedule.prep_enabled = true", "schedule.prep_from = 2026-11-04T00:00:00+09:00"]);
    expect(out.schedule.preparation).toMatchObject({ enabled: true, from: "2026-11-04T00:00:00+09:00" });

    const t = setSchedule(loadEvent("test-event"), { track: "hackathon", freeze_enabled: false });
    expect(t.schedule.tracks.hackathon).toMatchObject({ deadline_enabled: false, deadline: null });
    expect(t.schedule.tracks.assignment).toMatchObject({ deadline_enabled: true, deadline: "2026-11-14T09:00:00+09:00" });

    setSchedule(loadEvent("test-event"), { track: "assignment", freeze_at: "2026-11-14 11:30" });
    const text = readFileSync(file, "utf8");
    expect(text).toContain("# my comment");
    expect(describeSchedule(loadEvent("test-event").cfg).tracks.assignment.deadline).toBe("2026-11-14T11:30:00+09:00");
  });

  it("refuses dates in the wrong order and event-wide fields with a track", () => {
    const { ev } = eventOnDisk();
    expect(() => setSchedule(ev, { prep_enabled: true, prep_from: "2026-11-20 00:00" })).toThrow(/prep_from must be before start_at/);
    expect(() => setSchedule(ev, { freeze_at: "2026-11-01 00:00" })).toThrow(/must be after start_at/);
    expect(() => setSchedule(ev, { track: "hackathon", prep_enabled: true })).toThrow(/event-wide/);
    expect(() => setSchedule(ev, { track: "nope", freeze_enabled: false })).toThrow(/Unknown track/);
  });
});

describe("preparation period and deadline toggles in the checks", () => {
  async function withCommits() {
    const made = await makeCtx();
    made.gh.addRepo("Team02", {
      commits: [
        { sha: "late", date: "2026-11-14T00:30:00Z", author_login: "carol-gh", author_key: "carol-gh", parents: 1 },
        { sha: "prep", date: "2026-11-05T00:00:00Z", author_login: "dave-gh", author_key: "dave-gh", parents: 1 },
        { sha: "old", date: "2026-10-01T00:00:00Z", author_login: "carol-gh", author_key: "carol-gh", parents: 1 },
        { sha: "root", date: "2026-09-30T00:00:00Z", author_login: null, author_key: "x", parents: 0 },
      ],
    });
    made.gh.activity.set("Team02", [{ type: "push", timestamp: "2026-11-14T00:30:05Z", actor: "carol-gh", ref: "refs/heads/main" }]);
    return made;
  }

  it("off: everything before the start is early", async () => {
    const { ctx } = await withCommits();
    const r = (await reposActivity(ctx, { track: "assignment" })).repos[0]!;
    expect(r.by_commit_date).toMatchObject({ early: 2, preparation: null });
  });

  it("on with a start date: only commits before it are early", async () => {
    const { ctx } = await withCommits();
    ctx.ev.cfg.schedule.prep_enabled = true;
    ctx.ev.cfg.schedule.prep_from = "2026-11-04T00:00:00+09:00";
    const r = (await reposActivity(ctx, { track: "assignment" })).repos[0]!;
    expect(r.by_commit_date).toMatchObject({ early: 1, preparation: 1 });
    expect(r.flags[0]).toMatch(/before the preparation period/);
  });

  it("on without a start date: nothing before the start is flagged", async () => {
    const { ctx } = await withCommits();
    ctx.ev.cfg.schedule.prep_enabled = true;
    const r = (await reposActivity(ctx, { track: "assignment" })).repos[0]!;
    expect(r.by_commit_date).toMatchObject({ early: 0, preparation: 2 });
  });

  it("deadline off for a track: no late-push flags, locking still allowed", async () => {
    const { ctx } = await withCommits();
    ctx.ev.cfg.tracks.assignment!.freeze_enabled = false;
    const r = (await reposActivity(ctx, { track: "assignment" })).repos[0]!;
    expect(r.deadline).toBeNull();
    expect(r.flags.join(" ")).not.toMatch(/after the/);
    const plan = await createPlan(ctx, freezePlan, { track: "assignment", tag: false });
    expect(plan.warnings.join(" ")).not.toMatch(/before the deadline/);
  });

  it("warns when locking before the deadline", async () => {
    const { ctx } = await withCommits();
    ctx.now = () => new Date("2026-11-13T23:00:00Z");
    ctx.gh.repos.get("Team02")!.teamPerms.set("team02", "push");
    const plan = await createPlan(ctx, freezePlan, { track: "assignment", tag: false });
    expect(plan.warnings.join(" ")).toMatch(/Locking before the deadline \(2026-11-14T09:00:00\+09:00\)/);
  });
});
