import { card } from "./settingsStyles";
import { useState } from "react";
import type {
  SettingsEdit,
  ProviderSettings,
  EnvironmentEdit,
} from "../../bindings";
import { Textarea } from "../atoms/Input";
import { Button } from "../atoms/Button";
import {
  Field,
  TextField,
  Choice,
  SecretField,
  Notice,
} from "./SettingsFields";
import { keep } from "./settingsDraft";
export function ProviderForm({
  draft,
  stored,
  change,
}: {
  draft: Extract<SettingsEdit, { section: "provider" }>;
  stored?: ProviderSettings;
  change: (v: SettingsEdit) => void;
}) {
  const environment = new Map<string, EnvironmentEdit>(
    stored?.environment_names.map((name) => [name, { name, secret: keep }]) ??
      []
  );
  draft.environment.forEach((entry) => environment.set(entry.name, entry));
  const [newName, setNewName] = useState("");
  return (
    <div className={`${card} space-y-5`}>
      <h2 className="font-serif text-2xl">
        {draft.create ? "New provider" : draft.id}
      </h2>
      <TextField
        label="Provider ID"
        disabled={!draft.create}
        value={draft.id}
        change={(id) => change({ ...draft, id })}
      />
      <Choice
        label="Harness"
        value={draft.harness}
        values={[
          ["codex", "Codex"],
          ["claude", "Claude"],
          ["typesafe", "TypeSafe"],
        ]}
        change={(harness) =>
          change({
            ...draft,
            harness,
            wire_api: harness === "codex" ? draft.wire_api : "",
            environment:
              harness === "typesafe"
                ? Array.from(environment.values()).map((e) => ({
                    name: e.name,
                    secret: { action: "clear" },
                  }))
                : draft.environment,
          })
        }
      />
      <Notice>
        Changing the harness clears incompatible wire API and environment
        overrides when saved.
      </Notice>
      <TextField
        label={
          draft.harness === "typesafe" ? "System One endpoint" : "API base URL"
        }
        value={draft.endpoint}
        change={(endpoint) => change({ ...draft, endpoint })}
      />
      <Field label="Model IDs" hint="Enter one exact model ID per line.">
        {(id) => (
          <Textarea
            id={id}
            rows={4}
            value={draft.models.join("\n")}
            onChange={(e) =>
              change({ ...draft, models: e.target.value.split("\n") })
            }
          />
        )}
      </Field>
      <Choice
        label="Default model"
        value={draft.default_model}
        values={[
          ["", "First configured model"],
          ...draft.models
            .filter(Boolean)
            .map((v) => [v, v] as [string, string]),
        ]}
        change={(default_model) => change({ ...draft, default_model })}
      />
      <TextField
        label="API key environment variable"
        hint="A nonblank value in the executing process overrides the stored key."
        value={draft.api_key_env}
        change={(api_key_env) => change({ ...draft, api_key_env })}
      />
      <SecretField
        label="Provider API key"
        storage={stored?.key_storage ?? "none"}
        configured={stored?.has_api_key ?? false}
        value={draft.key}
        change={(key) => change({ ...draft, key })}
      />
      {stored?.credential_override && (
        <Notice>
          The configured environment variable supplies this GUI process’s
          credential. The daemon may have a different environment.
        </Notice>
      )}
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          Advanced options
        </summary>
        <div className="mt-4 space-y-4">
          {draft.harness === "codex" && (
            <Choice
              label="Wire API"
              value={draft.wire_api}
              values={[
                ["", "Harness default"],
                ["responses", "Responses"],
                ["chat", "Chat"],
              ]}
              change={(wire_api) => change({ ...draft, wire_api })}
            />
          )}
          {draft.harness !== "typesafe" && (
            <>
              <p className="text-xs text-[var(--color-fg-mute)]">
                Environment values remain hidden. Keep, replace or clear each
                value explicitly.
              </p>
              {Array.from(environment.values()).map((entry) => (
                <SecretField
                  key={entry.name}
                  label={`Environment: ${entry.name}`}
                  configured={
                    stored?.environment_names.includes(entry.name) ?? false
                  }
                  value={entry.secret}
                  change={(secret) =>
                    change({
                      ...draft,
                      environment: [
                        ...draft.environment.filter(
                          (e) => e.name !== entry.name
                        ),
                        { name: entry.name, secret },
                      ],
                    })
                  }
                />
              ))}
              <TextField
                label="New environment variable name"
                value={newName}
                change={setNewName}
              />
              <Button
                disabled={!newName.trim() || environment.has(newName.trim())}
                onClick={() => {
                  change({
                    ...draft,
                    environment: [
                      ...draft.environment,
                      {
                        name: newName.trim(),
                        secret: { action: "replace", value: "" },
                      },
                    ],
                  });
                  setNewName("");
                }}
              >
                Add environment variable
              </Button>
            </>
          )}
        </div>
      </details>
    </div>
  );
}
