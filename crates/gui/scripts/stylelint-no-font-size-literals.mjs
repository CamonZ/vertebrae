import { ident, parse, walk } from "css-tree";
import stylelint from "stylelint";

// Font sizes come from the type scale in styles/tokens.css (--text-meta,
// --text-secondary, --text-content, --text-code and the heading sizes). A
// literal size here would ignore Settings → Text size and drift from the
// scale. Relative sizes (em, %) and keywords such as inherit stay allowed.
const ruleName = "vertebrae/no-font-size-literals";
const messages = stylelint.utils.ruleMessages(ruleName, {
  rejected: (size) =>
    `Use a type-scale token from styles/tokens.css instead of the font size "${size}"`,
});

const absoluteUnits = new Set(["px", "rem", "pt", "pc", "in", "cm", "mm", "q"]);
const absoluteSizeKeywords = new Set([
  "xx-small",
  "x-small",
  "small",
  "medium",
  "large",
  "x-large",
  "xx-large",
  "xxx-large",
]);

const isSizeProperty = (prop) =>
  prop === "font-size" || (prop.startsWith("--") && prop.endsWith("font-size"));

function isLiteralSize(node) {
  if (node.type === "Dimension")
    return absoluteUnits.has(node.unit.toLowerCase());
  return (
    node.type === "Identifier" &&
    absoluteSizeKeywords.has(ident.decode(node.name).toLowerCase())
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
      const prop = declaration.prop.toLowerCase();
      const shorthand = prop === "font";
      if (!shorthand && !isSizeProperty(prop)) return;

      const value = declaration.raws.value?.raw ?? declaration.value;
      walk(
        parse(value, {
          context: "value",
          positions: true,
          parseCustomProperty: true,
        }),
        {
          enter(node, item) {
            if (!isLiteralSize(node)) return;
            // In the font shorthand a length after "/" is the line height.
            const previous = item?.prev?.data;
            if (
              shorthand &&
              previous?.type === "Operator" &&
              previous.value === "/"
            )
              return;
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
          },
        }
      );
    });
  };
}

export default stylelint.createPlugin(ruleName, rule);
