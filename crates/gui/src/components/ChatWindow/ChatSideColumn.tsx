import { useId, useRef, type ReactNode } from "react";
import {
  ariaKeyShortcut,
  SIDE_COLUMN_SHORTCUTS,
  shortcutText,
} from "./chatShortcuts";
import {
  cycleSection,
  SIDE_SECTION_LABEL,
  SIDE_SECTIONS,
  type SideSection,
} from "../../stores/chatSideColumnStore";
import { useDiscussionSummary } from "./selectionDiscussionState";
import { CHAT_AREA_ATTRIBUTE } from "./chatAreas";

/** Below this chat width the column replaces the transcript (§1). */
export const SIDE_COLUMN_BESIDE_MIN_WIDTH = 1100;

export type SideCounts = Record<SideSection, number | null>;

const TOGGLE_KEYS = shortcutText(SIDE_COLUMN_SHORTCUTS.toggle);

/**
 * A chat's side column: Changes · Discussions · Background tasks behind one
 * switcher (decision 49d12c2c §1). It always shows its own chat's content.
 * The switcher is a tab group: ←/→ move between sections while it has
 * focus, ↓ enters the section; ⌃⌘1–3 show a section from anywhere in the
 * chat. Choosing a section by click or key puts the keyboard in it.
 */
export function ChatSideColumn({
  section,
  counts,
  available,
  onSection,
  onClose,
  children,
}: {
  section: SideSection;
  /** Discussions counts itself from the chat's discussion provider. */
  counts: Omit<SideCounts, "discussions">;
  available(section: SideSection): boolean;
  /** `focus`: the section's content takes the keyboard once shown. */
  onSection(section: SideSection, focus: boolean): void;
  onClose(): void;
  /** The shown section's content. */
  children: ReactNode;
}) {
  const id = useId();
  const tabId = (value: SideSection) => `${id}-${value}`;
  const tabs = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const { alert, count: discussions } = useDiscussionSummary();

  return (
    <div className="chat-side-column">
      <div className="chat-side-switcher">
        <div
          ref={tabs}
          role="tablist"
          aria-label="Side column sections"
          className="workspace-tabs"
          onKeyDown={(event) => {
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            // ↓ leaves the tabs for the shown section's content.
            if (event.key === "ArrowDown" && !event.shiftKey) {
              const content = panel.current?.querySelector<HTMLElement>(
                `[${CHAT_AREA_ATTRIBUTE}]`
              );
              if (!content) return;
              event.preventDefault();
              content.focus({ preventScroll: true });
              return;
            }
            const step =
              event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            if (!step) return;
            event.preventDefault();
            const next = cycleSection(section, step, available);
            if (!next) return;
            onSection(next, false);
            tabs.current
              ?.querySelector<HTMLElement>(`#${CSS.escape(tabId(next))}`)
              ?.focus();
          }}
        >
          {SIDE_SECTIONS.map((value) => {
            const count =
              value === "discussions" ? discussions : counts[value];
            const selected = value === section;
            return (
              <button
                key={value}
                id={tabId(value)}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`${id}-panel`}
                tabIndex={selected ? 0 : -1}
                disabled={!available(value)}
                data-alert={value === "discussions" && alert ? "" : undefined}
                title={`${SIDE_SECTION_LABEL[value]} · ${shortcutText(SIDE_COLUMN_SHORTCUTS[value])}`}
                aria-keyshortcuts={ariaKeyShortcut(SIDE_COLUMN_SHORTCUTS[value])}
                onClick={() => onSection(value, true)}
              >
                {SIDE_SECTION_LABEL[value]}
                {!!count && (
                  <span className="changes-files-count">{count}</span>
                )}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="chat-side-close"
          aria-label="Close side column"
          aria-keyshortcuts={ariaKeyShortcut(SIDE_COLUMN_SHORTCUTS.toggle)}
          title={`Close side column · ${TOGGLE_KEYS}`}
          onClick={onClose}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="m6 6 12 12M6 18 18 6" />
          </svg>
        </button>
      </div>
      <div
        ref={panel}
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={tabId(section)}
        className="chat-side-section"
      >
        {children}
      </div>
    </div>
  );
}
