import type { ReactNode } from "react";

/** 14px, 1.5px-stroke glyphs shared by the comment surfaces. */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
      viewBox="0 0 24 24"
    >
      {children}
    </svg>
  );
}

export function EditGlyph() {
  return (
    <Glyph>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
    </Glyph>
  );
}

export function TrashGlyph() {
  return (
    <Glyph>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="m19 6-1 14H6L5 6" />
      <path d="M10 11v5M14 11v5" />
    </Glyph>
  );
}

/** A comment on code. */
export function CodeGlyph() {
  return (
    <Glyph>
      <path d="m8 7-5 5 5 5" />
      <path d="m16 7 5 5-5 5" />
    </Glyph>
  );
}

/** A comment on quoted text. */
export function QuoteGlyph() {
  return (
    <Glyph>
      <path d="M4 6v12" />
      <path d="M9 8h11M9 12h11M9 16h7" />
    </Glyph>
  );
}

export function CloseGlyph() {
  return (
    <Glyph>
      <path d="M6 6l12 12M18 6 6 18" />
    </Glyph>
  );
}

export function TerminalGlyph() {
  return (
    <Glyph>
      <path d="m4 17 6-6-6-6" />
      <path d="M12 19h8" />
    </Glyph>
  );
}
