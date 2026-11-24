// Minimal cascade resolver for Hearth's stylesheets. It follows relative
// `@import`s from index.css, tracks cascade layers (`@import … layer(x)`,
// `@layer x { … }` and `@layer a, b;` order statements), and resolves which
// declaration wins for a described element. It covers what the cascade tests
// need — class, attribute, tag and id selectors, descendant/child combinators,
// `:not`/`:is`/`:where` — and matches any other pseudo-class or pseudo-element
// only when the described element lists it in `pseudos`. Rules inside conditional at-rules (@media, @supports,
// @container) are skipped. `!important` is not modeled.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { selectorSpecificity } from "@csstools/selector-specificity";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";

const IMPORT_RE = /^(?:url\()?["']([^"']+)["']\)?(?:\s+layer\(([^)]+)\))?\s*$/;
const SHORTHANDS = {
  inset: ["top", "right", "bottom", "left"],
};

/** Parses `entry` and its relative imports into a flat, ordered rule list. */
export function loadCascade(entry, { readFile = (path) => readFileSync(path, "utf8") } = {}) {
  const layerOrder = new Map(); // full layer name -> first-seen index among siblings
  const siblingCounts = new Map(); // parent layer name -> count
  const rules = [];

  const registerLayer = (fullName) => {
    const parts = fullName.split(".");
    for (let i = 1; i <= parts.length; i += 1) {
      const name = parts.slice(0, i).join(".");
      if (layerOrder.has(name)) continue;
      const parent = parts.slice(0, i - 1).join(".");
      const count = siblingCounts.get(parent) ?? 0;
      layerOrder.set(name, count);
      siblingCounts.set(parent, count + 1);
    }
  };
  const joinLayer = (parent, name) => (parent ? `${parent}.${name}` : name);

  const walk = (container, file, layer, conditional) => {
    container.each((node) => {
      if (node.type === "atrule") {
        const name = node.name.toLowerCase();
        if (name === "import") {
          const match = node.params.match(IMPORT_RE);
          if (!match || !match[1].startsWith(".")) return;
          const child = resolve(dirname(file), match[1]);
          const childLayer = match[2] ? joinLayer(layer, match[2].trim()) : layer;
          if (match[2]) registerLayer(childLayer);
          walk(postcss.parse(readFile(child), { from: child }), child, childLayer, conditional);
          return;
        }
        if (name === "layer") {
          const names = node.params.split(",").map((part) => part.trim()).filter(Boolean);
          if (!node.nodes) {
            for (const layerName of names) registerLayer(joinLayer(layer, layerName));
            return;
          }
          const blockLayer = joinLayer(layer, names[0] ?? `anonymous-${rules.length}`);
          registerLayer(blockLayer);
          walk(node, file, blockLayer, conditional);
          return;
        }
        if (node.nodes) walk(node, file, layer, true);
        return;
      }
      if (node.type !== "rule") return;
      const declarations = [];
      node.each((child) => {
        if (child.type !== "decl") return;
        const prop = child.prop.toLowerCase();
        for (const longhand of SHORTHANDS[prop] ?? [prop]) {
          declarations.push({ prop: longhand, value: child.value, important: child.important });
        }
      });
      for (const selector of splitSelectors(node.selector)) {
        rules.push({
          selector,
          ast: selectorParser().astSync(selector).first,
          specificity: specificityOf(selector),
          declarations,
          layer,
          conditional,
          file,
          line: node.source?.start?.line ?? 0,
          order: rules.length,
        });
      }
    });
  };

  walk(postcss.parse(readFile(entry), { from: entry }), entry, null, false);

  const layerRank = (layer) => {
    if (layer === null) return [Number.POSITIVE_INFINITY];
    const parts = layer.split(".");
    return parts.map((_, index) => layerOrder.get(parts.slice(0, index + 1).join(".")));
  };
  for (const rule of rules) rule.layerRank = layerRank(rule.layer);
  return { rules, layerRank };
}

