import type { Task } from "../bindings";
import type { VtbEntityType } from "../components/shared/vtbEntityLinkTarget";
import type { ChatMessage } from "../stores/chatStore";
import { parseJsonFragments } from "./jsonFragments";

export type IndexedValue = IndexedVtbEntity | null;

export interface IndexedVtbEntity {
  id: string;
  shortId: string;
  title: string;
  type: VtbEntityType;
  workflowId?: string;
}

export interface VtbEntityIndex {
  byId: Map<string, IndexedValue>;
  byShortId: Map<string, IndexedValue>;
  byTypeAndTitle: Map<string, IndexedValue>;
  stepsByWorkflowAndTitle: Map<string, IndexedValue>;
}

export const UUID_PATTERN =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

const VTB_INSPECTION_COMMAND_RE =
  /\bvtb\s+(?:(?:list|show)\b|workflow\s+(?:list|show)\b|step\s+(?:list|show)\b)/;
const TASK_LEVELS = new Set<VtbEntityType>(["epic", "ticket", "task"]);

export function buildVtbEntityIndex(
  messages: readonly ChatMessage[],
  seedEntities: readonly IndexedVtbEntity[] = []
): VtbEntityIndex {
  const index: VtbEntityIndex = {
    byId: new Map(),
    byShortId: new Map(),
    byTypeAndTitle: new Map(),
    stepsByWorkflowAndTitle: new Map(),
  };
  const callsById = new Map<
    string,
    Extract<ChatMessage, { kind: "tool_call" }>
  >();

  for (const message of messages) {
    if (message.kind === "tool_call") {
      callsById.set(message.toolId, message);
    }
  }

  for (const message of messages) {
    if (message.kind !== "tool_result" || message.isError) continue;

    const call = callsById.get(message.toolId);
    if (!call || !isBashToolCall(call)) continue;

    const command = commandFromToolInput(call.input);
    if (!command || !isVtbInspectionCommand(command)) continue;

    for (const parsed of parseJsonValues(message.result)) {
      for (const entity of extractVtbEntities(parsed)) {
        addEntity(index, entity);
      }
    }
  }

  for (const entity of seedEntities) {
    addEntity(index, entity);
  }

  return index;
}

export function indexedVtbEntityFromTask(
  task: Pick<Task, "id" | "title" | "level">
): IndexedVtbEntity | null {
  if (!isFullUuid(task.id) || !task.title || !isTaskLevel(task.level)) {
    return null;
  }

  return toEntity(task.id, task.level, task.title);
}

export function getIndexedVtbEntity(
  index: VtbEntityIndex,
  token: string
): IndexedVtbEntity | null {
  const normalized = token.toLowerCase();
  const value =
    normalized.length === 8
      ? index.byShortId.get(normalized)
      : index.byId.get(normalized);
  return value ?? null;
}

export function getIndexedVtbEntityByTitle(
  index: VtbEntityIndex,
  type: VtbEntityType,
  title: string
): IndexedVtbEntity | null {
  return index.byTypeAndTitle.get(titleIndexKey(type, title)) ?? null;
}

export function getIndexedStepByWorkflowAndTitle(
  index: VtbEntityIndex,
  workflowId: string,
  title: string
): IndexedVtbEntity | null {
  return (
    index.stepsByWorkflowAndTitle.get(
      workflowTitleIndexKey(workflowId, title)
    ) ?? null
  );
}

function isBashToolCall(
  call: Extract<ChatMessage, { kind: "tool_call" }>
): boolean {
  return call.toolName.toLowerCase() === "bash";
}

function commandFromToolInput(input: string): string | null {
  const parsed = parseJson(input);
  if (!isRecord(parsed)) return null;

  const command = parsed.command;
  return typeof command === "string" ? command : null;
}

function isVtbInspectionCommand(command: string): boolean {
  return VTB_INSPECTION_COMMAND_RE.test(command);
}

function parseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value.trim());
  } catch {
    return undefined;
  }
}

function parseJsonValues(value: string): unknown[] {
  const parsed = parseJson(value);
  if (parsed !== undefined) {
    return [parsed, ...parseNestedJsonStrings(parsed)];
  }

  return parseJsonFragments(value);
}

function parseNestedJsonStrings(value: unknown): unknown[] {
  const parsed: unknown[] = [];
  const seen = new Set<string>();

  visitStringFields(value, (text) => {
    for (const fragment of parseJsonFragments(text)) {
      const key = JSON.stringify(fragment);
      if (seen.has(key)) continue;
      seen.add(key);
      parsed.push(fragment);
    }
  });

  return parsed;
}

