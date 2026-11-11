import { useEffect, useState } from "react";
import type { ToolMessage } from "../types";
import {
  fallbackAnalysis,
  loadingAnalysis,
  unavailableAnalysis,
  type ActivityAnalysis,
  type ActivityInput,
  type WorkerResponse,
  type WorkerFailure,
} from "./types";
const cache = new Map<string, ActivityAnalysis>();
const pending = new Map<
  number,
  {
    key: string;
    resolve: (row: ActivityAnalysis) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
let worker: Worker | undefined;
let owners = 0;
let nextId = 0;
function stopWorker(reason?: string, failure?: WorkerFailure) {
  worker?.terminate();
  worker = undefined;
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.resolve(reason ? unavailableAnalysis(reason, failure) : fallbackAnalysis);
  }
  pending.clear();
}
function sendRequest(call: ActivityInput): Promise<ActivityAnalysis> {
  if (call.name === "Tool" && Object.keys(call.input).length === 0)
    return Promise.resolve(fallbackAnalysis);
  const key = JSON.stringify(call);
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  if (
    typeof Worker === "undefined" ||
    key.length > 131072 ||
    pending.size >= 1024 ||
    [...pending.values()].reduce((total, p) => total + p.key.length, 0) +
      key.length >
      4194304
  )
    return Promise.resolve(fallbackAnalysis);
  if (!worker) {
    try {
      worker = new Worker(new URL("./worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
        const p = pending.get(data.id);
        if (!p) return;
        if (data.kind === "error" && data.error.phase === "initialization") {
          if (worker === ownedWorker)
            stopWorker(data.error.message, data.error);
          return;
        }
        const analysis =
          data.kind === "result"
            ? data.analysis
            : unavailableAnalysis(data.error.message, data.error);
        clearTimeout(p.timer);
        pending.delete(data.id);
        if (cache.size >= 256) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        if (analysis.analysisState !== "unavailable")
          cache.set(p.key, analysis);
        p.resolve(analysis);
      };
      const ownedWorker = worker;
      worker.onerror = (event) => {
        if (worker === ownedWorker)
          stopWorker("Parser worker failed", {
            phase: "runtime",
            retryable: true,
            message: event?.message ?? "Worker error",
          });
      };
    } catch (error) {
      return Promise.resolve(
        unavailableAnalysis(
          `Parser worker could not start: ${error instanceof Error ? error.message : String(error)}`,
          { phase: "runtime", retryable: true, message: String(error) }
        )
      );
    }
  }
  return new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(
      () =>
        stopWorker("Parser worker timed out", {
          phase: "runtime",
          retryable: true,
          message: "Parser worker timed out",
        }),
      10000
    );
    pending.set(id, { key, resolve, timer });
    worker?.postMessage({ id, call });
  });
}
/** A failed shared worker is stopped once before all affected requests retry.
 * Each request gets one fresh-worker attempt; permanent failures stay bounded.
 */
async function request(call: ActivityInput): Promise<ActivityAnalysis> {
  const result = await sendRequest(call);
  if (
    owners > 0 &&
    result.analysisState === "unavailable" &&
    result.failure?.retryable
  ) {
    return sendRequest(call);
  }
  return result;
}
/** Only fields understood by the syntax projection enter its key/worker payload.
 * This avoids serializing large unrelated arguments on the streaming render path.
 * The complete original input remains owned by ToolMessage for raw disclosure.
 */
function projectionInput(call: ToolMessage): ActivityInput {
  const name = call.activityInput?.name ?? call.name ?? call.cmd ?? "Tool";
  const input: Record<string, unknown> = {};
  let characters = name.length;
  for (const key of [
    "cmd",
    "command",
    "shell",
    "code",
    "query",
    "expression",
    "input",
    "arguments",
    "raw",
    "file_path",
    "path",
  ]) {
    const value = call.activityInput?.input[key];
    if (typeof value === "string") {
      characters += value.length;
      if (characters > 131072) return { name: "Tool", input: {} };
      input[key] = value;
    } else if (value !== undefined)
      input[key] =
        typeof value === "object" && value !== null
          ? { unresolved: true }
          : value;
  }
  return { name, input };
}
/** One shared worker; no results or execution status enter the derived cache. */
export function useActivities(
  calls: ToolMessage[],
  retryToken = 0
): ActivityAnalysis[] {
  const projected = calls.map(projectionInput);
  const key = JSON.stringify(projected);
  const [state, setState] = useState<{
    key: string;
    rows: ActivityAnalysis[];
  }>();
  useEffect(() => {
    if (typeof Worker === "undefined") return;
    owners++;
    return () => {
      if (--owners === 0) {
        stopWorker();
        cache.clear();
      }
    };
  }, []);
  useEffect(() => {
    if (typeof Worker === "undefined") return;
    let alive = true;
    const inputs: ActivityInput[] = JSON.parse(key);
    const rows = inputs.map(
      (input) => cache.get(JSON.stringify(input)) ?? loadingAnalysis
    );
    setState({ key, rows });
    void Promise.all(
      inputs.map(async (input, index) => {
        const row = await request(input);
        if (alive) {
          rows[index] = row;
          setState({ key, rows: [...rows] });
        }
      })
    );
    return () => {
      alive = false;
    };
  }, [key, retryToken]);
  return state?.key === key
    ? state.rows
    : projected.map(
        (input) =>
          cache.get(JSON.stringify(input)) ??
          (typeof Worker === "undefined" ? fallbackAnalysis : loadingAnalysis)
      );
}

/** Syntax-only access for association evidence; shares the bounded worker. */
export async function associationSyntax(
  call: ActivityInput
): Promise<ActivityAnalysis> {
  owners++;
  try {
    return await request(call);
  } finally {
    if (--owners === 0) stopWorker();
  }
}
