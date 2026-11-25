import type { ReactNode } from "react";
import { Icon } from "../atoms/Icon";

/**
 * Verb glyphs for the GitHub surfaces, in the app's 1.5px line style. A
 * button's left glyph says what it does; the right says where it acts: the
 * GitHub mark when it changes something on GitHub, the outward arrow when it
 * opens GitHub. Local-only actions carry no GitHub mark.
 */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <Icon size="xs" strokeWidth={1.5}>
      {children}
    </Icon>
  );
}

/** Read GitHub again. */
export function RefreshGlyph() {
  return (
    <Glyph>
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </Glyph>
  );
}

/** Run a failed job again. */
export function RerunGlyph() {
  return (
    <Glyph>
      <path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5" />
      <path d="M4 3.5v5h5" />
      <path d="m10.5 9.5 4 2.5-4 2.5Z" />
    </Glyph>
  );
}

/** Stop a running workflow run. */
export function StopGlyph() {
  return (
    <Glyph>
      <circle cx="12" cy="12" r="8.5" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </Glyph>
  );
}

/** Associate a PR with this branch locally. */
export function LinkGlyph() {
  return (
    <Glyph>
      <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" />
      <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" />
    </Glyph>
  );
}

/** Forget the local association; GitHub is untouched. */
export function UnlinkGlyph() {
  return (
    <Glyph>
      <path d="m15.5 12.5 3.9-3.9a4.5 4.5 0 0 0-6.4-6.4L9.1 6.1" />
      <path d="m8.5 11.5-3.9 3.9a4.5 4.5 0 0 0 6.4 6.4l3.9-3.9" />
      <path d="M4 4l2.5 2.5M20 20l-2.5-2.5" />
    </Glyph>
  );
}

/** Start a new PR on GitHub. */
export function NewPrGlyph() {
  return (
    <Glyph>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <path d="M6 8.5v7" />
      <path d="M18 9v9M13.5 13.5h9" />
    </Glyph>
  );
}
