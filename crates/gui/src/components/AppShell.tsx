import { ReactNode, useState, useCallback } from "react";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { ContentArea } from "./ContentArea";

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
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  const handleSidebarToggle = useCallback(() => {
    setIsSidebarCollapsed((prev) => !prev);
  }, []);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg-secondary">
      <Sidebar
        isCollapsed={isSidebarCollapsed}
        onToggle={handleSidebarToggle}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header title={title} subtitle={subtitle} />
        <ContentArea>{children}</ContentArea>
      </div>
    </div>
  );
}
