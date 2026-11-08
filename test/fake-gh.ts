import type { AppInfo, CommitInfo, GhApi, Installation, Invitation, OrgInfo, RepoInfo, RepoPermission, TeamInfo } from "../src/github/api.js";

const RANK: Record<string, number> = { none: 0, pull: 1, triage: 2, push: 3, maintain: 4, admin: 5 };

interface FakeRepo extends RepoInfo {
  teamPerms: Map<string, string>;
  collaborators: Map<string, string>;
  outside: Set<string>;
  invitations: Invitation[];
  rulesets: { id: number; name: string }[];
  topics: string[];
  refs: Map<string, string>;
  tree: string[];
  readme: string | null;
  commits: CommitInfo[];
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** In-memory GitHub with just enough behaviour for the plans. */
export class FakeGh implements GhApi {
  org = "test-org";
  authMode = "app" as const;
  orgInfo: OrgInfo = { id: 4242, login: "test-org", default_repository_permission: "none", members_can_create_repositories: false };
  teams: TeamInfo[] = [];
  teamMembers = new Map<string, Set<string>>();
  orgMembers = new Set<string>();
  invitations: Invitation[] = [];
  users = new Map<string, { id: number; login: string; type: string }>();
  repos = new Map<string, FakeRepo>();
  templates = new Map<string, boolean>();
  installations: Installation[] = [];
  apps = new Map<string, AppInfo>();
  rulesetsSupported = true;
  calls: string[] = [];
  /** Throw once when this op name is called. */
  failOn: string | null = null;
  private nextId = 100;

  private hit(name: string) {
    this.calls.push(name);
    if (this.failOn === name) {
      this.failOn = null;
      throw new HttpError(500, `boom in ${name}`);
    }
  }

  addUser(login: string, member = false) {
    this.users.set(login.toLowerCase(), { id: this.nextId++, login, type: "User" });
    if (member) this.orgMembers.add(login);
  }

  addRepo(name: string, extra: Partial<FakeRepo> = {}) {
    const repo: FakeRepo = {
      name,
      full_name: `${this.org}/${name}`,
      html_url: `https://github.com/${this.org}/${name}`,
      private: true,
      visibility: "private",
      archived: false,
      default_branch: "main",
      teamPerms: new Map(),
      collaborators: new Map(),
      outside: new Set(),
      invitations: [],
      rulesets: [],
      topics: [],
      refs: new Map([["heads/main", "sha-main-1"]]),
      tree: ["README.md"],
      readme: null,
      commits: [],
      ...extra,
    };
    this.repos.set(name, repo);
    return repo;
  }

  private repo(name: string) {
    const r = this.repos.get(name);
    if (!r) throw new HttpError(404, `no repo ${name}`);
    return r;
  }

  without2fa: string[] = [];

