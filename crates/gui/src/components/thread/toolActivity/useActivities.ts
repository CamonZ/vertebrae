import { useEffect, useRef, useState } from "react";
import { commands } from "../../../bindings";
import { errorMessage, unwrapCommand } from "../../../query/commandResult";
import type { ToolMessage } from "../types";
import {
  fallbackAnalysis,
  loadingAnalysis,
  unavailableAnalysis,
  type ActivityAnalysis,
  type ActivityInput,
} from "./types";

const fallbackInput: ActivityInput = { name: "Tool", input: {} };

function needsAnalysis(call: ActivityInput): boolean {
  return call.name !== "Tool" || Object.keys(call.input).length > 0;
}

async function requestGroup(
  inputs: ActivityInput[]
): Promise<ActivityAnalysis[]> {
  const encoder = new TextEncoder();
  let remainingBytes = 4_194_304;
  let remainingCalls = 1024;
  const admitted = inputs.map((input) => {
    if (!needsAnalysis(input) || !remainingCalls) return false;
    const size = encoder.encode(JSON.stringify(input)).length;
    if (size > 131_072 || size > remainingBytes) return false;
    remainingBytes -= size;
    remainingCalls--;
    return true;
  });
  const calls = inputs.filter((_, index) => admitted[index]);
  if (!calls.length) return inputs.map(() => fallbackAnalysis);

  try {
    const rows = await unwrapCommand(commands.analyzeToolActivities(calls));
    if (rows.length !== calls.length)
      throw new Error("Incomplete tool activity analysis");
    let index = 0;
    return inputs.map((_, i) =>
      admitted[i] ? (rows[index++] ?? fallbackAnalysis) : fallbackAnalysis
    );
  } catch (error) {
    return inputs.map((_, i) =>
      admitted[i] ? unavailableAnalysis(errorMessage(error)) : fallbackAnalysis
    );
  }
}

/** Project only syntax inputs. Raw disclosure owns the complete tool payload. */
function projectionInput(call: ToolMessage): ActivityInput {
  const name = call.activityInput?.name ?? call.name ?? call.cmd ?? "Tool";
  const input: ActivityInput["input"] = {};
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
      if (characters > 131072) return fallbackInput;
      input[key] = value;
    } else if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "number"
    ) {
      input[key] = value;
    } else if (typeof value === "object") {
      input[key] = { unresolved: true };
    }
  }
  return { name, input };
}

/** Reuse completed syntax rows when a group grows or its calls reorder. */
export function useActivities(
  calls: ToolMessage[],
  retryToken = 0
): ActivityAnalysis[] {
  const projected = calls.map(projectionInput);
  const inputs = projected.map((call) => JSON.stringify(call));
  const key = JSON.stringify(inputs);
  const [state, setState] = useState<{
    retryToken: number;
    rows: ReadonlyMap<string, ActivityAnalysis>;
  }>();
  const completed = useRef<typeof state>(undefined);

  useEffect(() => {
    const keys: string[] = JSON.parse(key);
    const prior =
      completed.current?.retryToken === retryToken
        ? completed.current.rows
        : undefined;
    const rows = new Map<string, ActivityAnalysis>();
    const missing = new Set<string>();
    for (const input of keys) {
      const row = prior?.get(input);
      if (row && row.analysisState !== "unavailable") rows.set(input, row);
      else missing.add(input);
    }
    let active = true;
    const pending = [...missing];
    void requestGroup(
      pending.map((input): ActivityInput => JSON.parse(input))
    ).then((results) => {
      if (!active) return;
      pending.forEach((input, index) => rows.set(input, results[index]));
      completed.current = { retryToken, rows };
      setState(completed.current);
    });
    return () => {
      active = false;
    };
  }, [key, retryToken]);

  return projected.map(
    (input, index) =>
      (state?.retryToken === retryToken
        ? state.rows.get(inputs[index])
        : undefined) ??
      (needsAnalysis(input) ? loadingAnalysis : fallbackAnalysis)
  );
}

/** Ticket creation evidence uses the same parser without decision labels. */
export async function associationSyntax(
  call: ActivityInput
): Promise<ActivityAnalysis> {
  const [row] = await requestGroup([call]);
  return row;
}
