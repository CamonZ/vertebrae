import { useLiveChatStore } from "../../stores/liveChatStore";

interface OpenLiveChatButtonProps {
  className?: string;
}

export function OpenLiveChatButton({ className = "" }: OpenLiveChatButtonProps) {
  const panelOpen = useLiveChatStore((s) => s.panelOpen);
  const togglePanel = useLiveChatStore((s) => s.togglePanel);

  return (
    <button
      onClick={togglePanel}
      aria-pressed={panelOpen}
      title={panelOpen ? "Close live chat" : "Open live chat"}
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-bg-hover ${
        panelOpen
          ? "bg-primary/10 text-primary"
          : "text-text-secondary hover:text-text-primary"
      } ${className}`}
    >
      <svg
        className="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M3 10c0-3.866 4.03-7 9-7s9 3.134 9 7-4.03 7-9 7c-1.13 0-2.21-.16-3.21-.46L3 19l1.46-4.79C3.55 12.93 3 11.52 3 10z"
        />
      </svg>
      Live Chat
    </button>
  );
}
