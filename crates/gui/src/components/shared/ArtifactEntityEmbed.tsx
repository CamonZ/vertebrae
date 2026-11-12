import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../../query/queryClient";
import { useArtifactPresentations } from "../../hooks/useArtifactPresentations";
import { StatechartPreview } from "../Artifacts/StatechartPreview";
import { isStatechartMetadata } from "../Artifacts/statechart";
import { isFlowMetadata } from "../Artifacts/flowArtifact";
import { FlowSpecView } from "./FlowSpecView";

function ResolvedArtifactEmbed({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  const { artifacts, error, refetch } = useArtifactPresentations();
  const artifact = artifacts.find((item) => item.id === id);
  const showStatechart = artifact && isStatechartMetadata(artifact.metadata);
  const showFlow = artifact && isFlowMetadata(artifact.metadata);

  return (
    <span>
      {children}
      {error && (
        <span className="block text-sm" role="alert">
          Unable to load artifact.{" "}
          <button type="button" onClick={refetch}>
            Retry artifact
          </button>
        </span>
      )}
      {showStatechart && <StatechartPreview key={id} body={artifact.body} />}
      {showFlow && <FlowSpecView key={id} source={artifact.body} />}
    </span>
  );
}

/** Reuse the project's shared, scope-guarded artifact projection and CDC cache. */
export function ArtifactEntityEmbed(props: {
  id: string;
  children: ReactNode;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <ResolvedArtifactEmbed {...props} />
    </QueryClientProvider>
  );
}
