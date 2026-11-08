import { createMachine, type StateNode } from "xstate";
import type { ArtifactLinkMetadata } from "../../bindings";

export function isStatechartMetadata(
  metadata: ArtifactLinkMetadata | null
): boolean {
  return (
    metadata?.version === 1 &&
    metadata.content_kind === "statechart" &&
    metadata.format === "json" &&
    metadata.presentation === "rendered"
  );
}

type TransitionConfig = {
  target?: string;
  guard?: string;
  description?: string;
  reenter?: boolean;
};
type TransitionValue = TransitionConfig | TransitionConfig[];

export type StatechartConfig = {
  id?: string;
  description?: string;
  type?: "atomic" | "compound" | "parallel" | "final";
  initial?: string;
  states?: Record<string, StatechartConfig>;
  on?: Record<string, TransitionValue>;
  always?: TransitionValue;
  onDone?: TransitionValue;
};

export type StatechartNode = {
  id: string;
  label: string;
  description?: string;
  type: "atomic" | "compound" | "parallel" | "final";
  parentId?: string;
  initial: string[];
  children: StatechartNode[];
};

export type StatechartTransition = {
  id: string;
  source: string;
  target: string;
  event: string;
  eventType: string;
  guard?: string;
  description?: string;
  kind: "event" | "eventless" | "done" | "internal";
  reenter: boolean;
};

export type Statechart = {
  id: string;
  name: string;
  config: StatechartConfig;
  root: StatechartNode;
  nodes: StatechartNode[];
  transitions: StatechartTransition[];
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an XState configuration object.");
  }

  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, allowed: readonly string[]) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`Unsupported XState field: ${key}.`);
    }
  }
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error(`Invalid ${field}: use 1–200 printable characters.`);
  }

  const characters = Array.from(value);
  const control = characters.some((character) => {
    const code = character.charCodeAt(0);

    return code < 32 || code === 127;
  });

  if (control) {
    throw new Error(`Invalid ${field}: control characters are unsupported.`);
  }

  return value;
}

function key(value: unknown): string {
  const name = text(value, "state key or ID");
  const reserved = ["__proto__", "constructor", "prototype"];

  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) || reserved.includes(name)) {
    throw new Error(
      "State keys and IDs must start with a letter and contain at most 64 ASCII letters, digits, underscores or hyphens."
    );
  }

  return name;
}

