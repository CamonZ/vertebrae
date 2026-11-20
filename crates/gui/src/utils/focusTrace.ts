/**
 * Dev-only focus tracer. Records focus moves, programmatic focus()/blur()
 * calls (with stacks), silent activeElement changes (removal, disabling) and
 * the chat-store update that preceded each, so a composer losing focus can be
 * attributed to its cause.
 *
 * A "loss" is a focus-keep input (see `focusKeep.ts`) losing focus without a
 * user action: no pointer press or key press in the preceding moment, and the
 * app window still focused. Losses log a `[FOCUS_TRACE]` warning and show a
 * small badge; ⌃⌥⇧F copies the whole trace as JSON (also reachable as
 * `window.__vtbFocusTrace.export()`).
 */
import { useChatStore } from "../stores/chatStore";
import { isFocusKeepInput } from "./focusKeep";

export interface FocusTraceEntry {
  at: number;
  kind:
    | "focusin"
    | "focusout"
    | "focus-call"
    | "blur-call"
    | "silent-change"
    | "user"
    | "recovered"
    | "loss";
  target: string;
  related?: string | null;
  active?: string | null;
  event?: string | null;
  store?: string | null;
  reason?: string;
  stack?: string;
}

export interface FocusTrace {
  entries(): FocusTraceEntry[];
  losses(): FocusTraceEntry[];
  export(): string;
  clear(): void;
  uninstall(): void;
}

const MAX_ENTRIES = 1000;
/** A pointer or key press this recent explains a focus move. */
const USER_ACTION_WINDOW_MS = 600;
const SILENT_POLL_MS = 200;
const COPY_SHORTCUT = { key: "F", ctrlKey: true, altKey: true, shiftKey: true };

export function describeElement(element: Element | null | undefined): string {
  if (!element) return "null";
  if (element === document.body) return "body";
  const parts = [element.tagName.toLowerCase()];
  const testId = element.getAttribute("data-testid");
  if (testId) parts.push(`[testid=${testId}]`);
  const label = element.getAttribute("aria-label");
  if (label) parts.push(`[aria=${label.slice(0, 40)}]`);
  if (element.id) parts.push(`#${element.id}`);
  const pane = element.closest("[data-pane-id]")?.getAttribute("data-pane-id");
  if (pane) parts.push(`@pane:${pane.slice(0, 8)}`);
  if (!element.isConnected) parts.push("(detached)");
  return parts.join("");
}

function describeStoreChange(
  previous: ReturnType<typeof useChatStore.getState>,
  next: ReturnType<typeof useChatStore.getState>
): string {
  const keys = (Object.keys(next) as (keyof typeof next)[]).filter(
    (key) => typeof next[key] !== "function" && next[key] !== previous[key]
  );
  const sessions =
    next.sessions !== previous.sessions
      ? Object.keys(next.sessions)
          .filter((id) => next.sessions[id] !== previous.sessions[id])
          .slice(0, 4)
          .map((id) => `${id.slice(0, 8)}:${next.sessions[id]?.lifecycle ?? "gone"}`)
      : [];
  return `${keys.join(",")}${sessions.length ? ` sessions=${sessions.join(" ")}` : ""}`;
}

