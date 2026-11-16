/** Accent hue applied as `html[data-accent]` (see ACCENTS in index.css). */
export type Accent = "orchid" | "ember" | "jade" | "lagoon" | "cobalt" | "iris";
export const ACCENTS: ReadonlyArray<{
  value: Accent;
  label: string;
  description: string;
}> = [
  { value: "orchid", label: "Orchid", description: "Rose pink" },
  { value: "ember", label: "Ember", description: "Warm coral" },
  { value: "jade", label: "Jade", description: "Green jade" },
  { value: "lagoon", label: "Lagoon", description: "Cyan" },
  { value: "cobalt", label: "Cobalt", description: "Blue" },
  { value: "iris", label: "Iris", description: "Violet" },
];
