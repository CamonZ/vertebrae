import { useShellStore } from "../stores/shellStore";
import { useCurrentProject } from "../hooks/useCurrentProject";
import { NotificationsTrigger } from "./Notifications";
import appIcon from "../assets/app-icon.png";

/**
 * On macOS the window uses an overlay title bar (tauri.conf.json
 * `titleBarStyle: Overlay`), so the traffic-light controls float over the
 * top-left of our custom header. Reserve room for them so the brand mark
 * doesn't sit underneath. Other platforms have no overlay controls.
 */
const IS_MACOS =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);

function BrandMark() {
  return (
    <img
      data-testid="topbar-brand"
      src={appIcon}
      alt="Vertebrae"
      width={20}
      height={20}
      draggable={false}
      className="pointer-events-none block h-5 w-5 shrink-0 select-none rounded-[5px]"
    />
  );
}

function Breadcrumb({
  project,
  projectPath,
  page,
}: {
  project: string | null;
  projectPath: string | null;
  page: string;
}) {
  return (
    <span
      data-testid="topbar-breadcrumb"
      className="pointer-events-none flex min-w-0 items-baseline text-[var(--color-fg-faint)]"
    >
      {project && (
        <>
          <span
            data-testid="topbar-breadcrumb-project"
            className="font-sans"
            title={projectPath ?? undefined}
          >
            {project}
          </span>
          <span
            aria-hidden
            className="mx-1.5 text-[var(--color-fg-ghost)]"
          >
            ›
          </span>
        </>
      )}
      <span
        data-testid="topbar-breadcrumb-page"
        className="truncate pl-0.5 font-sans text-[13px] font-medium text-[var(--color-fg)]"
      >
        {page}
      </span>
    </span>
  );
}

// Retained for future use (e.g. a command palette). Not currently rendered in
// the topbar.
export function CommandKChip() {
  return (
    <span
      aria-hidden
      data-testid="topbar-kbd"
      className="hidden items-center gap-1 text-[var(--color-fg-faint)] sm:inline-flex"
    >
      <kbd className="rounded-[var(--radius-xs)] border border-[var(--color-line-strong)] bg-[var(--color-bg-2)] px-[5px] py-px font-mono text-2xs text-[var(--color-fg-mute)]">
        ⌘
      </kbd>
      <kbd className="rounded-[var(--radius-xs)] border border-[var(--color-line-strong)] bg-[var(--color-bg-2)] px-[5px] py-px font-mono text-2xs text-[var(--color-fg-mute)]">
        K
      </kbd>
    </span>
  );
}

export function Header() {
  const project = useCurrentProject();
  const pageTitle = useShellStore((s) => s.pageTitle);
  const headerActions = useShellStore((s) => s.headerActions);

  return (
    <header
      role="banner"
      data-tauri-drag-region
      className={[
        "titlebar relative flex h-[38px] shrink-0 items-center gap-4",
        "bg-[var(--color-canvas)] pr-4",
        IS_MACOS ? "pl-[78px]" : "pl-4",
        "font-mono text-eyebrow tracking-[0.04em] text-[var(--color-fg-mute)]",
      ].join(" ")}
    >
      <BrandMark />
      <Breadcrumb
        project={project.name}
        projectPath={project.path}
        page={pageTitle || "Vertebrae"}
      />
      <div
        data-testid="topbar-activity"
        className="titlebar-button ml-auto flex items-center gap-3"
      >
        {headerActions}
        <NotificationsTrigger />
      </div>
    </header>
  );
}
