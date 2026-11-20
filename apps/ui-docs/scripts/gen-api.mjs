#!/usr/bin/env node
// Reads packages/ui and writes src/generated/api.json, which the docs pages render. Nothing on those pages is typed by
// hand except the live demos in src/demos: exports, signatures, props and their comments come from the TypeScript
// checker, tokens from theme.css, classes from base.css. Runs before `dev`, `build`, `typecheck` and `test`.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "../../../packages/ui");
const OUT = resolve(HERE, "../src/generated/api.json");

export function generate(pkgDir = PKG) {
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const entries = Object.entries(manifest.exports).map(([sub, file]) => ({
    specifier: `${manifest.name}${sub.slice(1)}`,
    file: resolve(pkgDir, file),
  }));
  const code = entries.filter((e) => /\.tsx?$/.test(e.file));
  const css = entries.filter((e) => e.file.endsWith(".css"));

  return {
    package: manifest.name,
    readme: readFileSync(join(pkgDir, "README.md"), "utf8"),
    modules: readModules(code, pkgDir),
    tokens: css.filter((e) => /theme\.css$/.test(e.file)).flatMap((e) => readTokens(readFileSync(e.file, "utf8"))),
    styles: css.filter((e) => !/theme\.css$/.test(e.file)).map((e) => {
      const sections = readRules(readFileSync(e.file, "utf8"));
      return { specifier: e.specifier, sections, specimens: specimens(sections) };
    }),
  };
}

// ---- TypeScript ----

