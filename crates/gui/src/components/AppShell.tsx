import { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { ContentArea } from "./ContentArea";
import { ToastContainer } from "./Toast";
import { ChatPanel } from "./ChatPanel";

interface AppShellProps {
  children: ReactNode;
  title?: string;
  subtitle?: string;
}

export function AppShell({
  children,
  title = "Vertebrae",
  subtitle = "Task Management",
}: AppShellProps) {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg-secondary">
      <Sidebar />
      <ChatPanel />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header title={title} subtitle={subtitle} />
        <ContentArea>{children}</ContentArea>
      </div>
      <ToastContainer />
    </div>
  );
}
