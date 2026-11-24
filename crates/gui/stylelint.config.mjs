export default {
  plugins: ["./scripts/stylelint-no-color-literals.mjs"],
  ignoreFiles: ["src/styles/tokens.css"],
  rules: {
    "vertebrae/no-color-literals": true,
  },
};
