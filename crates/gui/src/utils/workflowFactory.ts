/** A workflow-like value that can be grouped by its optional factory name. */
export type FactoryNamed = { factory_name: string | null };

/** `null` means that no factory scope is active. */
export type FactoryFilterValue = string | null;

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

/** Exact-match factory predicate shared by every factory-scoped surface. */
export function matchesFactory(
  factoryName: string | null,
  selectedFactory: FactoryFilterValue
): boolean {
  return selectedFactory === null || factoryName === selectedFactory;
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
