/**
 * Standardized node styling constants for the workflow pipeline
 * Ensures visual consistency across all node types (TaskNode, StepNode, etc.)
 */

// All nodes must have the same dimensions for consistency
export const NODE_SIZING = {
  minWidthClass: 'min-w-[200px]',    // Unified minimum width for all nodes
  paddingClass: 'p-4',                // Unified padding (16px on all sides)
  borderRadiusClass: 'rounded-lg',    // Unified border radius
} as const;

// Unified box-shadow for consistent depth
export const NODE_SHADOW_STYLE = {
  boxShadow: '2px 2px 4px rgba(0, 0, 0, 0.1), 3px 3px 8px rgba(0, 0, 0, 0.15)',
} as const;

// Handle sizing - all handles must be the same size
export const HANDLE_SIZING = {
  widthClass: '!w-2.5',     // 10px (Tailwind: 2.5 = 0.625rem = 10px)
  heightClass: '!h-2.5',    // 10px
  roundedClass: '!rounded-full',
  borderClass: '!border-2',
  bgClass: '!bg-bg-primary',
} as const;
