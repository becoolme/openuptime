import { describe, expect, it } from "vitest";
import { customCssProblem, MAX_CUSTOM_CSS, stripCssComments } from "./status-css";

describe("status page stylesheets", () => {
  it("accepts ordinary rules", () => {
    expect(customCssProblem(':root { --accent: #2563eb } .pub-hd h1::after { content: "!" } @media (max-width: 600px) { .pub-kpis { display: none } }')).toBeNull();
  });
  it("refuses anything that loads a resource, runs or leaves the style element", () => {
    for (const css of [
      "body { background: url(https://x.example/p.gif) }",
      "body { background: URL ( 'x' ) }",
      '@import "https://x.example/a.css";',
      "@font-face { font-family: x }",
      'body { background: image-set("https://x.example/a.png" 1x) }',
      'body { background: -webkit-image-set("a.png" 1x) }',
      "a { background: src('x') }",
      "a { width: expression(alert(1)) }",
      "a { behavior: x }",
      "a { -moz-binding: x }",
      "</style><script>alert(1)</script>",
      "a { background: u\\72l(x) }",
      "a { color: red } }",
      "a { color: red",
    ]) expect(customCssProblem(css), css).not.toBeNull();
    expect(customCssProblem("a{}".repeat(MAX_CUSTOM_CSS))).toMatch(/longer/);
  });
  it("reads past comments, which cannot hide a function name", () => {
    expect(stripCssComments("a { color: red } /* note */ b {}")).toBe("a { color: red }  b {}");
    // joining the halves is stricter than CSS itself, and errs towards refusing
    expect(customCssProblem("a { background: ur/**/l(x) }")).not.toBeNull();
    expect(customCssProblem("a { background: /* x */ url(x) }")).not.toBeNull();
    expect(stripCssComments("a {} /* </style>")).toBe("a {} ");
  });
  it("checks the same text that is stored, even when stripping makes a new comment", () => {
    // one pass leaves `[x="/*"]`; a second pass would hide the url() behind it from the checks, but not from a browser
    const css = '[x="//**/*"]{} c{background:url(//e.example/x)}';
    expect(stripCssComments(css)).toBe('[x="/*"]{} c{background:url(//e.example/x)}');
    expect(customCssProblem(css)).toMatch(/comment/);
  });
});
