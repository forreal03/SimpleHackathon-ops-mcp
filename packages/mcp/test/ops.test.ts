import { afterEach, describe, expect, it } from "vitest";
import { appsDrift, decideApp, ingestRequests } from "../src/ops/apps.js";
import { makeCtx } from "./helpers.js";

const body = (app: string, slug: string, user: string, req: number) => `You’re receiving this email because @${user} has requested the
installation of ${app} at your organization test-org.

https://github.com/apps/${slug}/installations/new/permissions?request_id=${req}&target_id=4242
`;
const email = (app: string, slug: string, user: string, req: number) => ({
  sender: "noreply@github.com",
  subject: `Request to install ${app} in test-org`,
  body: body(app, slug, user, req),
  date: `2026-11-08T10:0${req % 10}:00Z`,
});

async function withApps() {
  const made = await makeCtx();
  made.gh.apps.set("vercel", { slug: "vercel", name: "Vercel", owner_login: "vercel", owner_type: "Organization", html_url: "https://github.com/apps/vercel", permissions: { administration: "write", contents: "write", metadata: "read" }, events: [] });
  made.gh.apps.set("chatgpt-codex-connector", { slug: "chatgpt-codex-connector", name: "ChatGPT Codex Connector", owner_login: "openai", owner_type: "Organization", html_url: "", permissions: { contents: "write", workflows: "write" }, events: [] });
  return made;
}

afterEach(() => {
  delete process.env.GITHUB_APP_ID;
});

describe("app requests from email", () => {
  it("groups repeated emails per app, matches requesters to teams and rates each app", async () => {
    const { ctx } = await withApps();
    const out = await ingestRequests(ctx, [
      email("Vercel", "vercel", "alice-gh", 1),
      email("ChatGPT Codex Connector", "chatgpt-codex-connector", "alice-gh", 2),
      email("ChatGPT Codex Connector", "chatgpt-codex-connector", "alice-gh", 3),
      email("ChatGPT Codex Connector", "chatgpt-codex-connector", "stranger", 4),
      { ...email("Vercel", "vercel", "alice-gh", 5), sender: "attacker@example.com" },
    ]);
    expect(out.accepted).toBe(4);
    expect(out.rejected).toHaveLength(1);
    const codex = out.apps.find((a) => a.app_slug === "chatgpt-codex-connector")!;
    expect(codex.tier).toBe("review2");
    expect(codex.requesters).toEqual([
      expect.objectContaining({ requester: "alice-gh", in_roster: true, team: { team_no: "01", repo: "Team01" }, emails: 2 }),
      expect.objectContaining({ requester: "stranger", in_roster: false, emails: 1 }),
    ]);
    expect(out.apps.find((a) => a.app_slug === "vercel")!.tier).toBe("review1");
  });

  it("needs two named approvers for review2 and points to the request link", async () => {
    const { ctx } = await withApps();
    await ingestRequests(ctx, [email("ChatGPT Codex Connector", "chatgpt-codex-connector", "alice-gh", 2)]);
    await expect(decideApp(ctx, { app_slug: "chatgpt-codex-connector", verdict: "approve", reason: "ok", approvers: ["A"] })).rejects.toThrow(/needs 2/);
    const d = await decideApp(ctx, { app_slug: "chatgpt-codex-connector", verdict: "approve", reason: "AI tools allowed", approvers: ["A", "B"] });
    expect(d.open_on_github).toContain("request_id=2");
    expect(d.checklist.join("\n")).toContain("Team01");
  });
});

describe("apps drift", () => {
  it("flags undecided and all-repo installs, but not this server's own app", async () => {
    const { ctx, gh } = await withApps();
    process.env.GITHUB_APP_ID = "999";
    const base = { events: [], created_at: "", updated_at: "", suspended_at: null };
    gh.installations = [
      { id: 1, app_slug: "hackathon-ops", app_id: 999, repository_selection: "all", permissions: { administration: "write" }, ...base },
      { id: 2, app_slug: "vercel", app_id: 1, repository_selection: "all", permissions: { contents: "write" }, ...base },
    ];
    const out = await appsDrift(ctx);
    expect(out.issues.map((i) => `${i.app_slug}: ${i.issue}`)).toEqual(["vercel: installed without a recorded decision"]);
  });
});
