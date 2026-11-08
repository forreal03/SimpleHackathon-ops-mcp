/**
 * Everything the server does on GitHub goes through this interface.
 * The Octokit implementation lives in octokit.ts; tests use an in-memory fake.
 */

export type RepoPermission = "pull" | "triage" | "push" | "maintain" | "admin";

export interface OrgInfo {
  id: number;
  login: string;
  default_repository_permission?: string | null;
  members_can_create_repositories?: boolean | null;
  members_can_create_public_repositories?: boolean | null;
  two_factor_requirement_enabled?: boolean | null;
  members_can_fork_private_repositories?: boolean | null;
  plan?: string | null;
}

/** Org settings this server can change through the API. 2FA enforcement is not one of them (UI only). */
export interface OrgSettingsPatch {
  members_can_create_repositories?: boolean;
  default_repository_permission?: "none" | "read" | "write" | "admin";
  members_can_fork_private_repositories?: boolean;
}

export interface TeamInfo {
  id: number;
  slug: string;
  name: string;
}

export interface Invitation {
  id: number;
  login: string | null;
  email: string | null;
}

export interface RepoInfo {
  name: string;
  full_name: string;
  html_url: string;
  private: boolean;
  visibility: string;
  archived: boolean;
  default_branch: string;
}

export interface CommitInfo {
  sha: string;
  date: string;
  author_login: string | null;
  author_key: string;
  parents: number;
}

export interface Installation {
  id: number;
  app_slug: string;
  app_id: number;
  repository_selection: "all" | "selected";
  permissions: Record<string, string>;
  events: string[];
  created_at: string;
  updated_at: string;
  suspended_at: string | null;
}

export interface AppInfo {
  slug: string;
  name: string;
  owner_login: string | null;
  owner_type: string | null;
  html_url: string;
  permissions: Record<string, string>;
  events: string[];
}

export interface GhApi {
  readonly org: string;
  readonly authMode: "app" | "token";

  getOrg(): Promise<OrgInfo>;
  updateOrg(patch: OrgSettingsPatch): Promise<void>;
  /** Logins without 2FA (owner-only filter on GitHub). */
  listMembersWithout2fa(): Promise<string[]>;
  listOutsideCollaboratorsWithout2fa(): Promise<string[]>;
  /** Permissions granted to this server's own GitHub App installation (null in token mode). */
  ownInstallationPermissions(): Promise<Record<string, string> | null>;

  listTeams(): Promise<TeamInfo[]>;
  listTeamMembers(slug: string): Promise<string[]>;
  listOrgMembers(): Promise<string[]>;
  listOrgInvitations(): Promise<Invitation[]>;
  getUser(login: string): Promise<{ id: number; login: string; type: string } | null>;
  createTeam(name: string, description: string): Promise<TeamInfo>;
  addTeamMember(slug: string, login: string): Promise<void>;
  removeTeamMember(slug: string, login: string): Promise<void>;
  inviteToOrg(target: { invitee_id: number } | { email: string }, teamIds: number[]): Promise<void>;

  getRepo(name: string): Promise<RepoInfo | null>;
  /** "owner/repo" of a template; null when it does not exist or is not visible. */
  getTemplate(fullName: string): Promise<{ is_template: boolean } | null>;
  createRepoFromTemplate(template: string, name: string, isPrivate: boolean, description: string): Promise<void>;
  createRepo(name: string, isPrivate: boolean, description: string): Promise<void>;
  updateRepo(name: string, patch: { archived?: boolean; visibility?: "public" | "private" }): Promise<void>;
  /** Team's role on the repo, or null when the team has no access. */
  getTeamRepoPermission(slug: string, repo: string): Promise<string | null>;
  setTeamRepoPermission(slug: string, repo: string, permission: RepoPermission): Promise<void>;
  /** User's role on the repo ("none" when no access), or null when the user does not exist. */
  getUserRepoPermission(repo: string, login: string): Promise<string | null>;
  setCollaborator(repo: string, login: string, permission: RepoPermission): Promise<void>;
  removeCollaborator(repo: string, login: string): Promise<void>;
  listOutsideCollaborators(repo: string): Promise<string[]>;
  listRepoInvitations(repo: string): Promise<Invitation[]>;
  deleteRepoInvitation(repo: string, id: number): Promise<void>;
  listRulesets(repo: string): Promise<{ id: number; name: string }[]>;
  createRuleset(repo: string, body: Record<string, unknown>): Promise<void>;
  getTopics(repo: string): Promise<string[]>;
  setTopics(repo: string, names: string[]): Promise<void>;
  getRefSha(repo: string, ref: string): Promise<string | null>;
  createRef(repo: string, ref: string, sha: string): Promise<void>;
  getTree(repo: string, ref: string): Promise<{ paths: string[]; truncated: boolean }>;
  getReadme(repo: string): Promise<string | null>;
  listCommits(repo: string, ref: string, max: number): Promise<CommitInfo[]>;

  listInstallations(): Promise<Installation[]>;
  getApp(slug: string): Promise<AppInfo | null>;
}

export function isStatus(err: unknown, ...codes: number[]): boolean {
  const status = (err as { status?: number })?.status;
  return typeof status === "number" && codes.includes(status);
}

export function errorMessage(err: unknown): string {
  const e = err as { status?: number; message?: string; response?: { data?: { message?: string } } };
  const detail = e.response?.data?.message ?? e.message ?? String(err);
  return e.status ? `HTTP ${e.status}: ${detail}` : detail;
}
