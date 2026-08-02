import type { CSSProperties } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { Artifact } from "../../bindings";
import { parseHarnessJsonl } from "../../types/conversation";
import { MarkdownContent } from "../shared/MarkdownContent";
import { ReadOnlyConversationPreview } from "./ReadOnlyConversationPreview";

interface ArtifactPreviewBodyProps {
  artifact: Artifact;
}

const jsonSyntaxTheme = {
  ...vscDarkPlus,
  'pre[class*="language-"]': {
    ...(vscDarkPlus['pre[class*="language-"]'] as CSSProperties),
    background: "transparent",
    margin: 0,
  },
  'code[class*="language-"]': {
    ...(vscDarkPlus['code[class*="language-"]'] as CSSProperties),
    background: "none",
  },
};

const jsonCodeStyle: CSSProperties = {
  margin: 0,
  padding: "0.75rem",
  background: "transparent",
  fontSize: "var(--text-13)",
  lineHeight: "1.6",
  overflow: "auto",
  maxHeight: "24rem",
};

function RawArtifactBody({
  body,
  diagnostic,
}: {
  body: string;
  diagnostic: string;
}) {
  return (
    <div className="space-y-2">
      <p role="alert" className="text-sm text-warn">
        {diagnostic}
      </p>
      <pre
        data-testid="artifact-raw-body"
        className="max-h-96 overflow-auto rounded-md border border-border bg-bg p-3 font-mono text-xs whitespace-pre-wrap"
      >
        {body}
      </pre>
    </div>
  );
}

/**
 * Pure, read-only artifact content presentation. The containing inspector
 * owns data fetching and panel layout; this component never opens a chat
 * session or mutates the artifact.
 */
export function ArtifactPreviewBody({ artifact }: ArtifactPreviewBodyProps) {
  const metadata = artifact.metadata;
  if (!metadata) {
    return (
      <RawArtifactBody
        body={artifact.body}
        diagnostic="This artifact has no presentation metadata. Showing its raw contents."
      />
    );
  }

  if (metadata.format === "markdown") {
    return <MarkdownContent text={artifact.body} />;
  }

  if (
    metadata.content_kind === "conversation" &&
    metadata.format === "jsonl" &&
    metadata.presentation === "raw"
  ) {
    const events = parseHarnessJsonl(artifact.body);
    return events ? (
      <ReadOnlyConversationPreview events={events} />
    ) : (
      <RawArtifactBody
        body={artifact.body}
        diagnostic="This conversation transcript is malformed or uses an unsupported event type. Showing its raw contents."
      />
    );
  }

  if (metadata.format === "json") {
    try {
      const formatted = JSON.stringify(JSON.parse(artifact.body), null, 2);
      return (
        <div
          data-testid="artifact-json-preview"
          className="max-h-96 overflow-auto rounded-md border border-border bg-bg font-mono text-xs"
        >
          <SyntaxHighlighter
            style={jsonSyntaxTheme as { [key: string]: CSSProperties }}
            language="json"
            PreTag="div"
            customStyle={jsonCodeStyle}
            codeTagProps={{ className: "font-mono" }}
          >
            {formatted}
          </SyntaxHighlighter>
        </div>
      );
    } catch {
      return (
        <RawArtifactBody
          body={artifact.body}
          diagnostic="This artifact declares JSON content, but its body is not valid JSON. Showing its raw contents."
        />
      );
    }
  }

  return (
    <RawArtifactBody
      body={artifact.body}
      diagnostic={`Unsupported artifact presentation (${metadata.content_kind}/${metadata.format}). Showing its raw contents.`}
    />
  );
}
