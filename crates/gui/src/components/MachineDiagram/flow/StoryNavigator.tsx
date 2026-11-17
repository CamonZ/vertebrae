import {
  memo,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { ZOOM_GUTTER } from "../MachineDiagramViewport";
import { AttachmentPanel } from "./AttachmentPanel";
import type { CompiledFlow, DiagramTimeline } from "./compile";
import { storyActors, type StoryActor } from "./story";

export interface StoryHandle {
  nextReference: (dir: 1 | -1) => void;
}
function reveal(element: HTMLElement) {
  let parent: HTMLElement | null = element;
  while (parent) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
    parent = parent.parentElement;
  }
}

export function StoryNavigator({
  ref,
  id,
  flow,
  diagram,
  beat,
  open,
  width,
  onToggle,
  onSeek,
  selection,
  inspectors,
  playing,
  onPause,
  activeActor,
}: {
  ref: Ref<StoryHandle>;
  id: string;
  flow: CompiledFlow;
  diagram: DiagramTimeline;
  beat: number;
  open: boolean;
  width: number;
  onToggle: () => void;
  onSeek: (beat: number) => void;
  selection: string | null;
  inspectors: ReactNode;
  playing: boolean;
  onPause: () => void;
  activeActor?: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open && content.current?.contains(document.activeElement))
      toggle.current?.focus();
  }, [open]);
  const activeReference = useRef<HTMLElement | null>(null);
  const [manual, setManual] = useState(false);
  // Starting playback is an explicit return to the animated story. Browsing
  // during an already-running playback still keeps the reader in control.
  useEffect(() => {
    if (playing) setManual(false);
  }, [playing]);
  const [focusReference, setFocusReference] = useState<HTMLElement | null>(
    null
  );
  const scrollTop = useRef(0);
  const lastSelection = useRef<string | null>(null);
  function scrollTo(element: HTMLElement) {
    reveal(element);
    const container = list.current;
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    const target = element.getBoundingClientRect();
    if (target.top < bounds.top) container.scrollTop += target.top - bounds.top;
    else if (target.bottom > bounds.bottom)
      container.scrollTop += Math.min(
        target.top - bounds.top,
        target.bottom - bounds.bottom
      );
    scrollTop.current = container.scrollTop;
  }
  useEffect(() => {
    if (open && focusReference) {
      scrollTo(focusReference);
      focusReference.focus({ preventScroll: true });
      setFocusReference(null);
    }
  }, [open, focusReference]);
  const groups = useMemo(
    () =>
      diagram.beats.map((b, i) =>
        storyActors(
          flow,
          (flow.phased &&
            flow.arrangements.find((d) => d.arrangement === b.phase)) ||
            diagram,
          i
        )
      ),
    [flow, diagram]
  );
  const current = Math.max(0, beat);
  const watching = !manual;
  useEffect(() => {
    if (!watching) return;
    const section = list.current?.querySelector(
      `[data-story-beat="${current}"]`
    );
    section
      ?.querySelectorAll<HTMLDetailsElement>("[data-story-actor]")
      .forEach((el) => {
        el.open = true;
      });
  }, [watching, current, diagram]);
  useEffect(() => {
    list.current
      ?.querySelectorAll<HTMLElement>("[data-story-actor]")
      .forEach((el) => {
        el.dataset.active = String(
          watching && el.dataset.storyActor === activeActor
        );
      });
  }, [activeActor, watching, current]);
  function jumpToCurrent() {
    const section = list.current?.querySelector<HTMLElement>(
      `[data-story-beat="${current}"]`
    );
    if (section) scrollTo(section);
  }
  useEffect(() => {
    if (!open) return;
    const section = list.current?.querySelector<HTMLDetailsElement>(
      `[data-story-beat="${current}"]`
    );
    list.current
      ?.querySelectorAll("[data-story-beat][aria-current]")
      .forEach((el) => el.removeAttribute("aria-current"));
    if (section) {
      section.setAttribute("aria-current", "step");
      section.open = true;
      if (!manual) scrollTo(section);
    }
  }, [current, manual, open, diagram]);
  useEffect(() => {
    if (!open) return;
    const section = list.current?.querySelector<HTMLElement>(
      `[data-story-beat="${current}"]`
    );
    const actor = Array.from(
      section?.querySelectorAll<HTMLElement>("[data-story-actor]") ?? []
    ).find((el) => el.dataset.storyActor === selection);
    if (actor && (!manual || lastSelection.current !== selection))
      scrollTo(actor);
    lastSelection.current = selection;
  }, [current, selection, open, manual, diagram]);
  useImperativeHandle(ref, () => ({
    nextReference(dir) {
      onPause();
      setManual(true);
      const refs = Array.from(
        list.current?.querySelectorAll<HTMLButtonElement>(
          "[data-flow-code-ref]"
        ) ?? []
      ).filter((el) => !el.disabled);
      if (!refs.length) return;
      let i = refs.findIndex((el) => el === activeReference.current);
      if (i < 0) {
        const first = refs.findIndex(
          (el) =>
            Number(
              el.closest<HTMLElement>("[data-story-beat]")?.dataset.storyBeat ??
                -1
            ) >= current
        );
        i =
          dir === 1
            ? first < 0
              ? 0
              : first
            : first < 0
              ? refs.length - 1
              : (first - 1 + refs.length) % refs.length;
      } else i = (i + dir + refs.length) % refs.length;
      const target = refs[i];
      const section = target.closest<HTMLElement>("[data-story-beat]");
      if (section) onSeek(Number(section.dataset.storyBeat));
      scrollTo(target);
      target.click();
      setFocusReference(target);
      activeReference.current = target;
    },
  }));
  return (
    <aside
      id={id}
      aria-label="Story"
      data-testid="flow-story"
      data-open={open}
      data-mode={watching ? "watch" : "browse"}
      data-playing={playing}
      className="flow-story pointer-events-auto absolute top-2 bottom-2 flex min-h-0 flex-col bg-[var(--color-bg-1)] break-words text-xs text-fg"
      style={{ left: ZOOM_GUTTER, width }}
    >
      <button
        ref={toggle}
        type="button"
        className="flex min-h-10 shrink-0 items-center px-3 text-left text-[13px] font-medium focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={`${id}-content`}
        title={open ? "Collapse Story (S)" : "Expand Story (S)"}
      >
        {open ? (
          <>
            <span>Story</span>
            <span aria-hidden className="ml-auto text-fg-mute">
              ‹
            </span>
          </>
        ) : (
          "›"
        )}
        {!open && <span className="sr-only">Story</span>}
      </button>
      <div
        id={`${id}-content`}
        ref={content}
        hidden={!open}
        className={open ? "flex min-h-0 flex-1 flex-col" : "hidden"}
      >
        <div className="flex items-center justify-between px-3 pb-2 text-[11px] text-fg-mute">
          <span>
            {watching
              ? `${playing ? "Playing" : "Paused"} · beat ${current + 1}`
              : "Story evidence"}
          </span>
          <button
            type="button"
            className="rounded px-2 py-1 hover:bg-[var(--color-bg-2)] focus-visible:ring-2"
            onClick={() => {
              setManual(!manual);
              if (manual) jumpToCurrent();
            }}
          >
            {manual ? "Resume following" : "Browse story"}
          </button>
        </div>
        {manual && (
          <button
            type="button"
            className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] mx-2 rounded border border-[var(--color-line)] p-1 text-[var(--color-accent)]"
            onClick={() => {
              setManual(false);
              jumpToCurrent();
            }}
          >
            Jump to current
          </button>
        )}
        <div
          ref={list}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2"
          tabIndex={0}
          aria-label="Story evidence"
          onScroll={(e) => {
            if (
              !watching &&
              Math.abs(e.currentTarget.scrollTop - scrollTop.current) > 1
            )
              setManual(true);
          }}
          onWheel={() => setManual(true)}
          onTouchMove={() => setManual(true)}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) setManual(true);
          }}
          onClickCapture={(e) => {
            if (e.target instanceof Element) {
              const target = e.target.closest<HTMLElement>(
                "[data-flow-code-ref]"
              );
              if (target) {
                onPause();
                setManual(true);
                activeReference.current?.removeAttribute("aria-current");
                target.setAttribute("aria-current", "location");
                activeReference.current = target;
              }
            }
          }}
          onKeyDown={(e) => {
            if (
              e.altKey ||
              e.ctrlKey ||
              e.metaKey ||
              (e.target instanceof Element &&
                e.target.closest(
                  "input,textarea,select,[contenteditable='true']"
                ))
            )
              return;
            if (
              e.key === "Enter" &&
              e.target instanceof HTMLElement &&
              e.target.tagName === "SUMMARY"
            ) {
              const details = e.target.parentElement;
              if (details instanceof HTMLDetailsElement)
                details.open = !details.open;
              e.preventDefault();
              e.stopPropagation();
              return;
            }
            if (["PageUp", "PageDown", "Home", "End"].includes(e.key)) {
              setManual(true);
              e.stopPropagation();
              return;
            }
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            const items = Array.from(
              e.currentTarget.querySelectorAll<HTMLElement>(
                "summary, button, a[href]"
              )
            ).filter((el) => {
              if (el instanceof HTMLButtonElement && el.disabled) return false;
              if (
                watching &&
                el
                  .closest("[data-story-beat]")
                  ?.getAttribute("aria-current") !== "step"
              )
                return false;
              let p = el.parentElement;
              while (p && p !== list.current) {
                if (
                  p instanceof HTMLDetailsElement &&
                  !p.open &&
                  p.firstElementChild !== el
                )
                  return false;
                p = p.parentElement;
              }
              return true;
            });
            items.sort((a, b) =>
              a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
                ? -1
                : 1
            );
            const i = items.indexOf(document.activeElement as HTMLElement);
            const next =
              i < 0
                ? e.key === "ArrowDown"
                  ? 0
                  : items.length - 1
                : Math.max(
                    0,
                    Math.min(
                      items.length - 1,
                      i + (e.key === "ArrowDown" ? 1 : -1)
                    )
                  );
            items[next]?.focus();
            setManual(true);
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <StoryContents flow={flow} diagram={diagram} groups={groups} />
        </div>
        {inspectors && (
          <div
            className="flow-story-selection max-h-[40%] shrink-0 overflow-y-auto bg-[var(--color-bg-2)] p-3"
            data-testid="flow-story-inspectors"
          >
            <div className="mb-2 text-[11px] text-fg-mute">Selected</div>
            {inspectors}
          </div>
        )}
        <div
          className="shrink-0 px-3 py-2 text-[11px] leading-5 text-fg-mute"
          aria-label="Story keyboard shortcuts"
        >
          ↑↓ navigate · Enter open
          <br />N / ⇧N source · S collapse
        </div>
      </div>
    </aside>
  );
}

