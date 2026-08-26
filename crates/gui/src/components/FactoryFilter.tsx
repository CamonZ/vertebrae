import { Select, type SelectOption } from "./atoms/Select";
import {
  factoryNames,
  hasNoFactory,
  isNoFactoryScope,
  NO_FACTORY_SCOPE,
  type FactoryFilterValue,
  type FactoryNamed,
} from "../utils/workflowFactory";

const NO_FACTORY_OPTION_VALUE = "__no_factory__";
const COLLIDING_FACTORY_OPTION_PREFIX = "named:";

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
    ...(hasNoFactory(workflows)
      ? [{ value: NO_FACTORY_OPTION_VALUE, label: "No Factory" }]
      : []),
    ...factoryNames(workflows).map((name) => ({
      value:
        name === NO_FACTORY_OPTION_VALUE
          ? `${COLLIDING_FACTORY_OPTION_PREFIX}${name}`
          : name,
      label: name,
    })),
  ];

  const selectedValue =
    value === null
      ? ""
      : isNoFactoryScope(value)
        ? NO_FACTORY_OPTION_VALUE
        : value === NO_FACTORY_OPTION_VALUE
          ? `${COLLIDING_FACTORY_OPTION_PREFIX}${value}`
          : value;

  return (
    <Select
      id={id}
      options={options}
      value={selectedValue}
      onChange={(event) => {
        const selectedValue = event.target.value;
        onChange(
          selectedValue === NO_FACTORY_OPTION_VALUE
            ? NO_FACTORY_SCOPE
            : selectedValue === ""
              ? null
              : selectedValue ===
                  `${COLLIDING_FACTORY_OPTION_PREFIX}${NO_FACTORY_OPTION_VALUE}`
                ? NO_FACTORY_OPTION_VALUE
                : selectedValue
        );
      }}
      aria-label="Filter by factory"
      data-testid={`${id}-select`}
    />
  );
}
