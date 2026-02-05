import { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { ContentArea } from "./ContentArea";
import { ToastContainer } from "./Toast";
import { ClaudeChatSidebar } from "./ClaudeChatSidebar";

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
        <ContentArea>{children}</ContentArea>
      </div>
      <ClaudeChatSidebar />
      <ToastContainer />
    </div>
  );
}