export function installFocusTrace(): FocusTrace {
  // Hot reloads install again; one tracer at a time.
  (window as unknown as { __vtbFocusTrace?: FocusTrace }).__vtbFocusTrace?.uninstall();
  const entries: FocusTraceEntry[] = [];
  let lastUserAction = { at: -Infinity, what: "" };
  let lastStore: { at: number; summary: string } | null = null;
  let lastActive: Element | null = document.activeElement;
  let focusEventSinceCheck = false;
  let badge: HTMLButtonElement | null = null;

  const record = (entry: Omit<FocusTraceEntry, "at">) => {
    const full = { at: Math.round(performance.now()), ...entry };
    entries.push(full);
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    return full;
  };
  const storeNote = () =>
    lastStore && performance.now() - lastStore.at < 1000
      ? `${Math.round(performance.now() - lastStore.at)}ms ago: ${lastStore.summary}`
      : null;
  const userActed = () =>
    performance.now() - lastUserAction.at < USER_ACTION_WINDOW_MS;

  const losses = () => entries.filter((entry) => entry.kind === "loss");
  const exportTrace = () =>
    JSON.stringify({ exportedAt: new Date().toISOString(), entries }, null, 2);
  const showBadge = () => {
    const count = losses().length;
    if (!badge) {
      badge = document.createElement("button");
      badge.type = "button";
      badge.setAttribute("data-testid", "focus-trace-badge");
      badge.title = "Unexplained focus losses (dev). Click or ⌃⌥⇧F to copy the trace.";
      Object.assign(badge.style, {
        position: "fixed",
        left: "8px",
        bottom: "8px",
        zIndex: "2147483647",
        padding: "2px 8px",
        borderRadius: "999px",
        font: "11px/1.6 var(--font-mono, monospace)",
        background: "var(--color-err-wash)",
        color: "var(--color-err)",
        border: "1px solid var(--color-err)",
      });
      badge.addEventListener("mousedown", (event) => event.preventDefault());
      badge.addEventListener("click", () => void copy());
      document.body.append(badge);
    }
    badge.textContent = `focus lost ×${count}`;
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(exportTrace());
      console.info("[FOCUS_TRACE] copied", entries.length, "entries");
    } catch (error) {
      console.warn("[FOCUS_TRACE] copy failed", error);
    }
  };

  const reportLoss = (input: Element, reason: string, active: Element | null) => {
    const recentCalls = entries
      .filter((entry) => entry.kind === "focus-call" || entry.kind === "blur-call")
      .slice(-1)
      .filter((entry) => performance.now() - entry.at < 100);
    const loss = record({
      kind: "loss",
      target: describeElement(input),
      active: describeElement(active),
      reason,
      store: storeNote(),
      stack: recentCalls[0]?.stack,
    });
    console.warn("[FOCUS_TRACE] focus lost", loss);
    showBadge();
  };

  const onUser = (event: Event) => {
    if (event instanceof KeyboardEvent) {
      if (
        event.key === COPY_SHORTCUT.key &&
        event.ctrlKey &&
        event.altKey &&
        event.shiftKey
      ) {
        event.preventDefault();
        void copy();
        return;
      }
      // Typing into the focused input never moves focus.
      const moving =
        event.key === "Tab" ||
        event.key === "Escape" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.key.startsWith("Arrow") ||
        event.key === "F6";
      if (!moving) return;
      lastUserAction = { at: performance.now(), what: `key:${event.key}` };
    } else {
      lastUserAction = { at: performance.now(), what: event.type };
    }
    record({
      kind: "user",
      target: describeElement(event.target as Element),
      event: lastUserAction.what,
    });
  };

  const onFocusIn = (event: FocusEvent) => {
    focusEventSinceCheck = true;
    lastActive = event.target as Element;
    record({
      kind: "focusin",
      target: describeElement(event.target as Element),
      related: describeElement(event.relatedTarget as Element | null),
    });
  };
  const onFocusOut = (event: FocusEvent) => {
    focusEventSinceCheck = true;
    const target = event.target as Element;
    record({
      kind: "focusout",
      target: describeElement(target),
      related: describeElement(event.relatedTarget as Element | null),
      store: storeNote(),
    });
    if (!isFocusKeepInput(target)) return;
    const explained = userActed();
    const reason = () =>
      !target.isConnected
        ? "removed"
        : target.disabled
          ? "disabled"
          : event.relatedTarget
            ? "moved-programmatically"
            : "blurred";
    setTimeout(() => {
      const active = document.activeElement;
      lastActive = active;
      if (active === target || !document.hasFocus() || explained) return;
      const cause = reason();
      // A guard may take focus back; only a lasting loss counts.
      setTimeout(() => {
        if (document.activeElement === target) {
          record({ kind: "recovered", target: describeElement(target), reason: cause });
          return;
        }
        reportLoss(target, cause, document.activeElement);
      }, 100);
    }, 0);
  };

  const originalFocus = HTMLElement.prototype.focus;
  const originalBlur = HTMLElement.prototype.blur;
  HTMLElement.prototype.focus = function tracedFocus(
    this: HTMLElement,
    options?: FocusOptions
  ) {
    const from = document.activeElement;
    if (from !== this) {
      record({
        kind: "focus-call",
        target: describeElement(this),
        active: describeElement(from),
        event: window.event?.type ?? null,
        store: storeNote(),
        stack: new Error().stack?.split("\n").slice(2, 10).join("\n"),
      });
    }
    return originalFocus.call(this, options);
  };
  HTMLElement.prototype.blur = function tracedBlur(this: HTMLElement) {
    record({
      kind: "blur-call",
      target: describeElement(this),
      event: window.event?.type ?? null,
      stack: new Error().stack?.split("\n").slice(2, 10).join("\n"),
    });
    return originalBlur.call(this);
  };

  // Removing or disabling a focused element moves focus without an event.
  const poll = window.setInterval(() => {
    const active = document.activeElement;
    const previous = lastActive;
    const sawEvent = focusEventSinceCheck;
    focusEventSinceCheck = false;
    lastActive = active;
    if (active === previous || sawEvent) return;
    record({
      kind: "silent-change",
      target: describeElement(previous),
      active: describeElement(active),
      store: storeNote(),
    });
    if (isFocusKeepInput(previous) && !userActed() && document.hasFocus())
      reportLoss(
        previous,
        !previous.isConnected
          ? "removed-silently"
          : previous.disabled
            ? "disabled-silently"
            : "unrendered-silently",
        active
      );
  }, SILENT_POLL_MS);

  const unsubscribeStore = useChatStore.subscribe((next, previous) => {
    lastStore = { at: performance.now(), summary: describeStoreChange(previous, next) };
  });

  window.addEventListener("pointerdown", onUser, true);
  window.addEventListener("keydown", onUser, true);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);

  const trace: FocusTrace = {
    entries: () => [...entries],
    losses,
    export: exportTrace,
    clear: () => {
      entries.length = 0;
      badge?.remove();
      badge = null;
    },
    uninstall: () => {
      window.clearInterval(poll);
      unsubscribeStore();
      window.removeEventListener("pointerdown", onUser, true);
      window.removeEventListener("keydown", onUser, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      HTMLElement.prototype.focus = originalFocus;
      HTMLElement.prototype.blur = originalBlur;
      badge?.remove();
      badge = null;
    },
  };
  (window as unknown as { __vtbFocusTrace?: FocusTrace }).__vtbFocusTrace = trace;
  return trace;
}
