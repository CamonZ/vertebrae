/** A workflow-like value that can be grouped by its optional factory name. */
export type FactoryNamed = { factory_name: string | null };

/** The explicit UI scope for workflows whose factory name is `null`. */
export interface NoFactoryScope {
  readonly kind: "no-factory";
}

export const NO_FACTORY_SCOPE: NoFactoryScope = Object.freeze({
  kind: "no-factory",
});

/** `null` means all factories; this object means the synthetic No Factory scope. */
export type FactoryFilterValue = string | null | NoFactoryScope;

export function isNoFactoryScope(
  value: FactoryFilterValue
): value is NoFactoryScope {
  return (
    typeof value === "object" && value !== null && value.kind === "no-factory"
  );
}

/** Return unique, stable factory values for the filter control. */
export function factoryNames(workflows: readonly FactoryNamed[]): string[] {
  return [
    ...new Set(
      workflows
        .map((workflow) => workflow.factory_name)
        .filter((name): name is string => name !== null && name !== "")
    ),
  ].sort((a, b) => a.localeCompare(b));
}

/** Whether any record has the explicitly unassigned `null` factory value. */
export function hasNoFactory(workflows: readonly FactoryNamed[]): boolean {
  return workflows.some((workflow) => workflow.factory_name === null);
}

/** Check that a selected scope still exists in the current workflow collection. */
export function factoryScopeExists(
  workflows: readonly FactoryNamed[],
  selectedFactory: FactoryFilterValue
): boolean {
  if (selectedFactory === null) return true;
  if (isNoFactoryScope(selectedFactory)) return hasNoFactory(workflows);
  return factoryNames(workflows).includes(selectedFactory);
}

/** Exact-match factory predicate shared by every factory-scoped surface. */
export function matchesFactory(
  factoryName: string | null,
  selectedFactory: FactoryFilterValue
): boolean {
  if (selectedFactory === null) return true;
  if (isNoFactoryScope(selectedFactory)) return factoryName === null;
  return factoryName === selectedFactory;
}

/** Filter factory-named records without changing the selected string. */
export function filterByFactory<T extends FactoryNamed>(
  items: readonly T[],
  selectedFactory: FactoryFilterValue
): T[] {
  return items.filter((item) =>
    matchesFactory(item.factory_name, selectedFactory)
  );
}
