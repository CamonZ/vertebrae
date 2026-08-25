import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const stylesheet = readFileSync(
  fileURLToPath(new URL("../src/index.css", import.meta.url)),
  "utf8"
);
const workflowStylesheet = readFileSync(
  fileURLToPath(
    new URL(
      "../src/components/WorkflowAtlas/WorkflowAtlas.css",
      import.meta.url
    )
  ),
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

test("light selection uses the muted copper accent with readable foreground text", () => {
  const lightSelection = ruleFor("html.light ::selection");

  assert.match(
    lightSelection,
    /background-color:\s*var\(--color-accent-mute\);/
  );
  assert.match(lightSelection, /color:\s*var\(--color-fg\);/);
});

test("light chat panels retain a frosted surface treatment", () => {
  const lightPanel = ruleFor(".light .hc-panel");

  assert.match(lightPanel, /background:\s*linear-gradient/);
  assert.match(lightPanel, /,\s*transparent\)/);
  assert.match(lightPanel, /var\(--bg-3\) 24%/);
  assert.match(lightPanel, /backdrop-filter:\s*blur\(30px\)/);
});

test("chat and entity side panels share the neutral gray shell border", () => {
  assert.match(
    stylesheet,
    /\.hc-panel,\s*\.detail\.detail-float\s*\{[\s\S]*?border:\s*1px solid var\(--panel-border\);/
  );
  assert.match(
    stylesheet,
    /\.light \.hc-panel,\s*\.light \.detail\.detail-float\s*\{[\s\S]*?border-color:\s*var\(--panel-border\);/
  );
  assert.match(
    stylesheet,
    /\.hc-panel,\s*\.detail\.detail-float\s*\{[\s\S]*?--panel-border:\s*color-mix\(in oklch, var\(--fg\) 12%, transparent\);/
  );
  assert.match(
    stylesheet,
    /\.light \.hc-panel,\s*\.light \.detail\.detail-float\s*\{[\s\S]*?--panel-border:\s*color-mix\(in oklch, var\(--fg\) 18%, transparent\);/
  );
});

test("entity detail chrome uses the neutral panel border", () => {
  assert.match(
    stylesheet,
    /\.detail\.detail-float \.detail-resize-handle:hover::after,[\s\S]*?background:\s*var\(--fg-mute\);/
  );
  assert.match(
    stylesheet,
    /\.tasks-v2-detail-shell \.t-detail-head::after\s*\{[\s\S]*?background:\s*linear-gradient\(90deg, var\(--panel-border\),/
  );
  assert.match(
    stylesheet,
    /\.tasks-v2-detail-shell \.t-detail-hero \.hero-status\s*\{[\s\S]*?border-left-color:\s*var\(--panel-border\);/
  );
  for (const selector of [
    "\\.wfd-badge",
    "\\.wfd-status\\.live",
    "\\.wfd-editor",
    "\\.wfd-save",
    "\\.wfd-tr \\.lab",
    "\\.wfd-num",
    "\\.wfd-tag",
    "\\.wfd-trans",
  ]) {
    assert.match(
      workflowStylesheet,
      new RegExp(
        `${selector}\\s*\\{[\\s\\S]*?border(?:-color)?:\\s*(?:1px solid )?var\\(--panel-border\\);`
      )
    );
  }
});

test("task row focus does not add an accent border", () => {
  assert.doesNotMatch(
    stylesheet,
    /\.tasks-v2 \.t-row:focus-visible\s*\{[\s\S]*?box-shadow:\s*[^;}]*var\(--accent\)/
  );
});
