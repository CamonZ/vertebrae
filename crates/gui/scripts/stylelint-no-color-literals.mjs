import { ident, lexer, parse, walk } from "css-tree";
import stylelint from "stylelint";

const ruleName = "vertebrae/no-color-literals";
const messages = stylelint.utils.ruleMessages(ruleName, {
  rejected: (color) => `Move the color literal "${color}" to styles/tokens.css`,
});

const colorFunctions = new Set([
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "oklab",
  "oklch",
  "color",
  "device-cmyk",
]);

function isColorLiteral(node) {
  if (node.type === "Hash")
    return /^(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(
      ident.decode(node.value)
    );
  if (node.type !== "Identifier" && node.type !== "Function") return false;
  const name = ident.decode(node.name).toLowerCase();
  if (node.type === "Identifier")
    return !!lexer.matchType("named-color", name).matched;

  // Relative colors derive from another color. Inspect their arguments for
  // literals just as with color-mix(), light-dark(), gradients and fallbacks.
  const first = node.children.first;
  return (
    colorFunctions.has(name) &&
    !(
      first?.type === "Identifier" &&
      ident.decode(first.name).toLowerCase() === "from"
    )
  );
}

function rule(primary) {
  return (root, result) => {
    if (
      !stylelint.utils.validateOptions(result, ruleName, {
        actual: primary,
        possible: [true],
      })
    )
      return;

    root.walkDecls((declaration) => {
      const value = declaration.raws.value?.raw ?? declaration.value;
      walk(
        parse(value, {
          context: "value",
          positions: true,
          parseCustomProperty: true,
        }),
        {
          enter(node) {
            if (!isColorLiteral(node)) return;
            const start =
              declaration.prop.length + declaration.raws.between.length;
            const { start: literalStart, end: literalEnd } = node.loc;
            stylelint.utils.report({
              ruleName,
              result,
              node: declaration,
              message: messages.rejected(
                value.slice(literalStart.offset, literalEnd.offset)
              ),
              index: start + literalStart.offset,
              endIndex: start + literalEnd.offset,
            });
            return this.skip;
          },
        }
      );
    });
  };
}

export default stylelint.createPlugin(ruleName, rule);
