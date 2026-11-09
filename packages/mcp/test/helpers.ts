import { parseEventYaml } from "../src/config/load.js";
import { AppPolicySchema } from "../src/config/schema.js";
import { openState } from "../src/state/db.js";
import type { Ctx } from "../src/plans/engine.js";
import type { Table } from "../src/roster/sources.js";
import { FakeGh } from "./fake-gh.js";

export const EVENT_YAML = `
event_id: test-event
write_delay_ms: 0
github:
  org: test-org
  team_name: "Team{team_no}"
roster:
  source: csv
  participants_tab: participants
  assignment_tab: assignment
  github_ids_tab: github_ids
  columns: { email: 이메일, name: 성함 }
  assignment_columns: { team_no: 팀 번호, email: 이메일, role: 역할, track: 트랙 }
  github_ids_columns: { email: 이메일 주소, github_login: GitHub 아이디 }
teams:
  size: [2, 4]
tracks:
  hackathon: { id: H, aliases: [해커톤], template: test-org/tpl-hackathon, teams: ["01"], freeze_at: "2026-11-14T10:00:00+09:00" }
  assignment: { id: A, aliases: [구현과제], teams: ["02"], freeze_at: "2026-11-14T09:00:00+09:00" }
repo:
  readme_required_sections: [서비스 링크, 기술 스택]
schedule:
  start_at: "2026-11-13T19:00:00+09:00"
  freeze_at: "2026-11-14T10:00:00+09:00"
`;

export function table(name: string, rows: string[][]): Table {
  const [headers = [], ...body] = rows;
  return { name, headers, rows: body.map((cells) => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""]))) };
}

export function defaultTables(): Record<string, Table> {
  return {
    participants: table("participants", [
      ["", "이메일", "성함"],
      ["t", "alice@x.com", "Alice"],
      ["t", "bob@x.com", "Bob"],
      ["t", "carol@x.com", "Carol"],
      ["t", "dave@x.com", "Dave"],
      ["t", "erin@x.com", "Erin"],
    ]),
    assignment: table("assignment", [
      ["팀 번호", "이메일", "역할", "트랙"],
      ["1", "alice@x.com", "조장", "해커톤"],
      ["1", "bob@x.com", "", "해커톤"],
      ["2", "carol@x.com", "leader", "구현과제"],
      ["2", "dave@x.com", "", "구현과제"],
      ["2", "erin@x.com", "", "구현과제"],
    ]),
    github_ids: table("github_ids", [
      ["이메일 주소", "GitHub 아이디"],
      ["alice@x.com", "alice-gh"],
      ["bob@x.com", "https://github.com/bob-gh"],
      ["carol@x.com", "@carol-gh"],
      ["dave@x.com", "dave-gh"],
      ["erin@x.com", "erin-gh"],
    ]),
  };
}

export async function makeCtx(opts: { tables?: Record<string, Table>; gh?: FakeGh; now?: () => Date } = {}) {
  const tables = opts.tables ?? defaultTables();
  const gh = opts.gh ?? new FakeGh();
  for (const login of ["alice-gh", "bob-gh", "carol-gh", "dave-gh", "erin-gh", "mentor-gh", "judge-gh"]) {
    if (!gh.users.has(login)) gh.addUser(login);
  }
  gh.templates.set("test-org/tpl-hackathon", true);
  const cfg = parseEventYaml(EVENT_YAML);
  const db = await openState(":memory:");
  const ctx: Ctx = {
    ev: { id: "test-event", dir: "/nonexistent", cfg, policy: AppPolicySchema.parse({ allow: ["vercel", "render"] }) },
    gh,
    db,
    actor: "tester",
    read: async (name) => {
      const t = tables[name];
      if (!t) throw new Error(`no table ${name}`);
      return t;
    },
    now: opts.now,
  };
  return { ctx, gh, tables };
}
