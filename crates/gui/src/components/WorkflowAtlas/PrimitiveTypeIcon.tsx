/** Small shape-only mark shared by structured inference summaries/editors. */
export type StructuredPrimitive = "choice" | "score" | "noul";

export function PrimitiveTypeIcon({
  type,
  className = "",
}: {
  type: StructuredPrimitive;
  className?: string;
}) {
  return (
    <span
      className={`ag-primitive-icon is-${type}${className ? ` ${className}` : ""}`}
      aria-hidden="true"
    />
  );
}
