import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { UserError } from "../lib/util.js";
import {
  isStatus,
  type AppInfo,
  type CommitInfo,
  type GhApi,
  type Installation,
  type Invitation,
  type OrgInfo,
  type RepoInfo,
  type RepoPermission,
  type TeamInfo,
} from "./api.js";

const Kit = Octokit.plugin(retry, throttling);
type Kit = InstanceType<typeof Kit>;

const throttle = {
  onRateLimit: (retryAfter: number, _opts: unknown, _kit: unknown, retryCount: number) => {
    console.error(`[hackathon-ops] rate limited, retrying after ${retryAfter}s`);
    return retryCount < 2;
  },
  onSecondaryRateLimit: (retryAfter: number, _opts: unknown, _kit: unknown, retryCount: number) => {
    console.error(`[hackathon-ops] secondary rate limit, retrying after ${retryAfter}s`);
    return retryCount < 1;
  },
};

function privateKey(): string | null {
  if (process.env.GITHUB_APP_PRIVATE_KEY) return process.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n");
  if (process.env.GITHUB_APP_PRIVATE_KEY_PATH) return readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH, "utf8");
  return null;
}

const cache = new Map<string, Promise<OctokitGh>>();

/** One client per org. GitHub App auth is preferred; GITHUB_TOKEN is a fallback for trying things out. */
export function githubFor(org: string): Promise<OctokitGh> {
  let hit = cache.get(org.toLowerCase());
  if (!hit) {
    hit = connect(org);
    hit.catch(() => cache.delete(org.toLowerCase()));
    cache.set(org.toLowerCase(), hit);
  }
  return hit;
}

async function connect(org: string): Promise<OctokitGh> {
  const appId = process.env.GITHUB_APP_ID;
  const key = privateKey();
  const userAgent = "hackathon-ops-mcp";

  if (appId && key) {
    const app = new Kit({ authStrategy: createAppAuth, auth: { appId, privateKey: key }, throttle, userAgent });
    let installation: { id: number; permissions: Record<string, string> };
    try {
      ({ data: installation } = (await app.request("GET /orgs/{org}/installation", { org })) as {
        data: { id: number; permissions: Record<string, string> };
      });
    } catch (err) {
      if (isStatus(err, 404)) throw new UserError(`The GitHub App is not installed on "${org}". Install it on the org first.`);
      throw err;
    }
    const kit = new Kit({
      authStrategy: createAppAuth,
      auth: { appId, privateKey: key, installationId: installation.id },
      throttle,
      userAgent,
    });
    return new OctokitGh(kit, org, "app", installation.permissions);
  }

  if (process.env.GITHUB_TOKEN) {
    return new OctokitGh(new Kit({ auth: process.env.GITHUB_TOKEN, throttle, userAgent }), org, "token", null);
  }

  throw new UserError("No GitHub credentials. Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH (or GITHUB_TOKEN for testing).");
}

const emailKey = (email: string) => "email:" + createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 10);

export class OctokitGh implements GhApi {
  constructor(
    private readonly kit: Kit,
    readonly org: string,
    readonly authMode: "app" | "token",
    private readonly installPerms: Record<string, string> | null,
  ) {}

  private repo(name: string) {
    return { owner: this.org, repo: name };
  }

