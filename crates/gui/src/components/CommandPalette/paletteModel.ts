export type PaletteScope =
  | "all"
  | "navigate"
  | "tasks"
  | "chats"
  | "workflows"
  | "actions";

export interface PaletteItem {
  id: string;
  scope: Exclude<PaletteScope, "all">;
  label: string;
  /** Secondary text: short ID, path, or shortcut. Rendered in mono. */
  detail?: string;
  /** Muted context in the UI font, e.g. the ticket a chat belongs to. */
  hint?: string;
  /** Extra words that should match the query but are not displayed. */
  keywords?: string;
  run: () => void | Promise<void>;
}

/** Every whitespace-separated query token must appear in the haystack. */
export function matchesQuery(item: PaletteItem, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack =
    `${item.label} ${item.hint ?? ""} ${item.detail ?? ""} ${item.keywords ?? ""}`.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

export function isPaletteShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">
): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === "k"
  );
}

/** Rank items whose visible label matches every token above keyword-only hits. */
export function labelMatchesQuery(item: PaletteItem, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const label = item.label.toLowerCase();
  return tokens.length > 0 && tokens.every((token) => label.includes(token));
}

/** True when the key event starts in a text field, so "/" types normally. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

/** The chat fields the palette reads; satisfied by stored summaries and live sessions. */
export interface PaletteChatSource {
  id: string;
  label: string;
  title?: string | null;
  association?: unknown;
  updatedAt?: string;
  status?: "open" | "closed";
  hasUserMessage?: boolean;
  messageCount?: number;
}

export interface PaletteChatEntry {
  sessionId: string;
  label: string;
  /** Linked ticket title, shown beside the chat title. */
  hint?: string;
  /** Linked ticket short ID. */
  detail?: string;
  keywords: string;
  open: boolean;
}

function chatTicket(association: unknown): { id: string; title: string } | null {
  if (!association || typeof association !== "object" || Array.isArray(association)) {
    return null;
  }
  const record = association as Record<string, unknown>;
  const id = typeof record.ticketId === "string" ? record.ticketId.trim() : "";
  if (!id) return null;
  const title =
    typeof record.ticketTitle === "string" ? record.ticketTitle.trim() : "";
  return { id, title };
}

/**
 * Every chat worth reopening: open sessions plus saved history, most recent
 * first. A chat linked to a ticket matches on the ticket's ID and title and
 * shows the ticket beside its own title.
 */
export function paletteChatEntries(
  sources: Iterable<PaletteChatSource>,
  taskTitles: ReadonlyMap<string, string>
): PaletteChatEntry[] {
  const byId = new Map<string, PaletteChatSource>();
  for (const source of sources) {
    const previous = byId.get(source.id);
    byId.set(source.id, previous ? { ...previous, ...source } : source);
  }
  return [...byId.values()]
    .filter(
      (chat) =>
        chat.status === "open" ||
        chat.hasUserMessage === true ||
        (chat.hasUserMessage === undefined && (chat.messageCount ?? 0) > 0)
    )
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .map((chat) => {
      const ticket = chatTicket(chat.association);
      const ticketTitle = ticket
        ? ticket.title || taskTitles.get(ticket.id) || ""
        : "";
      const label = chat.title?.trim() || chat.label.trim() || "New Chat";
      return {
        sessionId: chat.id,
        label,
        hint: ticketTitle || undefined,
        detail: ticket ? ticket.id.slice(0, 8) : undefined,
        keywords: [chat.label, ticket?.id ?? "", ticketTitle].join(" "),
        open: chat.status === "open",
      };
    });
}
