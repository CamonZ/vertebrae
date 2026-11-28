import { useRef } from "react";
import type { AcpAgentDraft } from "./settingsDraft";
import { Button } from "../atoms/Button";
import { TextField } from "./SettingsFields";
import { card } from "./settingsStyles";

export function AcpAgentForm({
  settings,
  existing,
  onChange,
  onRemove,
}: {
  settings: AcpAgentDraft;
  existing: boolean;
  onChange: (settings: AcpAgentDraft) => void;
  onRemove?: () => void;
}) {
  const addButton = useRef<HTMLButtonElement>(null);

  function removeArgument(id: string) {
    onChange({
      ...settings,
      args: settings.args.filter((arg) => arg.id !== id),
    });
    addButton.current?.focus();
  }

  function addArgument() {
    onChange({
      ...settings,
      args: [...settings.args, { id: crypto.randomUUID(), value: "" }],
    });
  }

  return (
    <div className={`${card} space-y-5`}>
      <h2 className="font-serif text-2xl" data-settings-anchor>
        {existing ? settings.name.trim() || "ACP provider" : "New ACP provider"}
      </h2>
      {!existing && (
        <TextField label="Provider ID" value={settings.id}
          change={(id) => onChange({ ...settings, id })} />
      )}
      {existing && <p className="text-secondary">Provider ID: {settings.id}</p>}
      <TextField
        label="Provider name"
        value={settings.name}
        change={(name) => onChange({ ...settings, name })}
      />
      <TextField
        label="Agent executable"
        hint="Use a command on PATH or an absolute path."
        value={settings.executable}
        change={(executable) => onChange({ ...settings, executable })}
      />
      <TextField label="Models" hint="Comma-separated agent model IDs. Leave empty to use the agent’s advertised models."
        value={settings.models} change={(models) => onChange({ ...settings, models })} />
      <TextField label="Default model" value={settings.default_model}
        change={(default_model) => onChange({ ...settings, default_model })} />
      <fieldset className="space-y-3 border-t border-[var(--color-line)] pt-3">
        <legend className="text-content font-medium">Arguments</legend>
        <p className="text-secondary text-[var(--color-fg-mute)]">
          Optional. Each argument is passed exactly as entered.
        </p>
        {settings.args.map((arg, index) => (
          <div
            key={arg.id}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2"
          >
            <TextField
              label={`Argument ${index + 1}`}
              value={arg.value}
              change={(value) =>
                onChange({
                  ...settings,
                  args: settings.args.map((entry, i) =>
                    i === index ? { ...entry, value } : entry
                  ),
                })
              }
            />
            <Button
              type="button"
              size="sm"
              aria-label={`Remove argument ${index + 1}`}
              onClick={() => removeArgument(arg.id)}
            >
              Remove
            </Button>
          </div>
        ))}
        <Button ref={addButton} type="button" size="sm" onClick={addArgument}>
          Add argument
        </Button>
      </fieldset>
      {onRemove && (
        <Button type="button" size="sm" variant="danger" onClick={onRemove}>
          Remove provider
        </Button>
      )}
    </div>
  );
}