function splitSelectors(selectorList) {
  const selectors = [];
  selectorParser((root) => {
    root.each((selector) => selectors.push(selector.toString().trim()));
  }).processSync(selectorList);
  return selectors;
}

function specificityOf(selector) {
  const { a, b, c } = selectorSpecificity(selectorParser().astSync(selector).first);
  return [a, b, c];
}

/** Compares two rules in cascade order: negative when `left` loses. */
export function compareCascade(left, right) {
  const rank = compareArrays(left.layerRank, right.layerRank);
  if (rank !== 0) return rank;
  const specificity = compareArrays(left.specificity, right.specificity);
  if (specificity !== 0) return specificity;
  return left.order - right.order;
}

function compareArrays(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    // A rule placed directly in a parent layer beats its sublayers, so a
    // shorter rank (no further segment) sorts after a longer one.
    const a = left[index] ?? Number.POSITIVE_INFINITY;
    const b = right[index] ?? Number.POSITIVE_INFINITY;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * Describes an element for matching: `{ tag?, classes?, attrs?, parent? }`.
 * `attrs` maps attribute names to string values (`""` for boolean attributes);
 * `pseudos` lists the pseudo-classes (`":hover"`) the element is in.
 */
export function element({ tag = "div", classes = [], attrs = {}, pseudos = [], parent = null } = {}) {
  return { tag, classes: new Set(classes), attrs, pseudos: new Set(pseudos), parent };
}

/** Returns whether `ast` (a postcss-selector-parser selector) matches `el`. */
export function matchesSelector(ast, el) {
  const compounds = [];
  let current = [];
  let combinators = [];
  for (const node of ast.nodes) {
    if (node.type === "combinator") {
      compounds.push(current);
      combinators.push(node.value.trim() || " ");
      current = [];
    } else if (node.type !== "comment") {
      current.push(node);
    }
  }
  compounds.push(current);
  return matchFrom(compounds, combinators, compounds.length - 1, el);
}

function matchFrom(compounds, combinators, index, el) {
  if (!el || !matchesCompound(compounds[index], el)) return false;
  if (index === 0) return true;
  const combinator = combinators[index - 1];
  if (combinator === ">") return matchFrom(compounds, combinators, index - 1, el.parent);
  if (combinator === " ") {
    for (let ancestor = el.parent; ancestor; ancestor = ancestor.parent) {
      if (matchFrom(compounds, combinators, index - 1, ancestor)) return true;
    }
    return false;
  }
  return false; // sibling combinators are not modeled
}

function matchesCompound(nodes, el) {
  return nodes.every((node) => {
    switch (node.type) {
      case "universal":
      case "nesting":
        return true;
      case "tag":
        return node.value.toLowerCase() === el.tag;
      case "class":
        return el.classes.has(node.value);
      case "id":
        return el.attrs.id === node.value;
      case "attribute": {
        if (!(node.attribute in el.attrs)) return false;
        if (!node.operator) return true;
        const actual = el.attrs[node.attribute];
        const expected = node.value;
        if (node.operator === "=") return actual === expected;
        if (node.operator === "~=") return actual.split(/\s+/).includes(expected);
        return false;
      }
      case "pseudo": {
        const name = node.value.toLowerCase();
        if (name === ":not") return node.nodes.every((inner) => !matchesSelector(inner, el));
        if (name === ":is" || name === ":where") return node.nodes.some((inner) => matchesSelector(inner, el));
        return el.pseudos?.has(name) ?? false;
      }
      default:
        return false;
    }
  });
}

/** Resolves the winning declaration for each of `props` on `el`. */
export function resolveStyles(cascade, el, props) {
  const winners = {};
  for (const rule of cascade.rules) {
    if (rule.conditional || !matchesSelector(rule.ast, el)) continue;
    for (const declaration of rule.declarations) {
      if (!props.includes(declaration.prop)) continue;
      const previous = winners[declaration.prop];
      if (!previous || compareCascade(previous.rule, rule) <= 0) {
        winners[declaration.prop] = { value: declaration.value, rule };
      }
    }
  }
  return winners;
}
