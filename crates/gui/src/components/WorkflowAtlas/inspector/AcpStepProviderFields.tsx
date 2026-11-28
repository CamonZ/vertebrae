import { useEffect, useId, useState } from "react";
import { commands, type SharedSettings } from "../../../bindings";

export function AcpStepProviderFields({
  provider, model, onProvider, onModel,
}: {
  provider: string;
  model: string;
  onProvider: (value: string) => void;
  onModel: (value: string) => void;
}) {
  const id = useId();
  const [profiles, setProfiles] = useState<NonNullable<SharedSettings["acp_providers"]>>([]);
  useEffect(() => {
    let active = true;
    void commands.getSharedSettings().then((result) => {
      if (active && result.status === "ok") setProfiles(result.data.acp_providers ?? []);
    }).catch(() => {
      // A remote daemon can have different providers. IDs remain editable.
    });
    return () => { active = false; };
  }, []);
  const models = profiles.find((profile) => profile.id === provider)?.models ?? [];
  return (
    <>
      <label>
        ACP provider
        <input value={provider} list={`${id}-providers`} onChange={(event) => onProvider(event.target.value)} />
      </label>
      <datalist id={`${id}-providers`}>
        {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
      </datalist>
      <label>
        Model
        <input value={model} list={`${id}-models`} onChange={(event) => onModel(event.target.value)} />
      </label>
      <datalist id={`${id}-models`}>
        {models.map((modelId) => <option key={modelId} value={modelId} />)}
      </datalist>
    </>
  );
}
