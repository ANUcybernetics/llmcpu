// Semantic CSS linting only; oxfmt owns formatting. Scoped <style> blocks in
// .astro components are not covered (no customSyntax parser wired up; plain-CSS
// sources under src/styles are the lintable surface).
export default {
  extends: ["stylelint-config-standard"],
  rules: {
    "no-descending-specificity": null,
    "custom-property-empty-line-before": null,
    "hue-degree-notation": null,
  },
};
