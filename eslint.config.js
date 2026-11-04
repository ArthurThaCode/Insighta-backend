const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  { ignores: ["node_modules/**", "coverage/**"] },
  js.configs.recommended,
  { files: ["**/*.js"], languageOptions: { sourceType: "commonjs", globals: globals.node } },
  { files: ["tests/*.test.js"], languageOptions: { sourceType: "module" } },
];
