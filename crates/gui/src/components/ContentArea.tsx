import { ReactNode } from "react";

interface ContentAreaProps {
  children: ReactNode;
}

export function ContentArea({ children }: ContentAreaProps) {
  return (
    <main
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-bg"
      role="main"
      aria-label="Main content"
    >
      {children}
    </main>
  );
}
