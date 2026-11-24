import { useEffect, useState } from "react";
import { commands } from "../../bindings";
import { TYPE_PAIRINGS, useUIStore } from "../../stores/uiStore";
import { TYPEFACE_ROLES } from "../../utils/readingAppearance";
import { Input } from "../atoms/Input";
import { Dropdown } from "../molecules/Dropdown";

export function CustomTypefaceSettings({ onSaved }: { onSaved(): void }) {
  const customTypefaces = useUIStore((state) => state.customTypefaces);
  const setCustomTypefaces = useUIStore((state) => state.setCustomTypefaces);
  const base = useUIStore((state) => state.customTypefaceBase ?? state.typePairing);
  const setBase = useUIStore((state) => state.setCustomTypefaceBase);
  const [families, setFamilies] = useState<string[] | null>(null);

  useEffect(() => {
    let active = true;
    commands.getLocalFontFamilies()
      .then((result) => {
        if (active) setFamilies(result.status === "ok" ? result.data : []);
      })
      .catch(() => {
        if (active) setFamilies([]);
      });
    return () => { active = false; };
  }, []);

  return (
    <div className="mt-4 grid gap-3 rounded-lg bg-bg-2 p-4 sm:grid-cols-2">
      <div className="grid gap-1 sm:col-span-2">
        <span className="text-secondary text-fg-soft">Base pairing</span>
        <Dropdown
          aria-label="Base pairing"
          size="field"
          value={base}
          options={TYPE_PAIRINGS}
          onChange={(value) => {
            const pairing = TYPE_PAIRINGS.find((option) => option.value === value);
            if (pairing) {
              setBase(pairing.value);
              onSaved();
            }
          }}
        />
      </div>
      {families === null && <p role="status" className="text-secondary text-fg-soft">Loading installed fonts…</p>}
      {families?.length === 0 && (
        <p role="status" className="text-secondary text-fg-soft sm:col-span-2">
          Installed fonts couldn’t be listed. Enter a family name or leave the field blank to use the base pairing.
        </p>
      )}
      {families && TYPEFACE_ROLES.map(({ id, label }) => {
        const current = customTypefaces[id] ?? "";
        const available = !current || families.includes(current);
        const save = (value: string) => {
          setCustomTypefaces({ ...customTypefaces, [id]: value });
          onSaved();
        };
        return (
          <div key={id} className="grid content-start gap-1">
            <span className="text-secondary text-fg-soft">{label}</span>
            {families.length > 0 ? (
              <Dropdown
                aria-label={label}
                size="field"
                value={current}
                searchPlaceholder="Search installed fonts"
                placement="up"
                options={[
                  { value: "", label: "Use pairing font" },
                  ...(!available ? [{ value: current, label: `${current} · unavailable`, disabled: true }] : []),
                  ...families.map((name) => ({ value: name, label: name })),
                ]}
                onChange={save}
              />
            ) : (
              <Input
                key={current}
                aria-label={label}
                placeholder="Use pairing font"
                maxLength={100}
                defaultValue={current}
                onBlur={(event) => {
                  if (event.target.value !== current) save(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            )}
            {families.length > 0 && !available && (
              <p className="text-secondary text-fg-soft">Using the base pairing until this font is available.</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
