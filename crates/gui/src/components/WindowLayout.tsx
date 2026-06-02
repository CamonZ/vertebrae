import { ReactNode, useEffect } from "react";
import { useTheme } from "../hooks";
import { ToastContainer } from "./Toast";
import { GlobalListeners } from "./GlobalListeners";

interface WindowLayoutProps {
  children: ReactNode;
  /**
   * Make the pop-out window background see-through (paired with the Tauri
   * window's `transparent: true`). Adds a class to this window's
   * documentElement so the global `body` background is nulled out — scoped to
   * this window's DOM, so the main app window is unaffected. Used by panels
   * that render a floating-glass surface (e.g. the detached task detail).
   */
  transparent?: boolean;
}

/**
 * Layout for pop-out windows. GlobalListeners must mount inside each window
 * because Zustand stores are not shared across Tauri windows — every window
 * bootstraps its own subscriptions to backend events.
 */
export function WindowLayout({ children, transparent = false }: WindowLayoutProps) {
  useTheme();

  useEffect(() => {
    if (!transparent) return;
    const root = document.documentElement;
    root.classList.add("window-transparent");
    return () => root.classList.remove("window-transparent");
  }, [transparent]);

  return (
    <div
      className={[
        "flex h-screen w-screen flex-col overflow-hidden",
        transparent ? "bg-transparent" : "bg-bg",
      ].join(" ")}
    >
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
