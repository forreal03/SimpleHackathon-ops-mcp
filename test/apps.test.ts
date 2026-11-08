import { describe, expect, it } from "vitest";
import { evaluateApp, expandedPermissions } from "../src/apps/policy.js";
import { parseInstallRequestEmail, verifyInstallRequest } from "../src/apps/mail.js";
import { AppPolicySchema } from "../src/config/schema.js";

const policy = AppPolicySchema.parse({ allow: ["vercel", "render"] });

// Permissions as returned by GET /apps/{slug} on 2026-11-08.
const VERCEL = { actions: "read", administration: "write", checks: "write", contents: "write", deployments: "write", emails: "read", issues: "write", members: "read", metadata: "read", pull_requests: "write", repository_hooks: "write", statuses: "write", workflows: "write" };
const RENDER = { actions: "write", checks: "write", contents: "read", deployments: "write", emails: "read", environments: "write", issues: "write", metadata: "read", pull_requests: "write", repository_hooks: "write", statuses: "write", vulnerability_alerts: "read", workflows: "write" };
const CODEX = { actions: "write", checks: "read", contents: "write", emails: "read", issues: "write", metadata: "read", pull_requests: "write", statuses: "read", workflows: "write" };

const org = (slug: string, permissions: Record<string, string>) => ({ slug, found: true, owner_type: "Organization", permissions });

describe("app policy", () => {
  it("rates the apps requested for ENDPoinT 2026", () => {
    const vercel = evaluateApp(policy, org("vercel", VERCEL));
    expect([vercel.base_tier, vercel.tier]).toEqual(["review2", "review1"]);
    expect(evaluateApp(policy, org("render", RENDER)).tier).toBe("review1");
    const codex = evaluateApp(policy, org("chatgpt-codex-connector", CODEX));
    expect([codex.tier, codex.allowlisted]).toEqual(["review2", false]);
  });

  it("rejects org-wide write, secrets and all-repository installs even when allow-listed", () => {
    expect(evaluateApp(policy, org("vercel", { ...VERCEL, members: "write" })).tier).toBe("reject");
    expect(evaluateApp(policy, org("x", { secrets: "write" })).tier).toBe("reject");
    expect(evaluateApp(policy, { ...org("render", RENDER), repository_selection: "all" }).tier).toBe("reject");
  });

  it("is stricter with personal owners and unknown apps, lenient with read-only", () => {
    expect(evaluateApp(policy, { slug: "x", found: true, owner_type: "User", permissions: { contents: "read" } }).tier).toBe("review2");
    expect(evaluateApp(policy, { slug: "x", found: false, owner_type: null, permissions: {} }).tier).toBe("review2");
    expect(evaluateApp(policy, org("x", { contents: "read", metadata: "read", emails: "read" })).tier).toBe("allow");
  });

  it("finds grown permissions", () => {
    expect(expandedPermissions({ contents: "read" }, { contents: "write", issues: "read" })).toEqual(["contents:write (was read)", "issues:read (new)"]);
  });
});

const BODY = `Hello there!

You’re receiving this email because @some-user has requested the
installation of Vercel at your organization 2026ENDPoinT.

To review the request, please click or paste in your browser the following link:

https://github.com/apps/vercel/installations/new/permissions?request_id=2939027&target_id=331351900

Thanks!`;

describe("install request emails", () => {
  const email = { sender: "GitHub <noreply@github.com>", subject: "Request to install Vercel in 2026ENDPoinT", body: BODY, date: "2026-11-08T10:39:54Z" };

  it("parses GitHub's real format", () => {
    const r = parseInstallRequestEmail(email);
    expect(r.ok && r.request).toMatchObject({ app_name: "Vercel", app_slug: "vercel", requester: "some-user", org: "2026ENDPoinT", request_id: "2939027", target_id: "331351900" });
  });

  it("refuses other senders and lookalike links", () => {
    expect(parseInstallRequestEmail({ ...email, sender: "noreply@github.com.evil.io" }).ok).toBe(false);
    const hidden = BODY.replace("https://github.com/apps", "https://evil.example/?next=https://github.com/apps");
    expect(parseInstallRequestEmail({ ...email, body: hidden }).ok).toBe(false);
    const two = BODY + "\nhttps://github.com/apps/evil/installations/new/permissions?request_id=1&target_id=2\n";
    const r = parseInstallRequestEmail({ ...email, body: two });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reasons).toContain("more than one installation link");
  });

  it("refuses requests for another org", () => {
    const r = parseInstallRequestEmail(email);
    if (!r.ok) throw new Error("parse failed");
    expect(verifyInstallRequest(r.request, { login: "2026ENDPoinT", id: 331351900 })).toEqual([]);
    expect(verifyInstallRequest(r.request, { login: "2026ENDPoinT", id: 1 })).toHaveLength(1);
    expect(verifyInstallRequest(r.request, { login: "other", id: 331351900 })).toHaveLength(1);
  });
});
