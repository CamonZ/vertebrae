import { Parser, Language } from "web-tree-sitter";
import runtimeUrl from "web-tree-sitter/tree-sitter.wasm?url";
import jsUrl from "tree-sitter-wasms/out/tree-sitter-javascript.wasm?url";
import bashUrl from "tree-sitter-wasms/out/tree-sitter-bash.wasm?url";
import pythonUrl from "tree-sitter-wasms/out/tree-sitter-python.wasm?url";
import { analyzeActivity } from "./parser";
import type { ActivityInput, WorkerResponse } from "./types";
const ready = Parser.init({ locateFile: () => runtimeUrl })
  .then(async () => {
    // Grammars link into one Emscripten runtime. Concurrent linking can inspect
    // another grammar's unresolved scanner symbols in WebKit.
    const javascript = await Language.load(jsUrl);
    const bash = await Language.load(bashUrl);
    const python = await Language.load(pythonUrl);
    return { languages: { javascript, bash, python } };
  })
  .catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
let queue = Promise.resolve();
self.onmessage = ({
  data,
}: MessageEvent<{ id: number; call: ActivityInput }>) => {
  queue = queue.then(async () => {
    let response: WorkerResponse;
    try {
      const initialized = await ready;
      response =
        "languages" in initialized
          ? {
              kind: "result",
              id: data.id,
              analysis: analyzeActivity(data.call, initialized.languages),
            }
          : {
              kind: "error",
              id: data.id,
              error: {
                phase: "initialization",
                retryable: true,
                message: `Parser initialization failed: ${initialized.error}`,
              },
            };
    } catch (error) {
      response = {
        kind: "error",
        id: data.id,
        error: {
          phase: "analysis",
          retryable: false,
          message: `Parser failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
    self.postMessage(response);
  });
};
