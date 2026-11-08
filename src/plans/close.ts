import type { PlanKind } from "./engine.js";

/** Deletes personal data from this event's local state. Touches nothing on GitHub or in the sheet. */
export const closePlan: PlanKind<Record<string, never>> = {
  kind: "event_close",
  codePrefix: "CLOSE",

  async compute(ctx) {
    const counts = ctx.db.personalDataCounts();
    const frozen = counts.freeze_snapshot_rows > 0 ? ["Saved pre-freeze permissions are deleted too, so repos still frozen cannot be unfrozen with repos_freeze afterwards."] : [];
    return {
      changes: [
        {
          op: "purge_personal_data",
          target: "state.db",
          summary: "Delete saved plans, audit details and app requesters; mask user targets in the audit log",
          params: {},
        },
      ],
      warnings: [
        "This is local only. Delete the participant spreadsheet and the GitHub ID form responses separately, as your privacy notice says.",
        "Team, repo and app decision records stay so the event can still be audited.",
        ...frozen,
      ],
      info: { counts },
    };
  },

  async execute(ctx) {
    ctx.db.purgePersonalData();
  },
};
