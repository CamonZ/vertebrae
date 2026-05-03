import { ReactNode } from "react";
import { ToastContainer } from "./Toast";
import { GlobalListeners } from "./GlobalListeners";

interface WindowLayoutProps {
  children: ReactNode;
}

/**
 * Layout for pop-out windows. GlobalListeners must mount inside each window
 * because Zustand stores are not shared across Tauri windows — every window
 * bootstraps its own subscriptions to backend events.
 */
export function WindowLayout({ children }: WindowLayoutProps) {
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg-primary">
      <GlobalListeners />
      <main
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        role="main"
        aria-label="Pop-out window content"
      >
        {children}
      </main>
      <ToastContainer />
    </div>
  );
}
