import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  getFiletypeFromFileName,
  ResolvedLanguages,
  resolveLanguage,
} from "@pierre/diffs";
import { File, WorkerPoolContext } from "@pierre/diffs/react";
import type { SupportedLanguages } from "@pierre/diffs/react";
import { usePierreThemeOptions } from "../../hooks/useCodeAppearance";
import { CODE_HIGHLIGHTER } from "../../utils/codeAppearance";
import { diffWorkerPool } from "../thread/toolChange/diffWorkerPool";

/** Map a fence info string ("ts", "rust", "sh") to a Pierre language. */
function snippetLanguage(language: string): SupportedLanguages {
  if (language === "text") return "text";
  const fromExtension = getFiletypeFromFileName(`snippet.${language}`);
  return fromExtension !== "text"
    ? fromExtension
    : (language as SupportedLanguages);
}

/**
 * Highlights renders unsupported languages as text by itself. Shiki has to
 * load a grammar first and rejects unknown ones, so on the fallback engine
 * an unknown language renders as text.
 */
function useResolvedLanguage(language: string): SupportedLanguages {
  const candidate = snippetLanguage(language);
  const ready =
    CODE_HIGHLIGHTER === "highlights" ||
    candidate === "text" ||
    ResolvedLanguages.has(candidate);
  const [resolved, setResolved] = useState<string | null>(null);

  useEffect(() => {
    if (ready) return;
    let cancelled = false;
    resolveLanguage(candidate as Exclude<SupportedLanguages, "text">)
      .then(() => !cancelled && setResolved(candidate))
      .catch(() => !cancelled && setResolved("text"));
    return () => {
      cancelled = true;
    };
  }, [candidate, ready]);

  if (ready) return candidate;
  return resolved === candidate ? candidate : "text";
}

// Pierre styles live in a shadow root; these inherited variables carry the
// chat's font and spacing across the boundary.
const snippetStyle = {
  "--diffs-font-family": "var(--font-mono)",
  "--diffs-header-font-family": "var(--font-mono)",
  "--diffs-font-size": "var(--text-13)",
  "--diffs-line-height": "1.6",
  "--diffs-gap-block": "0.75rem",
  "--diffs-gap-inline": "0.75rem",
} as CSSProperties;

interface CodeSnippetProps {
  language: string;
  source: string;
}

/**
 * A fenced chat code block rendered with Pierre's File: in-memory source,
 * explicit language, no file header and no line numbers. Loaded lazily so
 * Pierre stays out of the main chunk.
 */
export default function CodeSnippet({ language, source }: CodeSnippetProps) {
  const themeOptions = usePierreThemeOptions();
  const lang = useResolvedLanguage(language);
  const file = useMemo(
    () => ({ name: "snippet", contents: source, lang }),
    [source, lang]
  );
  const options = useMemo(
    () => ({
      ...themeOptions,
      disableFileHeader: true,
      disableLineNumbers: true,
      overflow: "scroll" as const,
    }),
    [themeOptions]
  );

  return (
    <WorkerPoolContext.Provider value={diffWorkerPool}>
      <File
        file={file}
        options={options}
        style={snippetStyle}
        className="block"
      />
    </WorkerPoolContext.Provider>
  );
}
