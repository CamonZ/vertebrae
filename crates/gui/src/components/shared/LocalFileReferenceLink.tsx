import { useState, type ReactNode } from "react";
import { commands } from "../../bindings";
import { useUIStore } from "../../stores/uiStore";
import { addDebugLog } from "../../utils/debugLog";
import type { LocalFileReference } from "./localFileReference";

interface LocalFileReferenceLinkProps {
  reference: LocalFileReference;
  projectRoot: string;
  children: ReactNode;
}

export function LocalFileReferenceLink({
  reference,
  projectRoot,
  children,
}: LocalFileReferenceLinkProps) {
  const [opening, setOpening] = useState(false);
  const externalEditor = useUIStore((state) => state.externalEditor);

  const openFile = async () => {
    if (opening) {
      addDebugLog(
        `[LOCAL_FILE] Ignoring duplicate open click path=${reference.path}`
      );
      return;
    }
    const selectedEditor = externalEditor.trim() || null;
    addDebugLog(
      `[LOCAL_FILE] click root=${projectRoot} path=${reference.path} line=${reference.line ?? "-"} column=${reference.column ?? "-"} editor=${selectedEditor ?? "system-default"}`
    );
    setOpening(true);
    try {
      const result = await commands.openLocalFile(
        projectRoot,
        reference.path,
        reference.line,
        reference.column,
        selectedEditor
      );
      addDebugLog(
        `[LOCAL_FILE] command result=${result.status}`,
        result.status === "error" ? "ERROR" : "INFO"
      );
      if (result.status === "error") {
        addDebugLog(`[LOCAL_FILE] command error=${result.error}`, "ERROR");
      }
    } catch (error) {
      addDebugLog(`[LOCAL_FILE] command exception=${String(error)}`, "ERROR");
    } finally {
      setOpening(false);
    }
  };

  return (
    <button
      type="button"
      className="inline cursor-pointer rounded-sm bg-bg/80 px-1.5 py-0.5 font-mono text-13 text-accent underline decoration-accent/30 hover:decoration-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      data-testid="local-file-reference-link"
      data-file-path={reference.path}
      data-file-line={reference.line ?? undefined}
      data-file-column={reference.column ?? undefined}
      aria-busy={opening}
      title="Open in external editor"
      onClick={() => void openFile()}
    >
      <span className="pointer-events-none">{children}</span>
    </button>
  );
}
