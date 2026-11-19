import { useEffect, useState } from "react";
import { commands } from "../../../bindings";
import { useOpenLocalFile } from "../../../hooks/useOpenLocalFile";

type Probe = { key: string; available: boolean; error?: string };
/** Always opens the displayed file's corresponding local working copy. */
export function OpenInExternalEditor({
  root,
  path,
  line = null,
  column = null,
  available,
  shortcut,
}: {
  root: string;
  path: string;
  line?: number | null;
  column?: number | null;
  available?: boolean;
  shortcut?: string;
}) {
  const {
    open,
    opening,
    error: launchError,
  } = useOpenLocalFile(root, path, line, column);
  const key = JSON.stringify([root, path]);
  const [probe, setProbe] = useState<Probe | null>(null);
  useEffect(() => {
    if (available !== undefined) return;
    let current = true;
    commands.worktreeFileExists(root, path).then(
      (result) => {
        if (!current) return;
        setProbe(
          result.status === "ok"
            ? { key, available: result.data }
            : { key, available: false, error: result.error.message }
        );
      },
      (error: unknown) => {
        if (current) setProbe({ key, available: false, error: String(error) });
      }
    );
    return () => {
      current = false;
    };
  }, [key, root, path, available]);
  const localAvailable = available ?? (probe?.key === key && probe.available);
  const probeError =
    available === undefined && probe?.key === key ? probe.error : null;
  return (
    <>
      <button
        type="button"
        className="evidence-action"
        disabled={!localAvailable || opening}
        title={
          localAvailable
            ? `Open the local working-tree file in the app's configured editor${shortcut ? ` (${shortcut})` : ""}`
            : "The corresponding local working-tree file is unavailable"
        }
        onClick={() => {
          if (localAvailable) void open();
        }}
      >
        Open in external editor
      </button>
      {(probeError || launchError) && (
        <span role="alert">{probeError || launchError}</span>
      )}
    </>
  );
}
