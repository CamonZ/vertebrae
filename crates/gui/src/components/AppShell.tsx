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

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--color-bg)]">
      <Header />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar />
        <div className="flex min-w-0 flex-1 overflow-hidden">
          <ContentArea>{children}</ContentArea>
          <LiveChatPanel />
        </div>
      </div>
      <ChatWindowManager />
      <ToastContainer />
    </div>
  );
}
