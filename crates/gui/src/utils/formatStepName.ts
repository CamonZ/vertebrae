export function formatStepName(
  stepName: string | null,
  emptyLabel: string
): string {
  if (!stepName) return emptyLabel;
  return (
    stepName.charAt(0).toUpperCase() + stepName.slice(1).replace(/_/g, " ")
  );
}
