import { executeBackgroundTask } from "./execute";
import { dataWeight } from "./budget";
import type { WorkerRequest, WorkerResponse } from "./types";

const MAX_RESULT_BYTES = 96 * 1024 * 1024;

self.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  let response: WorkerResponse;

  try {
    const result = await executeBackgroundTask(data.task);

    if (dataWeight(result, MAX_RESULT_BYTES) > MAX_RESULT_BYTES) {
      throw new Error(
        "Prepared conversation data exceeds the background result budget."
      );
    }

    response = { id: data.id, status: "ok", result };
  } catch (error) {
    response = {
      id: data.id,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  self.postMessage(response);
};
