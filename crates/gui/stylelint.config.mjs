export default {
  plugins: [
    "./scripts/stylelint-no-color-literals.mjs",
    "./scripts/stylelint-no-font-size-literals.mjs",
  ],
  ignoreFiles: ["src/styles/tokens.css"],
  rules: {
    "vertebrae/no-color-literals": true,
    "vertebrae/no-font-size-literals": true,
  },
};
