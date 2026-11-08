import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../../query/queryClient";
import { useArtifactPresentations } from "../../hooks/useArtifactPresentations";
import { StatechartPreview } from "../Artifacts/StatechartPreview";
import { isStatechartMetadata } from "../Artifacts/statechart";

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
