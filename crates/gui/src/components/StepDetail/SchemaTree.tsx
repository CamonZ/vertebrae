import { useState, type ReactNode } from "react";

/**
 * Renders a JSON Schema as a collapsible tree. Used by the step detail panel and
 * the Workflow Atlas step inspector to show a step's structured output schema.
 */

// JSON Schema type → color mapping
const SCHEMA_TYPE_COLORS: Record<string, string> = {
  string: "text-[var(--color-ok)]",
  number: "text-[var(--color-info)]",
  integer: "text-[var(--color-info)]",
  boolean: "text-[var(--color-warn)]",
  object: "text-[var(--color-accent)]",
  array: "text-[var(--color-accent)]",
  null: "text-[var(--color-fg-mute)]",
};

function SchemaTypeBadge({ type }: { type: string }) {
  return (
    <span
      className={`font-mono text-xs ${SCHEMA_TYPE_COLORS[type] ?? "text-[var(--color-fg-soft)]"}`}
    >
      {type}
    </span>
  );
}

function SchemaNode({
  name,
  schema,
  required = false,
  depth = 0,
  isLast = true,
}: {
  name?: string;
  schema: Record<string, unknown>;
  required?: boolean;
  depth?: number;
  isLast?: boolean;
}) {
  const [expanded, setExpanded] = useState(depth < 2);

  const type = schema.type as string | undefined;
  const description = schema.description as string | undefined;
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const requiredFields = (schema.required as string[]) ?? [];
  const items = schema.items as Record<string, unknown> | undefined;
  const title = schema.title as string | undefined;

  const isExpandable = type === "object" && properties && Object.keys(properties).length > 0;
  const propertyEntries = properties ? Object.entries(properties) : [];

  // Format type display: arrays show itemType[]
  let typeDisplay: ReactNode;
  if (type === "array" && items) {
    const itemType = (items.type as string) ?? "any";
    typeDisplay = (
      <>
        <SchemaTypeBadge type={itemType} />
        <span className="font-mono text-xs text-[var(--color-fg-mute)]">
          {"[]"}
        </span>
      </>
    );
  } else {
    typeDisplay = <SchemaTypeBadge type={type ?? "any"} />;
  }

  // Tree connector characters
  const connector = depth > 0 ? (isLast ? "└─ " : "├─ ") : "";

  return (
    <div data-testid={name ? `schema-node-${name}` : "schema-root"}>
      {/* Node row */}
      <div className="flex items-baseline gap-1 py-px">
        {depth > 0 && (
          <span className="select-none whitespace-pre font-mono text-xs text-[var(--color-fg-faint)]">
            {connector}
          </span>
        )}

        {/* Expand/collapse toggle for objects */}
        {isExpandable ? (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="inline-flex cursor-pointer items-center text-[var(--color-fg-mute)] hover:text-[var(--color-fg)]"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            <svg
              className={`h-3 w-3 transition-transform duration-[var(--t-base)] ease-[var(--ease-default)] ${expanded ? "rotate-90" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        ) : depth > 0 ? (
          <span className="inline-block w-3" />
        ) : null}

        {/* Property name */}
        {name && (
          <span className="font-mono text-xs font-medium text-[var(--color-fg)]">
            {name}
          </span>
        )}
        {name && (
          <span className="font-mono text-xs text-[var(--color-fg-mute)]">:</span>
        )}

        {/* Type */}
        {typeDisplay}

        {/* Required marker */}
        {required && (
          <span
            className="font-mono text-2xs text-[var(--color-err)]"
            title="required"
          >
            *
          </span>
        )}

        {/* Root title */}
        {title && depth === 0 && (
          <span className="ml-1 text-xs text-[var(--color-fg-mute)]">
            — {title}
          </span>
        )}
      </div>

      {/* Description */}
      {description && depth > 0 && (
        <div className="ml-8 pl-1">
          <span className="text-2xs italic leading-tight text-[var(--color-fg-mute)]">
            {description}
          </span>
        </div>
      )}

      {/* Nested properties */}
      {isExpandable && expanded && (
        <div className={depth > 0 ? "ml-4" : "ml-1"}>
          {propertyEntries.map(([key, value], index) => (
            <SchemaNode
              key={key}
              name={key}
              schema={value}
              required={requiredFields.includes(key)}
              depth={depth + 1}
              isLast={index === propertyEntries.length - 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function SchemaTree({ schema }: { schema: Record<string, unknown> }) {
  return (
    <div
      className="overflow-auto rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-bg-2)] p-3"
      data-testid="schema-tree"
    >
      <SchemaNode schema={schema} />
    </div>
  );
}
