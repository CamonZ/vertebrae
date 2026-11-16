import type { SupportedLanguages } from "@pierre/diffs";
import { Component, lazy, Suspense, type ReactNode } from "react";

const PierrePanelCode = lazy(() => import("./PierrePanelCode"));

export interface PanelCodeProps {
  source: string;
  language: SupportedLanguages | "rhai";
  /** Infer syntax from an artifact filename when supplied. */
  filename?: string;
  label: string;
  /** Snapshot at editor mount. Remount on entity changes or explicit replacement. */
  onChange?: (source: string) => void;
  error?: string | null;
}

class CodeBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Lazy panel source surface. A load/render failure retains a usable draft. */
export function PanelCode(props: PanelCodeProps) {
  const fallback = props.onChange ? (
    <textarea
      aria-label={props.label}
      aria-invalid={!!props.error}
      aria-description={props.error ?? undefined}
      value={props.source}
      onChange={(event) => props.onChange?.(event.target.value)}
      spellCheck={false}
      className="w-full min-h-32 font-mono"
    />
  ) : (
    <pre className="p-3 whitespace-pre-wrap">{props.source}</pre>
  );
  return (
    <div className="min-w-0 max-w-full max-h-96 overflow-auto rounded-md border border-border bg-bg text-xs">
      <CodeBoundary fallback={fallback}>
        <Suspense fallback={fallback}>
          <PierrePanelCode {...props} />
        </Suspense>
      </CodeBoundary>
    </div>
  );
}