  private async nullOn404<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      if (isStatus(err, 404)) return null;
      throw err;
    }
  }

  async getOrg(): Promise<OrgInfo> {
    const { data } = await this.kit.request("GET /orgs/{org}", { org: this.org });
    const d = data as Record<string, unknown> & { id: number; login: string; plan?: { name?: string } };
    return {
      id: d.id,
      login: d.login,
      default_repository_permission: (d.default_repository_permission as string) ?? null,
      members_can_create_repositories: (d.members_can_create_repositories as boolean) ?? null,
      members_can_create_public_repositories: (d.members_can_create_public_repositories as boolean) ?? null,
      two_factor_requirement_enabled: (d.two_factor_requirement_enabled as boolean) ?? null,
      plan: d.plan?.name ?? null,
    };
  }

  async ownInstallationPermissions() {
    return this.installPerms;
  }

  async listTeams(): Promise<TeamInfo[]> {
    const teams = await this.kit.paginate("GET /orgs/{org}/teams", { org: this.org, per_page: 100 });
    return teams.map((t) => ({ id: t.id, slug: t.slug, name: t.name }));
  }

  async listTeamMembers(slug: string): Promise<string[]> {
    const users = await this.kit.paginate("GET /orgs/{org}/teams/{team_slug}/members", { org: this.org, team_slug: slug, per_page: 100 });
    return users.map((u) => u.login);
  }

  async listOrgMembers(): Promise<string[]> {
    const users = await this.kit.paginate("GET /orgs/{org}/members", { org: this.org, per_page: 100 });
    return users.map((u) => u.login);
  }

  async listOrgInvitations(): Promise<Invitation[]> {
    const invs = await this.kit.paginate("GET /orgs/{org}/invitations", { org: this.org, per_page: 100 });
    return invs.map((i) => ({ id: i.id, login: i.login ?? null, email: i.email ?? null }));
  }

  async getUser(login: string) {
    return this.nullOn404(async () => {
      const { data } = await this.kit.request("GET /users/{username}", { username: login });
      return { id: Number(data.id), login: data.login, type: data.type };
    });
  }

  async createTeam(name: string, description: string): Promise<TeamInfo> {
    try {
      const { data } = await this.kit.request("POST /orgs/{org}/teams", { org: this.org, name, description, privacy: "secret" });
      return { id: data.id, slug: data.slug, name: data.name };
    } catch (err) {
      if (!isStatus(err, 422)) throw err;
      const existing = (await this.listTeams()).find((t) => t.name.toLowerCase() === name.toLowerCase());
      if (!existing) throw err;
      return existing;
    }
  }

  async addTeamMember(slug: string, login: string) {
    await this.kit.request("PUT /orgs/{org}/teams/{team_slug}/memberships/{username}", {
      org: this.org,
      team_slug: slug,
      username: login,
      role: "member",
    });
  }

  async removeTeamMember(slug: string, login: string) {
    await this.kit.request("DELETE /orgs/{org}/teams/{team_slug}/memberships/{username}", { org: this.org, team_slug: slug, username: login });
  }

  async inviteToOrg(target: { invitee_id: number } | { email: string }, teamIds: number[]) {
    await this.kit.request("POST /orgs/{org}/invitations", { org: this.org, ...target, role: "direct_member", team_ids: teamIds });
  }

  async getRepo(name: string): Promise<RepoInfo | null> {
    return this.nullOn404(async () => {
      const { data } = await this.kit.request("GET /repos/{owner}/{repo}", this.repo(name));
      return {
        name: data.name,
        full_name: data.full_name,
        html_url: data.html_url,
        private: data.private,
        visibility: data.visibility ?? (data.private ? "private" : "public"),
        archived: data.archived,
        default_branch: data.default_branch,
      };
    });
  }

  async getTemplate(fullName: string) {
    const [owner = "", repo = ""] = fullName.split("/");
    return this.nullOn404(async () => {
      const { data } = await this.kit.request("GET /repos/{owner}/{repo}", { owner, repo });
      return { is_template: !!data.is_template };
    });
  }

  async createRepoFromTemplate(template: string, name: string, isPrivate: boolean, description: string) {
    const [template_owner = "", template_repo = ""] = template.split("/");
    await this.kit.request("POST /repos/{template_owner}/{template_repo}/generate", {
      template_owner,
      template_repo,
      owner: this.org,
      name,
      private: isPrivate,
      description,
      include_all_branches: false,
    });
  }

  async createRepo(name: string, isPrivate: boolean, description: string) {
    await this.kit.request("POST /orgs/{org}/repos", { org: this.org, name, private: isPrivate, description, auto_init: true });
  }

  async updateRepo(name: string, patch: { archived?: boolean; visibility?: "public" | "private" }) {
    await this.kit.request("PATCH /repos/{owner}/{repo}", { ...this.repo(name), ...patch });
  }

  async getTeamRepoPermission(slug: string, repo: string) {
    return this.nullOn404(async () => {
      const { data } = await this.kit.request("GET /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}", {
        org: this.org,
        team_slug: slug,
        ...this.repo(repo),
        headers: { accept: "application/vnd.github.v3.repository+json" },
      });
      const d = data as { role_name?: string; permissions?: Record<string, boolean> };
      if (d.role_name) return normalizeRole(d.role_name);
      const p = d.permissions ?? {};
      return p.admin ? "admin" : p.maintain ? "maintain" : p.push ? "push" : p.triage ? "triage" : p.pull ? "pull" : null;
    });
  }

  async setTeamRepoPermission(slug: string, repo: string, permission: RepoPermission) {
    await this.kit.request("PUT /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}", {
      org: this.org,
      team_slug: slug,
      ...this.repo(repo),
      permission,
    });
  }

  async getUserRepoPermission(repo: string, login: string) {
    return this.nullOn404(async () => {
      const { data } = await this.kit.request("GET /repos/{owner}/{repo}/collaborators/{username}/permission", {
        ...this.repo(repo),
        username: login,
      });
      return normalizeRole((data as { role_name?: string }).role_name ?? data.permission);
    });
  }

  async setCollaborator(repo: string, login: string, permission: RepoPermission) {
    await this.kit.request("PUT /repos/{owner}/{repo}/collaborators/{username}", { ...this.repo(repo), username: login, permission });
  }

  async removeCollaborator(repo: string, login: string) {
    await this.kit.request("DELETE /repos/{owner}/{repo}/collaborators/{username}", { ...this.repo(repo), username: login });
  }

  async listOutsideCollaborators(repo: string) {
    const users = await this.kit.paginate("GET /repos/{owner}/{repo}/collaborators", { ...this.repo(repo), affiliation: "outside", per_page: 100 });
    return users.map((u) => u.login);
  }

  async listRepoInvitations(repo: string): Promise<Invitation[]> {
    const invs = await this.kit.paginate("GET /repos/{owner}/{repo}/invitations", { ...this.repo(repo), per_page: 100 });
    return invs.map((i) => ({ id: i.id, login: i.invitee?.login ?? null, email: null }));
  }

  async deleteRepoInvitation(repo: string, id: number) {
    await this.kit.request("DELETE /repos/{owner}/{repo}/invitations/{invitation_id}", { ...this.repo(repo), invitation_id: id });
  }

  async listRulesets(repo: string) {
    const { data } = await this.kit.request("GET /repos/{owner}/{repo}/rulesets", { ...this.repo(repo), per_page: 100 });
    return (data as { id: number; name: string }[]).map((r) => ({ id: r.id, name: r.name }));
  }

  async createRuleset(repo: string, body: Record<string, unknown>) {
    await this.kit.request("POST /repos/{owner}/{repo}/rulesets", { ...this.repo(repo), ...body } as never);
  }

  async getTopics(repo: string) {
    const { data } = await this.kit.request("GET /repos/{owner}/{repo}/topics", this.repo(repo));
    return data.names;
  }

  async setTopics(repo: string, names: string[]) {
    await this.kit.request("PUT /repos/{owner}/{repo}/topics", { ...this.repo(repo), names });
  }

  async getRefSha(repo: string, ref: string) {
    return this.nullOn404(async () => {
      const { data } = await this.kit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", { ...this.repo(repo), ref });
      return data.object.sha;
    });
  }

  async createRef(repo: string, ref: string, sha: string) {
    await this.kit.request("POST /repos/{owner}/{repo}/git/refs", { ...this.repo(repo), ref: `refs/${ref}`, sha });
  }

  async getTree(repo: string, ref: string) {
    try {
      const { data } = await this.kit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
        ...this.repo(repo),
        tree_sha: ref,
        recursive: "1",
      });
      return { paths: data.tree.filter((e) => e.type === "blob" && e.path).map((e) => e.path!), truncated: data.truncated };
    } catch (err) {
      if (isStatus(err, 404, 409)) return { paths: [], truncated: false };
      throw err;
    }
  }

  async getReadme(repo: string) {
    return this.nullOn404(async () => {
      const { data } = await this.kit.request("GET /repos/{owner}/{repo}/readme", this.repo(repo));
      return Buffer.from(data.content, (data.encoding as BufferEncoding) || "base64").toString("utf8");
    });
  }

  async listCommits(repo: string, ref: string, max: number): Promise<CommitInfo[]> {
    const out: CommitInfo[] = [];
    try {
      for await (const page of this.kit.paginate.iterator("GET /repos/{owner}/{repo}/commits", { ...this.repo(repo), sha: ref, per_page: 100 })) {
        for (const c of page.data) {
          out.push({
            sha: c.sha,
            date: c.commit.author?.date ?? c.commit.committer?.date ?? "",
            author_login: c.author?.login ?? null,
            author_key: c.author?.login ?? emailKey(c.commit.author?.email ?? c.sha),
            parents: c.parents.length,
          });
          if (out.length >= max) return out;
        }
      }
    } catch (err) {
      if (isStatus(err, 404, 409)) return out;
      throw err;
    }
    return out;
  }

  async listInstallations(): Promise<Installation[]> {
    const list = await this.kit.paginate("GET /orgs/{org}/installations", { org: this.org, per_page: 100 });
    return list.map((i) => ({
      id: i.id,
      app_slug: i.app_slug,
      app_id: i.app_id,
      repository_selection: i.repository_selection,
      permissions: i.permissions as Record<string, string>,
      events: i.events,
      created_at: i.created_at,
      updated_at: i.updated_at,
      suspended_at: i.suspended_at ?? null,
    }));
  }

  async getApp(slug: string): Promise<AppInfo | null> {
    return this.nullOn404(async () => {
      const { data } = await this.kit.request("GET /apps/{app_slug}", { app_slug: slug });
      if (!data) return null;
      const owner = data.owner as { login?: string; type?: string } | null;
      return {
        slug: data.slug ?? slug,
        name: data.name,
        owner_login: owner?.login ?? null,
        owner_type: owner?.type ?? null,
        html_url: data.html_url,
        permissions: data.permissions as Record<string, string>,
        events: data.events,
      };
    });
  }
}

/** GitHub reports legacy names ("read", "write") in some places. */
export function normalizeRole(role: string | null | undefined): string | null {
  if (!role) return null;
  const r = role.toLowerCase();
  if (r === "read") return "pull";
  if (r === "write") return "push";
  return r;
}