function visitStringFields(
  value: unknown,
  visit: (value: string) => void
): void {
  if (typeof value === "string") {
    visit(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) visitStringFields(item, visit);
    return;
  }

  if (!isRecord(value)) return;
  for (const child of Object.values(value)) {
    visitStringFields(child, visit);
  }
}

function extractVtbEntities(value: unknown): IndexedVtbEntity[] {
  const entities: IndexedVtbEntity[] = [];
  visitJson(value, null, (record, workflowId) => {
    const id = stringField(record, "id");
    if (!id || !isFullUuid(id)) return;

    const title = stringField(record, "title");
    const level = stringField(record, "level");
    const parentId = stringField(record, "parent_id");
    const parentType = parentTypeForLevel(level);
    if (parentId && parentType && isFullUuid(parentId)) {
      entities.push(toEntity(parentId, parentType, ""));
    }

    if (title && isTaskLevel(level)) {
      entities.push(toEntity(id, level, title));
      return;
    }

    const name = stringField(record, "name");
    if (!name) return;

    if (isStepRecord(record)) {
      entities.push(
        toEntity(
          id,
          "step",
          name,
          stringField(record, "workflow_id") ?? workflowId ?? undefined
        )
      );
      return;
    }

    if (isWorkflowRecord(record)) {
      entities.push(toEntity(id, "workflow", name));
    }
  });

  return entities;
}

function visitJson(
  value: unknown,
  workflowId: string | null,
  visitRecord: (
    record: Record<string, unknown>,
    workflowId: string | null
  ) => void
): void {
  if (Array.isArray(value)) {
    for (const item of value) visitJson(item, workflowId, visitRecord);
    return;
  }

  if (!isRecord(value)) return;

  visitRecord(value, workflowId);
  const id = stringField(value, "id");
  const childWorkflowId =
    id && isFullUuid(id) && isWorkflowRecord(value) ? id : workflowId;

  for (const child of Object.values(value)) {
    if (Array.isArray(child) || isRecord(child)) {
      visitJson(child, childWorkflowId, visitRecord);
    }
  }
}

function parentTypeForLevel(
  value: string | undefined
): "epic" | "ticket" | undefined {
  if (value === "ticket") return "epic";
  if (value === "task") return "ticket";
  return undefined;
}

function isWorkflowRecord(record: Record<string, unknown>): boolean {
  return (
    typeof record.name === "string" &&
    (typeof record.step_count === "number" ||
      typeof record.is_default === "boolean" ||
      Array.isArray(record.steps))
  );
}

function isStepRecord(record: Record<string, unknown>): boolean {
  return (
    typeof record.name === "string" &&
    (typeof record.workflow_id === "string" ||
      typeof record.step_type === "string" ||
      typeof record.order === "number")
  );
}

function isTaskLevel(
  value: string | null | undefined
): value is "epic" | "ticket" | "task" {
  return value != null && TASK_LEVELS.has(value as VtbEntityType);
}

function stringField(
  record: Record<string, unknown>,
  field: string
): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isFullUuid(value: string): boolean {
  return new RegExp(`^${UUID_PATTERN}$`, "i").test(value);
}

function toEntity(
  id: string,
  type: VtbEntityType,
  title: string,
  workflowId?: string
): IndexedVtbEntity {
  return {
    id,
    shortId: id.slice(0, 8).toLowerCase(),
    title,
    type,
    workflowId,
  };
}

function addEntity(index: VtbEntityIndex, entity: IndexedVtbEntity): void {
  addIndexedValue(index.byId, entity.id.toLowerCase(), entity);
  addIndexedValue(index.byShortId, entity.shortId, entity);

  if (!entity.title) return;

  addIndexedValue(
    index.byTypeAndTitle,
    titleIndexKey(entity.type, entity.title),
    entity
  );

  if (entity.type === "step" && entity.workflowId) {
    addIndexedValue(
      index.stepsByWorkflowAndTitle,
      workflowTitleIndexKey(entity.workflowId, entity.title),
      entity
    );
  }
}

function addIndexedValue(
  map: Map<string, IndexedValue>,
  key: string,
  entity: IndexedVtbEntity
): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, entity);
    return;
  }
  if (existing === null) return;
  if (!existing.title && entity.title) {
    map.set(key, entity);
    return;
  }
  if (existing.title && !entity.title) return;
  if (existing.id === entity.id && existing.type === entity.type) {
    return;
  }

  map.set(key, null);
}

function titleIndexKey(type: VtbEntityType, title: string): string {
  return `${type}:${normalizeTitle(title)}`;
}

function workflowTitleIndexKey(workflowId: string, title: string): string {
  return `${workflowId.toLowerCase()}:${normalizeTitle(title)}`;
}

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
