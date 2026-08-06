import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { ContentArea } from "./ContentArea";
import { ChatWindowManager, FloatingChatLauncher } from "./ChatWindow";
import { NotificationsPanel } from "./Notifications";

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
        </div>
      </div>
      <ChatWindowManager />
      <FloatingChatLauncher />
      <NotificationsPanel />
    </div>
  );
}
