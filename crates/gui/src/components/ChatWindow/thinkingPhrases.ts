/** Curated status phrases for the futuristic thinking indicator. */
export const FUTURISTIC_THINKING_PHRASES = [
  "Tempting the fates…",
  "Consulting the Oracle of Delphi…",
  "Materializing from the ether…",
  "Tracing the neon constellation…",
  "Decoding signals from the noosphere…",
  "Asking the silicon sphinx…",
  "Threading the quantum labyrinth…",
  "Reading omens in the electric dark…",
  "Summoning a reply from the deep net…",
  "Waking the dream of the machine…",
  "Mapping the hidden lattice…",
  "Aligning the astral circuitry…",
  "Consulting the backup moon…",
  "Tuning the signal through stardust…",
  "Following a trail of phosphor…",
  "Asking the clouds to hold…",
  "Rendering a pocket universe…",
  "Searching the archive between seconds…",
  "Polishing a thought from raw voltage…",
  "Translating whispers in the static…",
  "Navigating the chrome labyrinth…",
  "Measuring the pulse of the void…",
  "Opening a channel to tomorrow…",
  "Gathering fragments from the starfield…",
  "Letting the circuits dream aloud…",
  "Reassembling the scattered coordinates…",
  "Cross-referencing the cosmic footnotes…",
  "Charging the idea capacitor…",
  "Watching the horizon for a reply…",
  "Distilling signal from the shimmer…",
  "Consulting the midnight mainframe…",
  "Sending a query past the event horizon…",
  "Folding time around the answer…",
  "Looking beneath the rendered surface…",
  "Following the blue thread through the grid…",
  "Sampling the atmosphere of possibility…",
  "Calibrating the intuition engine…",
  "Listening for a pattern in the rain…",
  "Synchronizing with the distant pulse…",
  "Building a bridge across the unknown…",
  "Asking the satellites for directions…",
  "Searching the velvet dark for clues…",
  "Warming up the quantum typewriter…",
  "Translating from machine dream…",
  "Checking the map of improbable places…",
  "Composing a response from moonlight…",
  "Divining structure from the noise…",
  "Spinning up the auxiliary imagination…",
  "Tracking a comet through the data…",
  "Consulting the library of lost futures…",
  "Letting the answer emerge from orbit…",
  "Refracting the question through crystal logic…",
  "Scanning the edge of the possible…",
  "Harvesting photons for a thought…",
  "Decoding the language of distant stars…",
  "Running diagnostics on the imagination…",
  "Following the signal under the static…",
  "Summoning the quiet machinery…",
  "Charting a course through electric fog…",
  "Waiting for the right constellation…",
] as const;

export type FuturisticThinkingPhrase =
  (typeof FUTURISTIC_THINKING_PHRASES)[number];

export function selectFuturisticThinkingPhrase(
  random = Math.random
): FuturisticThinkingPhrase {
  const index = Math.min(
    FUTURISTIC_THINKING_PHRASES.length - 1,
    Math.floor(random() * FUTURISTIC_THINKING_PHRASES.length)
  );
  return FUTURISTIC_THINKING_PHRASES[index];
}
