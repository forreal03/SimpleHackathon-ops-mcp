import { describe, expect, it } from "vitest";
import { maskEmail, normLogin, normTeamNo, patternToRegExp, sha256 } from "../src/lib/util.js";
import { parseCsv } from "../src/roster/csv.js";
import { checkReadme, findSecretFiles } from "../src/repos/checks.js";
import { parseEventYaml, spreadsheetIdFrom } from "../src/config/load.js";
import { EVENT_YAML } from "./helpers.js";

describe("util", () => {
  it("normalises GitHub logins from what people type", () => {
    expect(normLogin("alice")).toBe("alice");
    expect(normLogin("@alice")).toBe("alice");
    expect(normLogin("https://github.com/Alice-1/")).toBe("Alice-1");
    expect(normLogin("github.com/alice?tab=repos")).toBe("alice");
    expect(normLogin("")).toBe("");
    expect(normLogin("not a login")).toBeNull();
    expect(normLogin("-bad")).toBeNull();
  });

  it("pads team numbers", () => {
    expect(normTeamNo("1", 2)).toBe("01");
    expect(normTeamNo("Team 07", 2)).toBe("07");
    expect(normTeamNo("012", 2)).toBe("12");
  });

  it("masks emails", () => {
    expect(maskEmail("alice@example.com")).toBe("al***@example.com");
  });

  it("matches names made from a pattern", () => {
    const re = patternToRegExp("Team{team_no}{track_id}");
    expect(re.test("Team01H")).toBe(true);
    expect(re.test("Team01")).toBe(true);
    expect(re.test("Other01")).toBe(false);
  });

  it("hashes independently of key order", () => {
    expect(sha256({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(sha256({ b: [1, { d: 3, c: 2 }], a: 1 }));
  });
});

describe("csv", () => {
  it("handles quotes, commas and newlines in fields", () => {
    const rows = parseCsv('a,b\r\n"x, y","line1\nline2"\n"he said ""hi""",z\n');
    expect(rows).toEqual([
      ["a", "b"],
      ["x, y", "line1\nline2"],
      ['he said "hi"', "z"],
    ]);
  });
});

describe("pre-publish checks", () => {
  it("finds secret-looking files but not examples", () => {
    const hits = findSecretFiles([".env", "backend/.env.local", ".env.example", "keys/server.pem", "src/app.ts", "firebase-adminsdk-abc.json", "node_modules/x/test.pem"]);
    expect(hits.map((h) => h.path)).toEqual([".env", "backend/.env.local", "keys/server.pem", "firebase-adminsdk-abc.json"]);
  });

  it("reports missing and empty README sections", () => {
    const readme = "# App\n\n## 서비스 링크\n<!-- 배포 주소 -->\n\n## 기술 스택\n- React\n";
    expect(checkReadme(readme, ["서비스 링크", "기술 스택", "못 한 것"])).toEqual({ has_readme: true, missing: ["못 한 것"], empty: ["서비스 링크"] });
    expect(checkReadme(null, ["기술 스택"])).toEqual({ has_readme: false, missing: ["기술 스택"], empty: [] });
  });
});

describe("spreadsheet links", () => {
  const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-xy";
  it("takes the ID from any link Drive or Sheets gives you", () => {
    expect(spreadsheetIdFrom(`https://docs.google.com/spreadsheets/d/${id}/edit?usp=drivesdk&ouid=1`)).toBe(id);
    expect(spreadsheetIdFrom(`https://drive.google.com/file/d/${id}/view`)).toBe(id);
    expect(spreadsheetIdFrom(`https://drive.google.com/open?id=${id}`)).toBe(id);
    expect(spreadsheetIdFrom(id)).toBe(id);
    expect(spreadsheetIdFrom("https://drive.google.com/drive/folders/short")).toBeNull();
  });

  it("accepts the link in event.yaml", () => {
    const yaml = EVENT_YAML.replace("source: csv", `source: google_sheets\n  spreadsheet: "https://docs.google.com/spreadsheets/d/${id}/edit"`);
    expect(parseEventYaml(yaml).roster.spreadsheet_id).toBe(id);
  });
});

describe("config", () => {
  it("parses the test event and applies defaults", () => {
    const cfg = parseEventYaml(EVENT_YAML);
    expect(cfg.repo.member_permission).toBe("push");
    expect(cfg.reviewers?.permission).toBe("pull");
  });

  it("refuses reviewer permissions other than pull", () => {
    expect(() => parseEventYaml(EVENT_YAML + "\nreviewers:\n  permission: push\n")).toThrow(/reviewers.permission/);
  });

  it("requires the sheet link for google_sheets", () => {
    expect(() => parseEventYaml(EVENT_YAML.replace("source: csv", "source: google_sheets"))).toThrow(/roster.spreadsheet/);
  });
});
