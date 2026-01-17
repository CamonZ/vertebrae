/**
 * Standardized node styling constants for the workflow pipeline
 * Ensures visual consistency across all node types (TaskNode, StepNode, etc.)
 */

// All nodes must have the same dimensions for consistency
export const NODE_SIZING = {
  widthClass: "w-[280px]", // Explicit fixed width for all nodes
  heightClass: "h-[100px]", // Explicit fixed height for task nodes
  stepHeightClass: "h-[130px]", // Taller height for step nodes to accommodate more content
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
