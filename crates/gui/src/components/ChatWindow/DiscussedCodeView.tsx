import { useMemo } from "react";
import { PatchDiff, WorkerPoolContext } from "@pierre/diffs/react";
import { usePierreDiffOptions } from "../../hooks/useCodeAppearance";
import { diffWorkerPool } from "../thread/toolChange/diffWorkerPool";
import CodeSnippet from "../shared/CodeSnippet";
import { languageOf, type DiscussedCode } from "./selectionDiscussions";

/**
 * The code a discussion is about, highlighted as the Changes view shows it:
 * its diff chunk with the discussed lines selected, or the selected code.
 * Loaded lazily so Pierre stays out of the main chunk.
 */
export default function DiscussedCodeView({ code }: { code: DiscussedCode }) {
  const diffOptions = usePierreDiffOptions();
  // The discussion's header already names the file and lines, and the
  // chunk's unchanged surroundings cannot be expanded here.
  const options = useMemo(
    () => ({
      ...diffOptions,
      disableFileHeader: true,
      hunkSeparators: "simple" as const,
    }),
    [diffOptions]
  );
  if (code.kind === "code")
    return <CodeSnippet language={languageOf(code.path)} source={code.code} />;
  return (
    <WorkerPoolContext.Provider value={diffWorkerPool}>
      <PatchDiff
        patch={code.patch}
        options={options}
        selectedLines={code.selection}
      />
    </WorkerPoolContext.Provider>
  );
}