const StoryContents = memo(function StoryContents({
  flow,
  diagram,
  groups,
}: {
  flow: CompiledFlow;
  diagram: DiagramTimeline;
  groups: readonly (readonly StoryActor[])[];
}) {
  return (
    <>
      <details className="flow-story-whole mb-3" data-testid="flow-evidence">
        <summary className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] cursor-pointer py-1">
          Whole flow{" "}
          <span className="font-mono text-fg-mute">
            {flow.attachments.length}
          </span>
        </summary>
        <AttachmentPanel attachments={flow.attachments} label="Flow evidence" />
      </details>
      {diagram.beats.map((b, i) => (
        <details
          key={b.id ?? i}
          data-story-beat={i}
          className="flow-story-beat"
        >
          <summary className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] cursor-pointer font-medium">
            <span className="flow-story-number" aria-hidden>
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className="flow-story-caption">{b.caption}</span>
          </summary>
          <AttachmentPanel
            attachments={b.attachments}
            label={`Beat ${i + 1} evidence`}
          />
          {groups[i].map((actor) => (
            <details
              key={actor.key}
              data-story-actor={actor.key}
              className="flow-story-actor"
            >
              <summary className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] cursor-pointer">
                {actor.label}{" "}
                <span className="font-mono text-fg-mute">
                  {actor.attachments.length}{" "}
                  <span className="sr-only">evidence items</span>
                </span>
              </summary>
              <AttachmentPanel
                attachments={actor.attachments}
                label={`${actor.label} evidence`}
              />
            </details>
          ))}
        </details>
      ))}
      {diagram.beats.length === 0 && (
        <AttachmentPanel
          attachments={diagram.rails
            .filter((r) => r.presence !== "absent")
            .flatMap((r) => r.attachments)}
          label="Rail evidence"
        />
      )}
    </>
  );
});
