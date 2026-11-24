// Cascade regression tests for the layered stylesheet split. #690 split index.css
// into layered stylesheets; when `.ovf-menu` landed in hearth.surfaces it
// overrode `.dd-menu` (hearth.components) and broke every Dropdown menu.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { element, loadCascade, resolveStyles } from "./css-cascade.mjs";

const cascade = loadCascade(fileURLToPath(new URL("../src/index.css", import.meta.url)));
const MENU_PROPS = ["position", "top", "right", "bottom", "left", "z-index", "min-width"];

const valuesOf = (el, props = MENU_PROPS) =>
  Object.fromEntries(
    Object.entries(resolveStyles(cascade, el, props)).map(([prop, { value }]) => [prop, value])
  );

const dropdownMenu = (attrs = {}, extraClasses = []) =>
  element({
    tag: "ul",
    classes: ["ovf-menu", "dd-menu", ...extraClasses],
    attrs: { role: "listbox", ...attrs },
    parent: element({ classes: ["ovf", "dd"] }),
  });

test("a Dropdown menu anchors to its trigger's left edge above surrounding surfaces", () => {
  assert.deepEqual(valuesOf(dropdownMenu()), {
    position: "absolute",
    top: "calc(100% + var(--s-1))",
    right: "auto",
    left: "0",
    "z-index": "80",
    "min-width": "max(100%, 10rem)",
  });
});

test("an upward Dropdown menu opens above its trigger instead of pinning both edges", () => {
  const values = valuesOf(dropdownMenu({ "data-up": "" }));
  assert.equal(values.top, "auto");
  assert.equal(values.bottom, "calc(100% + var(--s-1))");
  assert.equal(values.left, "0");
  assert.equal(values.right, "auto");
  assert.equal(values["z-index"], "80");
});

test("an end-aligned Dropdown menu anchors to its trigger's right edge", () => {
  const values = valuesOf(dropdownMenu({}, ["end"]));
  assert.equal(values.left, "auto");
  assert.equal(values.right, "0");
});

test("a plain overflow menu keeps the shared surface's right-aligned placement", () => {
  const overflowMenu = element({
    classes: ["ovf-menu"],
    attrs: { role: "menu" },
    parent: element({ classes: ["ovf"] }),
  });
  assert.deepEqual(valuesOf(overflowMenu), {
    position: "absolute",
    top: "calc(100% + var(--s-1))",
    right: "0",
    "z-index": "40",
    "min-width": "13rem",
  });
});

test("surface refinements of the shared menu still win over the component layer", () => {
  const tasksScopeMenu = element({
    classes: ["ovf-menu"],
    parent: element({
      classes: ["ovf"],
      parent: element({ classes: ["scope-secondary"], parent: element({ classes: ["tasks-v2"] }) }),
    }),
  });
  assert.equal(valuesOf(tasksScopeMenu)["z-index"], "80");

  const { rules } = cascade;
  const switcher = rules.find(
    (rule) => rule.selector === ".hc-panel .hc-tabs .ovf:has(.hc-tabs-switcher) .ovf-menu"
  );
  const shared = rules.find((rule) => rule.selector === ".ovf-menu");
  assert.equal(switcher.layer, "hearth.surfaces");
  assert.equal(shared.layer, "hearth.components");
});

test("the shared menu surface is defined once, ahead of the Dropdown refinements", () => {
  const owners = cascade.rules.filter((rule) =>
    [".ovf", ".ovf-menu", ".ovf-item", ".dd-menu"].includes(rule.selector)
  );
  assert.deepEqual(
    owners.map((rule) => [rule.selector, rule.layer, rule.file.split("/src/")[1]]),
    [
      [".ovf", "hearth.components", "styles/controls.css"],
      [".ovf-menu", "hearth.components", "styles/controls.css"],
      [".ovf-item", "hearth.components", "styles/controls.css"],
      [".dd-menu", "hearth.components", "styles/controls.css"],
    ]
  );
});

// The same split moved other shared-control bases into hearth.surfaces,
// where they overrode their own component-layer modifiers.
test("a disabled Toggle keeps the not-allowed cursor", () => {
  const toggle = element({ tag: "button", classes: ["app-toggle"], attrs: { role: "switch" }, pseudos: [":disabled"] });
  assert.equal(valuesOf(toggle, ["cursor"]).cursor, "not-allowed");
});

test("a coloured checked Toggle uses its active colour", () => {
  const toggle = element({
    tag: "button",
    classes: ["app-toggle"],
    attrs: { role: "switch", "aria-checked": "true", "data-active-color": "primary" },
  });
  assert.deepEqual(valuesOf(toggle, ["background", "border-color"]), {
    background: "color-mix(in oklch, var(--toggle-color) 22%, transparent)",
    "border-color": "var(--toggle-color)",
  });
});

test("the notifications bell brightens on hover and while open, unless unread", () => {
  const bell = (attrs = {}, pseudos = []) =>
    valuesOf(
      element({ tag: "button", classes: ["ctl", "ctl-quiet", "notifications-trigger"], attrs, pseudos }),
      ["color"]
    ).color;
  assert.equal(bell(), "var(--fg-mute)");
  assert.equal(bell({}, [":hover"]), "var(--fg)");
  assert.equal(bell({ "aria-expanded": "true" }), "var(--fg)");
  assert.equal(bell({ "data-unread": "" }, [":hover"]), "var(--fg-soft)");
});
