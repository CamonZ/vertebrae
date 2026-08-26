import { Select, type SelectOption } from "./atoms/Select";
import {
  factoryNames,
  type FactoryFilterValue,
  type FactoryNamed,
} from "../utils/workflowFactory";

interface FactoryFilterProps {
  workflows: readonly FactoryNamed[];
  value: FactoryFilterValue;
  onChange: (value: FactoryFilterValue) => void;
  id: string;
}

/** Native dropdown so factory values remain literal, exact-match strings. */
export function FactoryFilter({
  workflows,
  value,
  onChange,
  id,
}: FactoryFilterProps) {
  const options: SelectOption[] = [
    { value: "", label: "All factories" },
    ...factoryNames(workflows).map((name) => ({ value: name, label: name })),
  ];

  return (
    <Select
      id={id}
      options={options}
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value || null)}
      aria-label="Filter by factory"
      data-testid={`${id}-select`}
    />
  );
}
