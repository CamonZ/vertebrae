import type { GithubPrState } from "../../bindings";

export const PR_STATE_LABEL: Record<GithubPrState, string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};