/** Validate declarative JSON before XState sees it. No actors or user code run. */
export function parseStatechart(body: string): Statechart {
  if (body.length > 100_000) {
    throw new Error("Statechart exceeds 100,000 characters.");
  }

  const definition: unknown = JSON.parse(body);
  let nodeCount = 0;
  let transitionCount = 0;
  const explicitIds = new Set<string>();

  function transitions(value: unknown): TransitionValue {
    if (Array.isArray(value)) {
      if (!value.length)
        throw new Error("Transition alternatives cannot be empty.");

      return value.map(transition);
    }

    return transition(value);
  }

  function transition(value: unknown): TransitionConfig {
    transitionCount++;

    if (transitionCount > 200)
      throw new Error("Statechart exceeds 200 transitions.");
    if (typeof value === "string") {
      const target = text(value, "transition target");

      return { target };
    }

    const entry = object(value);
    fields(entry, ["target", "guard", "description", "reenter"]);

    if (entry.reenter !== undefined && typeof entry.reenter !== "boolean") {
      throw new Error("Transition reenter must be boolean.");
    }

    const target =
      entry.target === undefined
        ? undefined
        : text(entry.target, "transition target");
    const guard =
      entry.guard === undefined ? undefined : text(entry.guard, "guard name");
    const description =
      entry.description === undefined
        ? undefined
        : text(entry.description, "description");

    return { target, guard, description, reenter: entry.reenter };
  }

  function state(value: unknown, depth: number): StatechartConfig {
    const input = object(value);
    fields(input, [
      "id",
      "description",
      "type",
      "initial",
      "states",
      "on",
      "always",
      "onDone",
    ]);
    nodeCount++;

    if (nodeCount > 100 || depth > 8) {
      throw new Error("Statechart exceeds 100 nodes or eight nesting levels.");
    }

    const id = input.id === undefined ? undefined : key(input.id);

    if (id && explicitIds.has(id))
      throw new Error(`Duplicate state ID: ${id}.`);
    if (id) explicitIds.add(id);

    const description =
      input.description === undefined
        ? undefined
        : text(input.description, "description");
    const children: Record<string, StatechartConfig> = {};

    if (input.states !== undefined) {
      const entries = object(input.states);

      for (const [name, child] of Object.entries(entries)) {
        const childKey = key(name);
        children[childKey] = state(child, depth + 1);
      }

      if (!Object.keys(children).length)
        throw new Error("States cannot be empty.");
    }

    const hasChildren = Object.keys(children).length > 0;
    const inferredType = hasChildren ? "compound" : "atomic";
    const type = input.type ?? inferredType;

    if (
      type !== "atomic" &&
      type !== "compound" &&
      type !== "parallel" &&
      type !== "final"
    ) {
      throw new Error(`Unsupported XState node type: ${String(type)}.`);
    }
    if ((type === "compound" || type === "parallel") !== hasChildren) {
      throw new Error(
        "Compound and parallel states require children; atomic and final states cannot have children."
      );
    }

    const initial =
      input.initial === undefined ? undefined : key(input.initial);

    if (
      type === "compound"
        ? !initial || !Object.prototype.hasOwnProperty.call(children, initial)
        : initial !== undefined
    ) {
      throw new Error(
        "Compound states need an initial direct child; other state types cannot declare initial."
      );
    }
    if (
      type === "final" &&
      (input.on !== undefined ||
        input.always !== undefined ||
        input.onDone !== undefined)
    ) {
      throw new Error("Final states cannot declare outgoing transitions.");
    }

    const on: Record<string, TransitionValue> = {};

    if (input.on !== undefined) {
      const events = object(input.on);

      for (const [event, targets] of Object.entries(events)) {
        const eventName = text(event, "event");

        if (["__proto__", "constructor", "prototype"].includes(eventName)) {
          throw new Error("Reserved event name.");
        }

        on[eventName] = transitions(targets);
      }
    }

    const always =
      input.always === undefined ? undefined : transitions(input.always);
    const onDone =
      input.onDone === undefined ? undefined : transitions(input.onDone);

    return {
      id,
      description,
      type,
      initial,
      states: hasChildren ? children : undefined,
      on,
      always,
      onDone,
    };
  }

  const config = state(definition, 0);

  if (!config.id || !config.states) {
    throw new Error("The machine needs an id and nonempty states.");
  }

  // XState owns target resolution and state-node semantics. Constructing the
  // model is safe here: the validated subset contains no executable behavior.
  const machine = createMachine(config);
  const nodes: StatechartNode[] = [];
  const edges: StatechartTransition[] = [];

  function visit(node: StateNode): StatechartNode {
    if (node.type === "history")
      throw new Error("History states are unsupported.");

    const initial = node.type === "compound" ? (node.initial.target ?? []) : [];
    const initialIds = initial.map((target) => target.id);
    const converted: StatechartNode = {
      id: node.id,
      label: node.key,
      description: node.description,
      type: node.type,
      parentId: node.parent?.id,
      initial: initialIds,
      children: [],
    };

    nodes.push(converted);

    const eventTransitions = [...node.transitions.values()].flat();
    const allTransitions = [...eventTransitions, ...(node.always ?? [])];

    for (const entry of allTransitions) {
      const target = entry.target?.[0];
      const done = entry.eventType.startsWith("xstate.done.state.");
      const eventless = entry.eventType === "";
      const event = done ? "done" : eventless ? "always" : entry.eventType;
      const guard = typeof entry.guard === "string" ? entry.guard : undefined;
      const kind = !target
        ? "internal"
        : done
          ? "done"
          : eventless
            ? "eventless"
            : "event";

      edges.push({
        id: `transition-${edges.length}`,
        source: node.id,
        target: target?.id ?? node.id,
        event,
        eventType: entry.eventType,
        guard,
        description: entry.description,
        kind,
        reenter: entry.reenter,
      });
    }

    converted.children = Object.values(node.states).map(visit);

    return converted;
  }

  const root = visit(machine.root);
  const nodeIds = nodes.map((node) => node.id);
  const ids = new Set(nodeIds);

  if (ids.size !== nodes.length)
    throw new Error("State IDs collide with an implicit XState path.");

  return {
    id: root.id,
    name: root.description ?? root.id,
    config,
    root,
    nodes,
    transitions: edges,
  };
}