  async getOrg() {
    return this.orgInfo;
  }
  async updateOrg(patch: Record<string, unknown>) {
    this.hit("updateOrg");
    Object.assign(this.orgInfo, patch);
  }
  async listMembersWithout2fa() {
    return [...this.without2fa];
  }
  async listOutsideCollaboratorsWithout2fa() {
    return [];
  }
  async ownInstallationPermissions() {
    return { members: "write", organization_administration: "read", administration: "write", contents: "write", metadata: "read" };
  }
  async listTeams() {
    return [...this.teams];
  }
  async listTeamMembers(slug: string) {
    return [...(this.teamMembers.get(slug) ?? [])];
  }
  async listOrgMembers() {
    return [...this.orgMembers];
  }
  async listOrgInvitations() {
    return [...this.invitations];
  }
  async getUser(login: string) {
    return this.users.get(login.toLowerCase()) ?? null;
  }
  async createTeam(name: string) {
    this.hit("createTeam");
    const t = { id: this.nextId++, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name };
    this.teams.push(t);
    this.teamMembers.set(t.slug, new Set());
    return t;
  }
  async addTeamMember(slug: string, login: string) {
    this.hit("addTeamMember");
    this.teamMembers.get(slug)!.add(login);
  }
  async removeTeamMember(slug: string, login: string) {
    this.hit("removeTeamMember");
    this.teamMembers.get(slug)!.delete(login);
  }
  async inviteToOrg(target: { invitee_id: number } | { email: string }) {
    this.hit("inviteToOrg");
    if ("email" in target) this.invitations.push({ id: this.nextId++, login: null, email: target.email });
    else {
      const user = [...this.users.values()].find((u) => u.id === target.invitee_id)!;
      this.invitations.push({ id: this.nextId++, login: user.login, email: null });
    }
  }
  async getRepo(name: string) {
    return this.repos.get(name) ?? null;
  }
  async getTemplate(fullName: string) {
    return this.templates.has(fullName) ? { is_template: this.templates.get(fullName)! } : null;
  }
  async createRepoFromTemplate(_t: string, name: string) {
    this.hit("createRepoFromTemplate");
    this.addRepo(name);
  }
  async createRepo(name: string) {
    this.hit("createRepo");
    this.addRepo(name);
  }
  async updateRepo(name: string, patch: { archived?: boolean; visibility?: "public" | "private" }) {
    this.hit("updateRepo");
    const r = this.repo(name);
    if (patch.visibility && r.archived) throw new HttpError(403, "archived");
    if (patch.archived !== undefined) r.archived = patch.archived;
    if (patch.visibility) {
      r.visibility = patch.visibility;
      r.private = patch.visibility === "private";
    }
  }
  async getTeamRepoPermission(slug: string, repo: string) {
    return this.repo(repo).teamPerms.get(slug) ?? null;
  }
  async setTeamRepoPermission(slug: string, repo: string, permission: RepoPermission) {
    this.hit("setTeamRepoPermission");
    this.repo(repo).teamPerms.set(slug, permission);
  }
  async getUserRepoPermission(repo: string, login: string) {
    if (!this.users.has(login.toLowerCase())) return null;
    const r = this.repo(repo);
    let best = r.collaborators.get(login) ?? "none";
    for (const [slug, perm] of r.teamPerms) {
      if (this.teamMembers.get(slug)?.has(login) && (RANK[perm] ?? 0) > (RANK[best] ?? 0)) best = perm;
    }
    return best;
  }
  async setCollaborator(repo: string, login: string, permission: RepoPermission) {
    this.hit("setCollaborator");
    const r = this.repo(repo);
    if (this.orgMembers.has(login)) r.collaborators.set(login, permission);
    else r.invitations.push({ id: this.nextId++, login, email: null });
  }
  async removeCollaborator(repo: string, login: string) {
    this.hit("removeCollaborator");
    const r = this.repo(repo);
    r.collaborators.delete(login);
    r.outside.delete(login);
  }
  async listOutsideCollaborators(repo: string) {
    return [...this.repo(repo).outside];
  }
  async listRepoInvitations(repo: string) {
    return [...this.repo(repo).invitations];
  }
  async deleteRepoInvitation(repo: string, id: number) {
    this.hit("deleteRepoInvitation");
    const r = this.repo(repo);
    r.invitations = r.invitations.filter((i) => i.id !== id);
  }
  async listRulesets(repo: string) {
    if (!this.rulesetsSupported) throw new HttpError(403, "Upgrade to GitHub Pro");
    return [...this.repo(repo).rulesets];
  }
  async createRuleset(repo: string, body: Record<string, unknown>) {
    this.hit("createRuleset");
    if (!this.rulesetsSupported) throw new HttpError(403, "Upgrade to GitHub Pro");
    this.repo(repo).rulesets.push({ id: this.nextId++, name: String(body.name) });
  }
  async getTopics(repo: string) {
    return [...this.repo(repo).topics];
  }
  async setTopics(repo: string, names: string[]) {
    this.hit("setTopics");
    this.repo(repo).topics = [...names];
  }
  async getRefSha(repo: string, ref: string) {
    return this.repo(repo).refs.get(ref) ?? null;
  }
  async createRef(repo: string, ref: string, sha: string) {
    this.hit("createRef");
    this.repo(repo).refs.set(ref, sha);
  }
  async getTree(repo: string) {
    return { paths: [...this.repo(repo).tree], truncated: false };
  }
  async getReadme(repo: string) {
    return this.repo(repo).readme;
  }
  async listCommits(repo: string, _ref: string, max: number) {
    return this.repo(repo).commits.slice(0, max);
  }
  async listInstallations() {
    return [...this.installations];
  }
  async getApp(slug: string) {
    return this.apps.get(slug) ?? null;
  }
}