function readModules(entries, pkgDir) {
  const config = ts.getParsedCommandLineOfConfigFile(join(pkgDir, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  const program = ts.createProgram(entries.map((e) => e.file), config?.options ?? { jsx: ts.JsxEmit.ReactJSX, strict: true });
  const checker = program.getTypeChecker();
  const str = (t) => checker.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);
  const docs = (sym) => ts.displayPartsToString(sym?.getDocumentationComment(checker) ?? []).trim();

  return entries.map(({ specifier, file }) => {
    const source = program.getSourceFile(file);
    const moduleSym = checker.getSymbolAtLocation(source);
    const exports = (moduleSym ? checker.getExportsOfModule(moduleSym) : []).map((exp) => {
      const sym = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
      const decl = sym.declarations?.[0];
      const name = exp.name === "default" ? (sym.name !== "default" ? sym.name : decl?.name?.getText() ?? "default") : exp.name;
      const base = { name, isDefault: exp.name === "default", doc: docs(sym), line: decl ? source.getLineAndCharacterOfPosition(decl.getStart()).line + 1 : 0 };

      if (sym.flags & (ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Interface)) {
        const type = checker.getDeclaredTypeOfSymbol(sym);
        const text = decl && ts.isTypeAliasDeclaration(decl) ? decl.type.getText() : str(type);
        // members only for object shapes; a union or alias of a primitive would list the primitive's methods
        const shape = decl && (ts.isInterfaceDeclaration(decl) || (ts.isTypeAliasDeclaration(decl) && ts.isTypeLiteralNode(decl.type)));
        return { ...base, kind: "type", text, members: shape ? members(type, checker, str, docs) : [] };
      }
      const type = checker.getTypeOfSymbolAtLocation(sym, decl ?? source);
      const sigs = type.getCallSignatures();
      if (!sigs.length) return { ...base, kind: "const", text: str(type) };
      const sig = sigs[0];
      const returns = str(sig.getReturnType());
      const component = /^[A-Z]/.test(name) && /Element|ReactNode/.test(returns);
      const kind = component ? "component" : name.startsWith("use") ? "hook" : "function";
      const props = component && sig.parameters[0] ? propsOf(sig.parameters[0], decl, checker, str, docs) : [];
      const typeParams = decl?.typeParameters?.map((p) => p.getText()) ?? [];
      return { ...base, kind, signature: checker.signatureToString(sig, undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.WriteArrowStyleSignature), typeParams, returns, props };
    });
    return { specifier, file: relative(pkgDir, file), exports: exports.sort((a, b) => a.line - b.line) };
  });
}

/** Props of a component: its first parameter's properties, with the defaults from a destructuring pattern. */
function propsOf(param, decl, checker, str, docs) {
  const paramDecl = param.valueDeclaration;
  const defaults = new Map();
  if (paramDecl && ts.isParameter(paramDecl) && ts.isObjectBindingPattern(paramDecl.name)) {
    for (const el of paramDecl.name.elements) if (el.initializer) defaults.set((el.propertyName ?? el.name).getText(), el.initializer.getText());
  }
  const type = checker.getTypeOfSymbolAtLocation(param, paramDecl ?? decl);
  return members(type, checker, str, docs).map((m) => ({ ...m, default: defaults.get(m.name) ?? null }));
}

function members(type, checker, str, docs) {
  return checker.getPropertiesOfType(type).map((p) => {
    const d = p.valueDeclaration ?? p.declarations?.[0];
    const t = d && (ts.isPropertySignature(d) || ts.isPropertyDeclaration(d)) && d.type ? d.type.getText() : str(checker.getTypeOfSymbol(p));
    return { name: p.name, type: t.replace(/\s+/g, " "), optional: !!(p.flags & ts.SymbolFlags.Optional), doc: docs(p) };
  });
}

// ---- CSS ----

/** Strips comments but keeps their text, so a rule can be filed under the comment above it. */
function* cssRules(css) {
  let comment = null;
  const re = /\/\*([\s\S]*?)\*\/|@media([^{]*)\{|([^{}\s/][^{}]*)\{([^{}]*)\}|\}/g;
  const media = [];
  for (let m; (m = re.exec(css)); ) {
    if (m[1] !== undefined) comment = m[1].trim();
    else if (m[2] !== undefined) media.push(m[2].trim());
    else if (m[3] !== undefined) {
      yield { comment, media: media.at(-1) ?? null, selector: m[3].trim().replace(/\s+/g, " "), body: m[4].trim() };
      comment = null;
    } else media.pop();
  }
}

const decls = (body) =>
  [...body.matchAll(/([\w-]+)\s*:\s*((?:[^;"']|"[^"]*"|'[^']*')+)/g)].map((m) => [m[1], m[2].trim()]);

function readTokens(css) {
  const tokens = new Map();
  for (const r of cssRules(css)) {
    const dark = r.selector.includes("data-theme=dark") || (r.media?.includes("dark") ?? false);
    if (!r.selector.startsWith(":root")) continue;
    for (const [k, v] of decls(r.body)) {
      if (!k.startsWith("--")) continue;
      const t = tokens.get(k) ?? { name: k, light: null, dark: null };
      if (dark) t.dark ??= v;
      else t.light ??= v;
      tokens.set(k, t);
    }
  }
  const group = (n) => (/^--(sans|serif|mono)$/.test(n) ? "font" : /radius|shadow/.test(n) ? "shape" : "colour");
  return [...tokens.values()].map((t) => ({ ...t, group: group(t.name), derived: /var\(--/.test(t.light ?? "") }));
}

function readRules(css) {
  const sections = [];
  let cur = null;
  for (const r of cssRules(css)) {
    if (r.comment || !cur) {
      // the file's opening comment describes all of it, so the rules under it are the "base" section
      cur = { title: sections.length ? r.comment : "base", rules: [] };
      sections.push(cur);
    }
    if (r.selector.startsWith("@keyframes") || /^(from|to|\d+%)$/.test(r.selector)) continue;
    const classes = [...new Set([...r.selector.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]))];
    cur.rules.push({ selector: r.selector, media: r.media, classes, declarations: decls(r.body).map(([k, v]) => `${k}: ${v}`) });
  }
  return sections.filter((s) => s.rules.length);
}

/**
 * Class combinations worth showing on their own: every selector that is only classes (`.btn.primary`), grouped by its
 * first class. Selectors with descendants or states (`.dd-c .dd-btn`, `:hover`) are left to the component demos.
 */
function specimens(sections) {
  const groups = new Map();
  for (const s of sections) {
    for (const r of s.rules) {
      if (r.media) continue;
      for (const sel of r.selector.split(",").map((x) => x.trim())) {
        if (!/^(\.[a-zA-Z][\w-]*)+$/.test(sel)) continue;
        const [base, ...mods] = sel.slice(1).split(".");
        const g = groups.get(base) ?? { base, section: s.title, variants: [] };
        const v = [base, ...mods].join(" ");
        if (!g.variants.includes(v)) g.variants.push(v);
        groups.set(base, g);
      }
    }
  }
  return [...groups.values()];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const api = generate();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(api, null, 2) + "\n");
  const n = api.modules.reduce((s, m) => s + m.exports.length, 0);
  console.log(`ui-docs: ${api.modules.length} modules, ${n} exports, ${api.tokens.length} tokens → ${relative(process.cwd(), OUT)}`);
}
