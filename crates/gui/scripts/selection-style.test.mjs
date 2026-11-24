import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const readStylesheet = (path) =>
  readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), "utf8");

const base = readStylesheet("styles/base.css");
const chat = readStylesheet("components/ChatWindow/chat-panel.css");
const chrome = readStylesheet("components/floating-panel-chrome.css");
const panels = readStylesheet("components/entity-panels.css");
const tasks = readStylesheet("pages/tasks.css");
const workflowStylesheet = readStylesheet("components/WorkflowAtlas/WorkflowAtlas.css");

function ruleFor(stylesheet, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = stylesheet.match(
    new RegExp(`(?:^|\\n)[ \t]*${escapedSelector}\\s*\\{([^}]*)\\}`, "m")
  );

  assert.ok(match, `Missing CSS rule for ${selector}`);
  return match[1];
}

test("dark selection uses the accent text-selection tint with readable text", () => {
  const darkSelection = ruleFor(base, "::selection");

  assert.match(
    darkSelection,
    /background-color:\s*var\(--color-text-selection\);/
  );
  assert.match(darkSelection, /color:\s*var\(--color-fg\);/);
});

test("light selection uses the accent text-selection tint with readable foreground text", () => {
  const lightSelection = ruleFor(base, "html.light ::selection");

  assert.match(
    lightSelection,
    /background-color:\s*var\(--color-text-selection\);/
  );
  assert.match(lightSelection, /color:\s*var\(--color-fg\);/);
});

test("light chat panels retain a frosted surface treatment", () => {
  const lightPanel = ruleFor(chat, ".light .hc-panel");

  assert.match(lightPanel, /background:\s*linear-gradient/);
  assert.match(lightPanel, /,\s*transparent\)/);
  assert.match(lightPanel, /var\(--surface-page\) 78%/);
  assert.match(lightPanel, /backdrop-filter:\s*blur\(30px\)/);
});

test("chat and entity side panels share the neutral gray shell border", () => {
  assert.match(
    chrome,
    /\.hc-panel,\s*\.detail\.detail-float\s*\{[^}]*--panel-border-opacity: 12%;[^}]*border: 1px solid var\(--panel-border\);/
  );
  assert.match(
    chrome,
    /\.light \.hc-panel,\s*\.light \.detail\.detail-float\s*\{[^}]*--panel-border-opacity: 18%;/
  );
});

test("entity detail chrome uses the neutral panel border", () => {
  assert.match(
    panels,
    /\.detail\.detail-float \.detail-resize-handle:hover::after,[\s\S]*?background:\s*var\(--fg-mute\);/
  );
  assert.match(
    tasks,
    /\.tasks-v2-detail-shell \.t-detail-head::after\s*\{[\s\S]*?background:\s*linear-gradient\(90deg, var\(--panel-border\),/
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
    tasks,
    /\.tasks-v2 \.t-row:focus-visible\s*\{[\s\S]*?box-shadow:\s*[^;}]*var\(--accent\)/
  );
});
