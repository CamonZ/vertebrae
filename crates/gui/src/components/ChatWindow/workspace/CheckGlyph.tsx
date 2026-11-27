import type { ReactNode } from "react";
import type { GithubCheckStatus } from "../../../bindings";
import { Icon } from "../../atoms/Icon";
import "./prChecks.css";

const GLYPH_PATHS: Record<GithubCheckStatus, ReactNode> = {
  failed: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </>
  ),
  running: (
    <>
      <circle cx="12" cy="12" r="8" opacity="0.35" />
      <path d="M12 4a8 8 0 0 1 8 8" />
    </>
  ),
  queued: <circle cx="12" cy="12" r="7" />,
  passed: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="m8.5 12.5 2.5 2.5 4.5-5" />
    </>
  ),
};

/** Running glows (glow means running); queued is a flat muted ring. */
export function CheckGlyph({ status }: { status: GithubCheckStatus }) {
  return (
    <span className={`pr-check-glyph is-${status}`} aria-hidden="true">
      <Icon size="sm" strokeWidth={1.5}>
        {GLYPH_PATHS[status]}
      </Icon>
    </span>
  );
}
