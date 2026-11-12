import type { ArtifactLinkMetadata } from "../../bindings";

/** Flow spec artifacts: a JSON or YAML flow spec rendered with the player. */
export function isFlowMetadata(metadata: ArtifactLinkMetadata | null): boolean {
  return (
    metadata?.version === 1 &&
    metadata.content_kind === "flow" &&
    (metadata.format === "json" || metadata.format === "yaml") &&
    metadata.presentation === "rendered"
  );
}
