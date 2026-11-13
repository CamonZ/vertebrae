import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createContext, lazy, Suspense, useContext, useState } from "react";
import { useArtifactPresentations } from "../../../hooks/useArtifactPresentations";
import { queryClient } from "../../../query/queryClient";
import type { SourceLocation } from "../../shared/EvidenceNavigationContext";
import type { AttachmentSpec } from "./spec";

export interface AttachmentRenderContext {
  openSource?: (location: SourceLocation) => void;
}

export type AttachmentRenderer = (
  attachment: AttachmentSpec,
  context: AttachmentRenderContext
) => ReactNode;

const text = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
const code = (value: unknown) => (
  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono">
    {text(value)}
  </pre>
);
const pair = (left: string, right: string, a: unknown, b: unknown) => (
  <div className="grid gap-2 sm:grid-cols-2">
    <div>
      <div className="text-fg-mute">{left}</div>
      {code(a)}
    </div>
    <div>
      <div className="text-fg-mute">{right}</div>
      {code(b)}
    </div>
  </div>
);

const PatchFiles = lazy(() => import("../../thread/toolChange/PatchFiles"));
const PATCH_HEIGHT = 320;

const source: AttachmentRenderer = (a, { openSource }) => {
  const patchPath =
    typeof a.patch === "string"
      ? /^\+\+\+ (?:b\/)?([^\r\n]+)$/m.exec(a.patch)?.[1]
      : undefined;
  const path =
    typeof a.path === "string"
      ? a.path
      : patchPath === "/dev/null"
        ? undefined
        : patchPath;
  const line = typeof a.line === "number" ? a.line : undefined;
  const endLine = typeof a.endLine === "number" ? a.endLine : undefined;
  const location = path
    ? `${path}${line ? `:${line}${endLine ? `–${endLine}` : ""}` : ""}`
    : undefined;
  const base = typeof a.base === "string" ? a.base : undefined;
  const head = typeof a.head === "string" ? a.head : undefined;
  // A pasted patch needs no checkout; a range is read from the checkout.
  const patch =
    typeof a.patch === "string" && base === undefined ? a.patch : undefined;
  return (
    <>
      {path ? (
        <button
          type="button"
          disabled={!openSource}
          className="break-all text-left font-mono underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:no-underline"
          onClick={() =>
            openSource?.({
              path,
              line,
              endLine,
              side: a.side === "old" ? "old" : "new",
              ...(base !== undefined ? { base } : {}),
              ...(head !== undefined ? { head } : {}),
            })
          }
        >
          {location}
        </button>
      ) : (
        <p>No file path supplied for this diff.</p>
      )}
      {a.claim !== undefined && <p>{text(a.claim)}</p>}
      {a.symbol !== undefined && <p>{text(a.symbol)}</p>}
      {a.base !== undefined && (
        <p>
          Base: {text(a.base)} · Head: {text(a.head)}
        </p>
      )}
      {patch !== undefined && (
        <Suspense fallback={<p role="status">Loading diff…</p>}>
          <PatchFiles patch={patch} maxHeight={PATCH_HEIGHT} />
        </Suspense>
      )}
      {!openSource && path && patch === undefined && (
        <p className="text-fg-mute">
          Open this flow in a project conversation to view the source.
        </p>
      )}
    </>
  );
};

const imageUrl = (src: string) =>
  /^(https?:\/\/|data:image\/(png|jpeg|webp|gif);base64,)/i.test(src);

function CropImage({
  attachment: a,
  src,
}: {
  attachment: AttachmentSpec;
  src: string;
}) {
  const [failed, setFailed] = useState(false);
  const rect = a.rect as
    | { x: number; y: number; w: number; h: number }
    | undefined;
  if (failed) return <p role="status">Unable to load UI image.</p>;
  const img = (
    <img
      src={src}
      alt={a.title ?? "UI state"}
      loading="lazy"
      onError={() => setFailed(true)}
      className={rect ? "max-w-none" : "max-w-full"}
      style={
        rect
          ? { transform: `translate(${-rect.x}px, ${-rect.y}px)` }
          : undefined
      }
    />
  );
  return rect ? (
    <div className="max-w-full overflow-auto">
      <div
        className="relative overflow-hidden"
        style={{ width: rect.w, height: rect.h }}
      >
        {img}
      </div>
    </div>
  ) : (
    img
  );
}

function ArtifactCrop({
  attachment,
  id,
}: {
  attachment: AttachmentSpec;
  id: string;
}) {
  const { artifacts, error, isLoading, refetch } = useArtifactPresentations();
  const artifact = artifacts.find((item) => item.id === id);
  const src = artifact?.body.trim();
  if (src && imageUrl(src))
    return <CropImage key={src} attachment={attachment} src={src} />;
  return (
    <div role="status">
      {isLoading
        ? "Loading UI image…"
        : error
          ? "Unable to load image artifact."
          : "Image artifact has no supported image URL."}
      {error && (
        <button
          type="button"
          className="underline focus-visible:ring-2"
          onClick={refetch}
        >
          Retry image
        </button>
      )}
    </div>
  );
}

function Crop({ attachment }: { attachment: AttachmentSpec }) {
  const src = String(attachment.image);
  if (imageUrl(src))
    return <CropImage key={src} attachment={attachment} src={src} />;
  const id = src.replace(/^vtb:\/\/artifact\//, "");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    return <p role="status">Unsupported image reference: {src}</p>;
  return (
    <QueryClientProvider client={queryClient}>
      <ArtifactCrop attachment={attachment} id={id} />
    </QueryClientProvider>
  );
}

/** GUI renderers join the pure attachment specs by kind. */
export const attachmentRenderers: Record<string, AttachmentRenderer> = {
  note: (a) => <p className="whitespace-pre-wrap">{text(a.text)}</p>,
  ref: source,
  diff: source,
  formula: (a) => (
    <div>
      {code(a.expression)}
      {a.result !== undefined && (
        <div>
          = {text(a.result)} {text(a.unit)}
        </div>
      )}
    </div>
  ),
  "payload comparison": (a) => (
    <>
      {a.label !== undefined && <p>{text(a.label)}</p>}
      {pair("Expected", "Actual", a.expected, a.actual)}
    </>
  ),
  "ui crop": (a) => <Crop attachment={a} />,
  timing: (a) => (
    <p>
      {text(a.label)}:{" "}
      <strong>
        {text(a.value)} {text(a.unit ?? "ms")}
      </strong>
    </p>
  ),
  "schema diff": (a) => pair("Before", "After", a.before, a.after),
  "test summary": (a) => (
    <>
      <p>{text(a.suite)}</p>
      <p>
        {text(a.passed)} passed · {text(a.failed)} failed ·{" "}
        {text(a.skipped ?? 0)} skipped
      </p>
      {Array.isArray(a.impacted) && (
        <ul aria-label="Impacted areas">
          {a.impacted.map((item) => (
            <li key={String(item)}>{text(item)}</li>
          ))}
        </ul>
      )}
    </>
  ),
};

/** GUI extensions provide renderers independently of validation schemas. */
export const AttachmentRenderersContext =
  createContext<Readonly<Record<string, AttachmentRenderer>>>(
    attachmentRenderers
  );

export function useAttachmentRenderers(): Readonly<
  Record<string, AttachmentRenderer>
> {
  return useContext(AttachmentRenderersContext);
}
