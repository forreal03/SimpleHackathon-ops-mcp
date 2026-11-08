import { describe, expect, it } from "vitest";
import { buildRoster } from "../src/roster/roster.js";
import { parseEventYaml } from "../src/config/load.js";
import { defaultTables, EVENT_YAML, table } from "./helpers.js";

const cfg = parseEventYaml(EVENT_YAML);

describe("roster", () => {
  it("joins the tabs and resolves tracks, leaders and logins", () => {
    const t = defaultTables();
    const r = buildRoster(cfg, { participants: t.participants!, assignment: t.assignment!, githubIds: t.github_ids });
    expect(r.problems.filter((p) => p.severity === "error")).toEqual([]);
    expect(r.teams.map((x) => [x.team_no, x.team_name, x.track, x.template, x.leader?.name])).toEqual([
      ["01", "Team01", "hackathon", "test-org/tpl-hackathon", "Alice"],
      ["02", "Team02", "assignment", null, "Carol"],
    ]);
    expect(r.people.find((p) => p.name === "Bob")?.github_login).toBe("bob-gh");
    expect(r.people.find((p) => p.name === "Carol")?.github_login).toBe("carol-gh");
  });

  it("reports what the operator has to fix, without emails", () => {
    const t = defaultTables();
    const assignment = table("assignment", [
      ["팀 번호", "이메일", "역할", "트랙"],
      ["1", "alice@x.com", "조장", "해커톤"],
      ["1", "ghost@x.com", "", "해커톤"],
      ["2", "carol@x.com", "", "우주여행"],
      ["2", "alice@x.com", "", "우주여행"],
    ]);
    const githubIds = table("github_ids", [
      ["이메일 주소", "GitHub 아이디"],
      ["alice@x.com", "not valid!"],
    ]);
    const r = buildRoster(cfg, { participants: t.participants!, assignment, githubIds });
    const kinds = r.problems.map((p) => p.kind).sort();
    expect(kinds).toEqual(
      ["duplicate_assignment", "invalid_github_login", "leader_count", "missing_github_login", "not_in_participants_tab", "team_size", "team_size", "unassigned", "unknown_track"].sort(),
    );
    const text = JSON.stringify(r.problems);
    expect(text).not.toContain("ghost@x.com");
    expect(text).toContain("gh***@x.com");
  });

  it("names a missing column and lists the ones that exist", () => {
    const t = defaultTables();
    const bad = table("assignment", [["팀", "이메일"], ["1", "alice@x.com"]]);
    expect(() => buildRoster(cfg, { participants: t.participants!, assignment: bad })).toThrow(/no column "팀 번호".*Columns found: "팀", "이메일"/s);
  });
});
