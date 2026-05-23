import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { ContentArea } from "./ContentArea";
import { ToastContainer } from "./Toast";
import { ChatWindowManager } from "./ChatWindow";
import { LiveChatPanel } from "./LiveChatWindow";

interface AppShellProps {
  children: ReactNode;
}

/**
 * Root layout: fixed-width Sidebar + Header above a scrolling ContentArea.
 * The Header reads its title and right-side actions from `useShellStore`,
 * which pages populate via `useShellHeader`.
 */
export function AppShell({ children }: AppShellProps) {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--color-bg)]">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <ContentArea>{children}</ContentArea>
          <LiveChatPanel />
        </div>
      </div>
      <ChatWindowManager />
      <ToastContainer />
    </div>
  );
}
