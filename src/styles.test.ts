/**
 * EVERY CLASS THE COMPONENTS USE HAS A RULE. This repository has now shipped a class with no CSS
 * rule TWICE -- `search-field` on the model-filter box, and then `budget-line` and `kept-list` on
 * the budget counter and the kept-searches list, which are the ONLY route out of an over-budget
 * save. Both rendered as unstyled defaults in the middle of a styled panel and nothing failed:
 * `npm run check` compiles the stylesheet without ever asking whether a class in it exists, the
 * component tests query by role and text rather than by class, and there is no visual-regression
 * harness here to notice.
 *
 * So this is that check, and it is deliberately dumb: `import.meta.glob` discovers the components,
 * so a NEW component shipping an unruled class fails on the next run without anyone adding it to a
 * list. Both directions are covered -- a class whose only rule is renamed, and a component shipping
 * a class the stylesheet never mentions.
 *
 * WHAT IT DOES NOT COVER, stated so the claim is not wider than the measurement:
 *   - it asserts a SELECTOR EXISTS, never that the rule is right or that the result looks correct;
 *   - it skips the dynamic halves of template-literal names (`status-badge--${status}`) -- the
 *     static prefix is checked, the generated endings are not;
 *   - renaming ONE rule of a class that has several leaves the class styled by the others, and this
 *     test passes -- correctly, because the class is still styled. MEASURED both ways.
 */

const css = (import.meta.glob("./styles.css", { query: "?raw", import: "default", eager: true }) as
  Record<string, string>)["./styles.css"];

const components = import.meta.glob("./**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * The classes a file asks the stylesheet for. A `className` value can be a string, a ternary over
 * strings, or a template literal; in every form the STATIC text is what this extracts. A token
 * ending in `-` is a dynamic prefix (`status-badge--`) and is skipped.
 */
const classesIn = (source: string): string[] => {
  const classes: string[] = [];
  for (const match of source.matchAll(/className=(?:"([^"]*)"|\{([^}]*)\})/g)) {
    const literals =
      match[1] !== undefined
        ? [match[1]]
        : [...(match[2] ?? "").matchAll(/"([^"]*)"|`([^`]*)`/g)].map(
            (inner) => inner[1] ?? inner[2] ?? "",
          );
    for (const literal of literals) {
      for (const token of literal.split(/\s+/)) {
        if (token === "" || token.endsWith("-") || token.includes("$")) continue;
        classes.push(token);
      }
    }
  }
  return classes;
};

describe("the stylesheet and the components agree", () => {
  it("defines a rule for every class the components use", () => {
    const defined = new Set(
      [...css.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)].map((match) => match[1]),
    );

    const missing: string[] = [];
    let checked = 0;
    let files = 0;
    for (const [path, source] of Object.entries(components)) {
      if (path.endsWith(".test.tsx")) continue;
      files += 1;
      for (const className of classesIn(source)) {
        checked += 1;
        if (!defined.has(className)) missing.push(`${path} -> .${className}`);
      }
    }

    expect(missing).toEqual([]);
    // Anchored: an extractor that silently matched nothing, or a glob that found no components,
    // would satisfy the line above.
    expect(files).toBeGreaterThanOrEqual(7);
    expect(checked).toBeGreaterThan(60);
    expect(defined.has("budget-line")).toBe(true);
    expect(defined.has("kept-list")).toBe(true);
  });
});
