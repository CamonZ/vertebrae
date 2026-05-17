import { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { ContentArea } from "./ContentArea";
import { ToastContainer } from "./Toast";
import { ChatWindowManager } from "./ChatWindow";
import { LiveChatPanel } from "./LiveChatWindow";

interface AppShellProps {
  children: ReactNode;
  title?: string;
  subtitle?: string;
}

export function AppShell({
  children,
  title = "Vertebrae",
  subtitle = "Agent Orchestrator",
}: AppShellProps) {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg-secondary">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header title={title} subtitle={subtitle} />
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
