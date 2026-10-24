import {
  useId,
  useContext,
  isValidElement,
  cloneElement,
  type AriaAttributes,
  type ReactNode,
} from "react";
import type { SecretEdit } from "../../bindings";
import { keep } from "./settingsDraft";
import { SettingsValidationContext } from "./settingsValidation";
import { Input } from "../atoms/Input";
import { Select } from "../atoms/Select";
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  const validation = useContext(SettingsValidationContext);
  const error = validation?.field === label ? validation.message : null;
  const child = children(id);
  const control = isValidElement<AriaAttributes>(child)
    ? cloneElement(child, {
        "aria-invalid": error ? true : undefined,
        "aria-describedby":
          [hint ? `${id}-hint` : "", error ? `${id}-error` : ""]
            .filter(Boolean)
            .join(" ") || undefined,
      })
    : child;
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {control}
      {error && (
        <p id={`${id}-error`} className="text-xs text-[var(--color-err)]">
          {error}
        </p>
      )}
      {hint && (
        <p
          id={`${id}-hint`}
          className="text-xs leading-5 text-[var(--color-fg-mute)]"
        >
          {hint}
        </p>
      )}
    </div>
  );
}
export function TextField({
  label,
  value,
  change,
  hint,
  disabled = false,
}: {
  label: string;
  value: string;
  change: (v: string) => void;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <Input
          id={id}
          value={value}
          disabled={disabled}
          onChange={(e) => change(e.target.value)}
        />
      )}
    </Field>
  );
}
export function Choice({
  label,
  value,
  values,
  change,
}: {
  label: string;
  value: string;
  values: [string, string][];
  change: (v: string) => void;
}) {
  return (
    <Field label={label}>
      {(id) => (
        <Select
          id={id}
          value={value}
          options={values.map(([value, label]) => ({ value, label }))}
          onChange={(e) => change(e.target.value)}
        />
      )}
    </Field>
  );
}
export function SecretField({
  label,
  configured,
  value,
  change,
  allowClear = true,
  storage,
}: {
  label: string;
  configured: boolean;
  value: SecretEdit;
  change: (v: SecretEdit) => void;
  allowClear?: boolean;
  storage?: string;
}) {
  return (
    <div className="space-y-3">
      <Choice
        label={label}
        value={value.action}
        values={[
          [
            "keep",
            configured ? "Keep stored credential" : "No stored credential",
          ],
          [
            "replace",
            storage !== undefined
              ? configured
                ? "Replace API key"
                : "Set API key"
              : "Replace credential",
          ],
          ...(storage === "config"
            ? [
                ["migrate", "Move saved key to OS credential store"] as [
                  string,
                  string,
                ],
              ]
            : []),
          ...(allowClear
            ? [["clear", "Clear stored credential"] as [string, string]]
            : []),
        ]}
        change={(action) =>
          change(
            action === "replace"
              ? { action, value: "" }
              : action === "clear" || action === "migrate"
                ? { action }
                : keep
          )
        }
      />
      {storage !== undefined && (
        <p className="text-xs leading-5 text-[var(--color-fg-mute)]">
          {storage === "config"
            ? "The existing key is in config.toml. Move it to the OS credential store without retyping it, or enter a replacement."
            : storage === "os"
              ? "Uses the OS credential store. Stored keys are never read back into this form."
              : "Enter an API key below. It will be stored in macOS Keychain, Linux Secret Service, or Windows Credential Manager; only a reference goes in config.toml."}
        </p>
      )}
      {(value.action === "replace" ||
        (storage !== undefined && !configured && value.action === "keep")) && (
        <Field label={`New ${label.toLowerCase()}`}>
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              value={value.action === "replace" ? value.value : ""}
              placeholder="Enter API key"
              onChange={(e) =>
                change(
                  !configured && !e.target.value
                    ? keep
                    : { action: "replace", value: e.target.value }
                )
              }
              required={value.action === "replace"}
            />
          )}
        </Field>
      )}
    </div>
  );
}
export function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-[var(--radius-md)] bg-[var(--color-bg-2)] p-3 text-sm leading-6 text-[var(--color-fg-soft)]">
      {children}
    </p>
  );
}
