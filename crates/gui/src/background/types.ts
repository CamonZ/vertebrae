import type { FileDiffMetadata } from "@pierre/diffs";
import type {
  FilePatch,
  ToolPatch,
} from "../components/thread/toolChange/diffLineMapper";
import type { ToolAnnotations } from "../stores/toolAnnotations";
import type {
  PreparedReplay,
  ReplayPreparation,
} from "../stores/prepareProviderReplay";

export type BackgroundTask =
  | {
      kind: "patch";
      patches: readonly string[];
      review: boolean;
    }
  | { kind: "tool_chain"; annotations: ToolAnnotations | undefined }
  | { kind: "replay"; input: ReplayPreparation };

export interface BackgroundOutputs {
  patch: { files: FileDiffMetadata[] | null; reviewFiles: FilePatch[] }[];
  tool_chain: ToolPatch[];
  replay: PreparedReplay;
}

export type TaskOutput<T extends BackgroundTask> = BackgroundOutputs[T["kind"]];
export type BackgroundResult = {
  [K in BackgroundTask["kind"]]: { kind: K; value: BackgroundOutputs[K] };
}[BackgroundTask["kind"]];

export type WorkerRequest = { id: number; task: BackgroundTask };
export type WorkerResponse =
  | { id: number; status: "ok"; result: BackgroundResult }
  | { id: number; status: "error"; error: string };
