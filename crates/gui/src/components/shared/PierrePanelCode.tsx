import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  File,
  EditProvider,
  WorkerPoolContext,
  type EditorFactory,
} from "@pierre/diffs/react";
import { getFiletypeFromFileName } from "@pierre/diffs";
import { useResolvedLanguage } from "./CodeSnippet";
import { Editor } from "@pierre/diffs/edit";
import { usePierreThemeOptions } from "../../hooks/useCodeAppearance";
import { diffWorkerPool } from "../thread/toolChange/diffWorkerPool";
import type { PanelCodeProps } from "./PanelCode";

const createEditor: EditorFactory<undefined, undefined> = (
  type,
  options,
  key
) => new Editor(type, options, key);
const style = {
  "--diffs-font-family": "var(--font-mono)",
  "--diffs-font-size": "var(--text-13)",
  "--diffs-line-height": "1.6",
} as CSSProperties;

/** Rhai uses the documented JS lexical approximation, never Rust. */
function panelLanguage(language: PanelCodeProps["language"]) {
  return language === "rhai" ? "javascript" : language;
}

export default function PierrePanelCode({
  source,
  language,
  filename,
  label,
  onChange,
  error,
}: PanelCodeProps) {
  const inferred = filename ? getFiletypeFromFileName(filename) : null;
  const lang = useResolvedLanguage(
    inferred && inferred !== "markdown" ? inferred : panelLanguage(language)
  );
  const editable = !!onChange;
  const theme = usePierreThemeOptions();
  const host = useRef<HTMLDivElement>(null);
  // Never feed per-keystroke source back into Pierre: that resets edit history.
  const [initialFile] = useState(() => ({
    name: label,
    contents: source,
    lang: panelLanguage(language),
  }));
  const file = useMemo(
    () => (editable ? initialFile : { name: label, contents: source, lang }),
    [editable, initialFile, label, source, lang]
  );
  const options = useMemo(
    () => ({
      ...theme,
      disableFileHeader: true,
      disableLineNumbers: editable,
      overflow: editable ? ("scroll" as const) : ("wrap" as const),
    }),
    [theme, editable]
  );

  // Pierre names its shadow-DOM textbox from file.name. Error descriptions
  // must also live on that textbox; ID references cannot cross shadow roots.
  useEffect(() => {
    if (!editable) return;
    const element = host.current?.querySelector("diffs-container");
    const shadow = element?.shadowRoot;
    if (!shadow) return;
    const update = () => {
      const input = shadow.querySelector('[role="textbox"]');
      if (!input) return;
      input.setAttribute("aria-invalid", String(!!error));
      if (error) input.setAttribute("aria-description", error);
      else input.removeAttribute("aria-description");
    };
    // These editors live in forms: Tab/Shift+Tab navigate to adjacent fields.
    // Pierre still supports indentation through Cmd/Ctrl+[ and Cmd/Ctrl+].
    const navigate = (event: Event) => {
      if (
        event instanceof KeyboardEvent &&
        event.key === "Tab" &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        event.target instanceof Element &&
        event.target.closest('[role="textbox"]')
      ) {
        event.stopPropagation();
      }
    };
    shadow.addEventListener("keydown", navigate, true);
    const observer = new MutationObserver(update);
    observer.observe(shadow, { childList: true, subtree: true });
    update();
    return () => {
      observer.disconnect();
      shadow.removeEventListener("keydown", navigate, true);
    };
  }, [editable, error]);

  return (
    <div ref={host}>
      <WorkerPoolContext.Provider value={diffWorkerPool}>
        <EditProvider createEditor={createEditor}>
          <File
            file={file}
            options={options}
            style={style}
            edit={editable}
            onEditChange={(event) => onChange?.(event.file.contents)}
            onEditComplete={() => "accept"}
          />
        </EditProvider>
      </WorkerPoolContext.Provider>
    </div>
  );
}
