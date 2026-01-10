import { ReactNode } from "react";

interface ContentAreaProps {
  children: ReactNode;
}

export function ContentArea({ children }: ContentAreaProps) {
  return (
    <main
      className="flex-1 overflow-auto bg-bg-secondary p-6"
      role="main"
      aria-label="Main content"
    >
      {children}
    </main>
  );
}
