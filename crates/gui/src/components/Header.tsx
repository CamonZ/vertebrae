import { ConnectionStatus } from "./ConnectionStatus";
import { OpenLiveChatButton } from "./LiveChatWindow";
import { useShellStore } from "../stores/shellStore";
import { useCurrentProject } from "../hooks/useCurrentProject";

/**
 * Page-level header. Breadcrumb on the left (project › page); contextual
 * status/actions slot on the right, contributed by the active page via
 * the useShellHeader hook.
 */
export function Header() {
  const project = useCurrentProject();
  const pageTitle = useShellStore((s) => s.pageTitle);
  const headerActions = useShellStore((s) => s.headerActions);

  return (
    <header
      role="banner"
      className={[
        "titlebar relative flex h-12 shrink-0 items-center justify-between gap-4",
        "border-b border-[var(--color-line)] bg-[var(--color-bg)] px-6",
      ].join(" ")}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        {project.name && (
          <>
            <span
              className="font-sans text-sm text-[var(--color-fg-mute)]"
              title={project.path ?? undefined}
            >
              {project.name}
            </span>
            <span
              aria-hidden
              className="text-sm text-[var(--color-fg-faint)]"
            >
              ›
            </span>
          </>
        )}
        <h1 className="truncate font-serif text-xl font-normal text-[var(--color-fg)]">
          {pageTitle || "Vertebrae"}
        </h1>
      </div>
      <div className="titlebar-button flex items-center gap-3">
        {headerActions}
        <OpenLiveChatButton />
        <ConnectionStatus />
      </div>
    </header>
  );
}
