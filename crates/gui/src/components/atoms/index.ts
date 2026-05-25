/**
 * Atomic components for the Hearth design system.
 *
 * Indivisible primitives — variants/sizes/states only, no app-specific logic.
 * Compose into molecules in components/* or molecules/* in follow-up tickets.
 */

export { Text } from "./Text";
export type { TextVariant, TextColor } from "./Text";

export { EmWord } from "./EmWord";

export { Count } from "./Count";

export { Icon } from "./Icon";
export type { IconSize } from "./Icon";

export { Button } from "./Button";
export type { ButtonVariant, ButtonSize } from "./Button";

export { Input, Textarea } from "./Input";

export { Select } from "./Select";
export type { SelectOption, SelectOptionGroup } from "./Select";

export { Chip } from "./Chip";
export type { ChipVariant } from "./Chip";

export { Badge } from "./Badge";
export type { BadgeIntent, BadgeSize } from "./Badge";

export { Divider } from "./Divider";

export { Tooltip } from "./Tooltip";
export type { TooltipPlacement } from "./Tooltip";

export { Skeleton } from "./Skeleton";
export type { SkeletonVariant } from "./Skeleton";

// Existing atoms that already match Hearth — re-exported so consumers can
// reach the full catalog from one entrypoint.
export { Spinner } from "../Spinner";
export { Toggle } from "../Toggle";
export { RelativeTime } from "../RelativeTime";
