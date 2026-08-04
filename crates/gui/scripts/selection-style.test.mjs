import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const stylesheet = readFileSync(
  fileURLToPath(new URL("../src/index.css", import.meta.url)),
  "utf8"
);

function ruleFor(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = stylesheet.match(
    new RegExp(`(?:^|\\n)${escapedSelector}\\s*\\{([^}]*)\\}`, "m")
  );

  assert.ok(match, `Missing CSS rule for ${selector}`);
  return match[1];
}

test("dark selection uses the muted copper accent with readable text", () => {
  const darkSelection = ruleFor("::selection");

  assert.match(
    darkSelection,
    /background-color:\s*var\(--color-accent-mute\);/
  );
  assert.match(darkSelection, /color:\s*var\(--color-fg\);/);
});

test("light selection preserves the paper wash with readable foreground text", () => {
  const lightSelection = ruleFor("html.light ::selection");

  assert.match(
    lightSelection,
    /background-color:\s*var\(--color-accent-wash\);/
  );
  assert.match(lightSelection, /color:\s*var\(--color-fg\);/);
});
