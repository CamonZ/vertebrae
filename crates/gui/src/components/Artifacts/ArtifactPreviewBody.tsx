import type { Artifact } from "../../bindings";
import { parseHarnessJsonl } from "../../types/conversation";
import { MarkdownContent } from "../shared/MarkdownContent";
import { ReadOnlyConversationPreview } from "./ReadOnlyConversationPreview";

interface ArtifactPreviewBodyProps {
  artifact: Artifact;
}

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
        <pre
          data-testid="artifact-json-preview"
          className="max-h-96 overflow-auto rounded-md border border-border bg-bg p-3 font-mono text-xs whitespace-pre-wrap"
        >
          <code>{formatted}</code>
        </pre>
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
