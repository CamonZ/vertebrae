import { useEffect, type ReactNode } from "react";
import { useShellStore } from "../stores/shellStore";

/**
 * Pages declare their header contents through this hook. The title sets the
 * right side of the breadcrumb; actions render in the header's right slot.
 * Both clear automatically when the calling component unmounts.
 */
export function useShellHeader(title: string, actions?: ReactNode): void {
  useEffect(() => {
    const { setPageTitle, setHeaderActions } = useShellStore.getState();
    setPageTitle(title);
    setHeaderActions(actions ?? null);
    return () => {
      setPageTitle("");
      setHeaderActions(null);
    };
  }, [title, actions]);
}
