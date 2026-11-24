import { useRef } from "react";
import type { AcpAgentDraft } from "./settingsDraft";
import { Button } from "../atoms/Button";
import { Notice, TextField } from "./SettingsFields";
import { card } from "./settingsStyles";

export function AcpAgentForm({
  settings,
  onChange,
  onRemove,
}: {
  settings: AcpAgentDraft;
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
        ACP connection
      </h2>
      <TextField
        label="Connection name"
        value={settings.name}
        change={(name) => onChange({ ...settings, name })}
      />
      <TextField
        label="Agent executable"
        hint="Use a command on PATH or an absolute path."
        value={settings.executable}
        change={(executable) => onChange({ ...settings, executable })}
      />
      <div role="group" aria-label="Agent arguments" className="space-y-3">
        {settings.args.map((arg, index) => (
          <div key={arg.id} className="space-y-2">
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
      </div>
      <Notice>Each argument is passed exactly as entered.</Notice>
      {onRemove && (
        <Button type="button" size="sm" variant="danger" onClick={onRemove}>
          Remove connection
        </Button>
      )}
    </div>
  );
}
