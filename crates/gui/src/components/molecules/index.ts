/**
 * Hearth molecules — composed primitives with a single responsibility.
 *
 * Composes atoms from `../atoms` and project-specific shared components.
 * Molecules are presentation-focused; domain logic stays in organism/page code.
 */

export { SearchInput } from "./SearchInput";

export { Card } from "./Card";
export type { CardVariant } from "./Card";

export { Modal } from "./Modal";
export type { ModalVariant } from "./Modal";

export { Panel } from "./Panel";

export { EmptyState } from "./EmptyState";

export { StatusBadge } from "./StatusBadge";
export type { StatusBadgeState, TaskExecutionState } from "./StatusBadge";

export { ChatMessage } from "./ChatMessage";
export type { ChatRole } from "./ChatMessage";

export { ToolCallBlock } from "./ToolCallBlock";
export type { ToolCallState } from "./ToolCallBlock";

export { TreeNode } from "./TreeNode";

export { FilterBar } from "./FilterBar";
export type { ActiveFilter } from "./FilterBar";

export { SectionGroup } from "./SectionGroup";

// Existing project molecules that already match Hearth — re-export for one-stop import.
export { IdentityBadge } from "../shared/EntityId";
export { ToastContainer } from "../Toast";
export { FormField } from "../forms";
