/**
 * Standardized node styling constants for the workflow pipeline
 * Ensures visual consistency across all node types (TaskNode, StepNode, etc.)
 */

// All nodes must have the same dimensions for consistency
export const NODE_SIZING = {
  widthClass: "w-[280px]", // Explicit fixed width for all nodes
  heightClass: "h-[100px]", // Explicit fixed height for task nodes
  stepHeightClass: "h-[170px]", // Taller height for step nodes to accommodate execution counts bar
  paddingClass: "p-4", // Unified padding: 16px on all sides
  borderRadiusClass: "rounded-lg", // Unified border radius
  overflowClass: "overflow-hidden", // Ensure content is truncated
} as const;

// Unified box-shadow for consistent depth
export const NODE_SHADOW_STYLE = {
  boxShadow: '2px 2px 4px rgba(0, 0, 0, 0.1), 3px 3px 8px rgba(0, 0, 0, 0.15)',
} as const;

// Handle sizing - all handles must be the same size
export const HANDLE_SIZING = {
  widthClass: "!w-3", // 12px (was TaskNode w-2.5, StepNode w-3)
  heightClass: "!h-3", // 12px (was TaskNode h-2.5, StepNode h-3)
  roundedClass: "!rounded-full",
  borderClass: "!border-2",
  bgClass: "!bg-bg-primary",
} as const;

/**
 * Layout constants for the AllWorkflowsPipeline canvas
 */
export const LAYOUT_CONSTANTS = {
  /** Horizontal spacing between step nodes */
  NODE_SPACING_X: 320,
  /** Y offset for step nodes within workflow zone */
  STEP_Y_OFFSET: 80,
  /** Padding around workflow zone content */
  WORKFLOW_ZONE_PADDING: 40,
  /** Height reserved for workflow header */
  WORKFLOW_ZONE_HEADER_HEIGHT: 80,
  /** Vertical gap between workflow zones */
  WORKFLOW_ZONE_GAP: 60,
  /** Step node width in pixels (must match NODE_SIZING.widthClass) */
  STEP_NODE_WIDTH: 280,
  /** Step node height in pixels (must match NODE_SIZING.stepHeightClass) */
  STEP_NODE_HEIGHT: 170,
} as const;

/**
 * Calculate the width needed for a workflow zone based on number of steps
 */
export function calculateWorkflowZoneWidth(stepCount: number): number {
  if (stepCount === 0) return 400;
  return (
    stepCount * LAYOUT_CONSTANTS.NODE_SPACING_X +
    LAYOUT_CONSTANTS.WORKFLOW_ZONE_PADDING * 2
  );
}

/**
 * Calculate the height needed for a workflow zone
 */
export function calculateWorkflowZoneHeight(): number {
  return (
    LAYOUT_CONSTANTS.WORKFLOW_ZONE_HEADER_HEIGHT +
    LAYOUT_CONSTANTS.STEP_Y_OFFSET +
    170 +
    LAYOUT_CONSTANTS.WORKFLOW_ZONE_PADDING
  );
}
