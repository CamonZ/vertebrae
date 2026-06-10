/**
 * Workflow Atlas — public surface.
 *
 * `WorkflowAtlas` is the page rendered at `/design`. The rest are the canvas
 * building blocks; the pure layout + adapter modules are re-exported for tests.
 */
export { WorkflowAtlas, layoutKey } from "./WorkflowAtlas";
export { WfBox } from "./WfBox";
export type { WfBoxProps, WfBoxState, WfBoxView } from "./WfBox";
export { StepStrip } from "./StepStrip";
export type { StepStripProps } from "./StepStrip";
export { EdgeLabel } from "./EdgeLabel";
export type { EdgeLabelProps, EdgeLabelState } from "./EdgeLabel";
export { StepNodeGeo } from "./StepNodeGeo";
export type { StepNodeGeoProps, StepNodeState } from "./StepNodeGeo";
export { ColumnHeader } from "./ColumnHeader";
export type { ColumnHeaderProps } from "./ColumnHeader";
export { ZoomWidget } from "./ZoomWidget";
export type { ZoomWidgetProps } from "./ZoomWidget";
export { KindLegend } from "./KindLegend";
export { GraphEdge } from "./GraphEdge";
export type { GraphEdgeProps, GraphEdgeKind, GraphEdgeState } from "./GraphEdge";
export { GraphMarkers } from "./GraphMarkers";

export { WorkflowInspector } from "./inspector/WorkflowInspector";
export type { WorkflowInspectorProps } from "./inspector/WorkflowInspector";
export { StepInspector } from "./inspector/StepInspector";
export type { StepInspectorProps } from "./inspector/StepInspector";
export { kindClass } from "./inspector/selection";
export type { AtlasSelection } from "./inspector/selection";

export { RunConsole } from "./RunConsole";
export type { RunConsoleProps } from "./RunConsole";
export {
  splitRunConsole,
  miniPipeline,
  formatElapsed,
  runtimeSince,
} from "./runConsoleData";
export type {
  RunConsoleRow,
  RunConsoleSplit,
  PipelineSegment,
} from "./runConsoleData";
export { useRunConsoleTasks } from "./hooks/useRunConsoleTasks";

export { buildAtlasModel } from "./adapter/buildAtlasModel";
export { layoutFull } from "./layout/layoutFull";
export { layoutCondensed } from "./layout/layoutCondensed";
export * from "./layout/types";
