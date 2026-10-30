import type { McpDrift, McpToolSchema } from "@openuptime/repo";
type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const display = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 128);
const keyOf = (v: unknown): string => Array.isArray(v) ? `[${v.map(keyOf).join(",")}]` : object(v) ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${keyOf(v[k])}`).join(",")}}` : JSON.stringify(v) ?? "undefined";
const same = (a: unknown, b: unknown) => keyOf(a) === keyOf(b);
function schemaOrder(value: unknown, keyword = ""): string {
  if (Array.isArray(value)) {
    const values = value.map(v => schemaOrder(v));
    if (["allOf", "anyOf", "oneOf", "required", "type", "enum"].includes(keyword)) values.sort();
    return `[${values.join(",")}]`;
  }
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${schemaOrder(value[key], key)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

/** Compare complete discoveries, including keywords the drift classifier does not understand. Only arrays whose
 * order is defined to be irrelevant by JSON Schema are sorted; literal arrays in const/default/enum stay data. */
function canonicalSchema(value: unknown): string {
  if (!object(value)) return keyOf(value);
  const entries: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (key === "additionalProperties" && (child === true || object(child) && !Object.keys(child).length)) continue;
    if (key === "required" && Array.isArray(child) && !child.length) continue;
    let encoded: string;
    if (["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"].includes(key) && object(child)) encoded = `{${Object.keys(child).sort().map(name => `${JSON.stringify(name)}:${canonicalSchema(child[name])}`).join(",")}}`;
    else if (["allOf", "anyOf", "oneOf", "prefixItems"].includes(key) && Array.isArray(child)) {
      const branches = child.map(canonicalSchema);
      if (key !== "prefixItems") branches.sort();
      encoded = `[${branches.join(",")}]`;
    } else if (["items", "additionalProperties", "contains", "not", "if", "then", "else", "propertyNames", "unevaluatedProperties", "unevaluatedItems"].includes(key)) encoded = canonicalSchema(child);
    else if (["type", "required", "enum"].includes(key) && (Array.isArray(child) || key === "type" && typeof child === "string")) encoded = `[${(Array.isArray(child) ? child : [child]).map(keyOf).sort().join(",")}]`;
    else if (key === "dependentRequired" && object(child)) encoded = `{${Object.keys(child).sort().map(name => `${JSON.stringify(name)}:${Array.isArray(child[name]) ? `[${child[name].map(keyOf).sort().join(",")}]` : keyOf(child[name])}`).join(",")}}`;
    else encoded = keyOf(child);
    entries.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${entries.join(",")}}`;
}

export function mcpToolsEqual(left: McpToolSchema[], right: McpToolSchema[]): boolean {
  const canonical = (tools: McpToolSchema[]) => tools.map(tool => {
    const value = tool as unknown as Obj;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${key === "inputSchema" || key === "outputSchema" ? canonicalSchema(value[key]) : keyOf(value[key])}`).join(",")}}`;
  }).sort();
  return same(canonical(left), canonical(right));
}

/** Classifies contractual changes separately from metadata changes; no descriptions or enum values enter diagnostics. */
export function mcpSchemaDrift(baseline: McpToolSchema[], current: McpToolSchema[]): McpDrift[] {
  const drift: McpDrift[] = [];
  let toolName = "";
  const rank = { breaking: 0, warning: 1, info: 2 };
  const add = (severity: McpDrift["severity"], kind: string, path: string, reason: string) => {
    const change = { severity, kind, tool: toolName, path, message: `${path}: ${reason}`.slice(0, 300) };
    if (drift.length < 100) drift.push(change);
    else { const replace = drift.findIndex(item => rank[item.severity] > rank[severity]); if (replace >= 0) drift[replace] = change; }
  };
  const classify = (narrowed: boolean, output: boolean) => narrowed !== output ? "breaking" : "info";
  const types = (raw: unknown): string[] => Array.isArray(raw) ? [...new Set(raw.filter((v): v is string => typeof v === "string"))].sort() : typeof raw === "string" ? [raw] : ["array", "boolean", "integer", "null", "number", "object", "string"];
  const accepts = (list: string[], value: string) => list.includes(value) || value === "integer" && list.includes("number");
  const classified = new Set(["type", "$ref", "$dynamicRef", "$schema", "$id", "description", "title", "required", "dependentRequired", "enum", "const", "minimum", "exclusiveMinimum", "minLength", "minItems", "minContains", "minProperties", "maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxContains", "maxProperties", "multipleOf", "uniqueItems", "pattern", "format", "properties", "$defs", "definitions", "patternProperties", "dependentSchemas", "additionalProperties", "items", "contains", "not", "if", "then", "else", "propertyNames", "unevaluatedProperties", "unevaluatedItems", "allOf", "anyOf", "oneOf", "prefixItems"]);
  const visit = (before: unknown, after: unknown, path: string, depth: number, output: boolean) => {
    if (depth > 32 || same(before, after)) return;
    if (!object(before) || !object(after)) {
      if (before === false || after === true || object(after) && !Object.keys(after).length) add(classify(false, output), "constraint", path, "schema constraint relaxed");
      else add(classify(true, output), "constraint", path, "schema type changed");
      return;
    }
    const aTypes = types(before.type), bTypes = types(after.type);
    if (!same(aTypes, bTypes)) {
      const broken = output ? bTypes.some(v => !accepts(aTypes, v)) : aTypes.some(v => !accepts(bTypes, v));
      add(broken ? "breaking" : "info", "type", path, "type changed");
    }
    for (const keyword of ["$ref", "$dynamicRef", "$schema", "$id"]) if (!same(before[keyword], after[keyword])) add("warning", "schema-reference", path, "schema reference or dialect changed; review compatibility");
    for (const keyword of new Set([...Object.keys(before), ...Object.keys(after)])) if (!classified.has(keyword) && !same(before[keyword], after[keyword])) add("warning", "schema-keyword", path, `schema keyword ${display(keyword)} changed; review compatibility`);
    for (const keyword of ["description", "title"]) if (!same(before[keyword], after[keyword])) add("info", "description", path, "schema description changed");
    const requiredBefore = new Set(Array.isArray(before.required) ? before.required : []), requiredAfter = new Set(Array.isArray(after.required) ? after.required : []);
    for (const name of requiredAfter) if (!requiredBefore.has(name)) add(classify(true, output), "required", `${path}/${display(String(name))}`, "required parameter added");
    for (const name of requiredBefore) if (!requiredAfter.has(name)) add(classify(false, output), "required", `${path}/${display(String(name))}`, "required parameter removed");
    const beforeDependencies = object(before.dependentRequired) ? before.dependentRequired : {}, afterDependencies = object(after.dependentRequired) ? after.dependentRequired : {};
    for (const trigger of new Set([...Object.keys(beforeDependencies), ...Object.keys(afterDependencies)])) {
      const oldNames = new Set(Array.isArray(beforeDependencies[trigger]) ? beforeDependencies[trigger] : []), newNames = new Set(Array.isArray(afterDependencies[trigger]) ? afterDependencies[trigger] : []);
      for (const name of newNames) if (name !== trigger && !oldNames.has(name) && !requiredBefore.has(name)) add(classify(true, output), "required", `${path}/${display(String(name))}`, `required parameter added when ${display(trigger)} is present`);
      for (const name of oldNames) if (name !== trigger && !newNames.has(name) && !requiredAfter.has(name)) add(classify(false, output), "required", `${path}/${display(String(name))}`, `conditional requirement removed for ${display(trigger)}`);
    }
    if (!same(before.enum, after.enum)) {
      const oldValues = Array.isArray(before.enum) ? new Set(before.enum.map(keyOf)) : null, newValues = Array.isArray(after.enum) ? new Set(after.enum.map(keyOf)) : null;
      const breaking = output ? oldValues !== null && (newValues === null || [...newValues].some(v => !oldValues.has(v))) : newValues !== null && (oldValues === null || [...oldValues].some(v => !newValues.has(v)));
      // Array order is irrelevant, including when enum entries are objects with reordered keys.
      if (!oldValues || !newValues || oldValues.size !== newValues.size || [...oldValues].some(v => !newValues.has(v))) add(breaking ? "breaking" : "info", "enum", path, breaking ? "enum contract narrowed or invalidated" : "enum contract relaxed");
    }
    if (!same(before.const, after.const)) {
      const breaking = output ? own(before, "const") : own(after, "const");
      add(breaking ? "breaking" : "info", "const", path, "constant constraint changed");
    }
    for (const keyword of ["minimum", "exclusiveMinimum", "minLength", "minItems", "minContains", "minProperties", "maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxContains", "maxProperties"]) {
      const minimum = keyword.startsWith("min") || keyword === "exclusiveMinimum";
      const unbounded = minimum ? -Infinity : Infinity;
      const a = typeof before[keyword] === "number" ? before[keyword] as number : unbounded, b = typeof after[keyword] === "number" ? after[keyword] as number : unbounded;
      if (a !== b) add(classify(minimum ? b > a : b < a, output), "constraint", path, `${keyword} constraint changed`);
    }
    if (!same(before.multipleOf, after.multipleOf)) {
      const a = before.multipleOf, b = after.multipleOf;
      const narrow = a === undefined || typeof a === "number" && typeof b === "number" && Number.isInteger(b / a);
      const widen = b === undefined || typeof a === "number" && typeof b === "number" && Number.isInteger(a / b);
      add(narrow || widen ? classify(narrow, output) : "warning", "constraint", path, "multipleOf constraint changed");
    }
    if (Boolean(before.uniqueItems) !== Boolean(after.uniqueItems)) add(classify(after.uniqueItems === true, output), "constraint", path, "uniqueItems constraint changed");
    for (const keyword of ["pattern", "format"]) if (!same(before[keyword], after[keyword])) {
      // General regular-expression inclusion is not decidable here: changed expressions warrant review, not a false outage.
      const severity = before[keyword] === undefined ? classify(true, output) : after[keyword] === undefined ? classify(false, output) : "warning";
      add(severity, "constraint", path, `${keyword} constraint changed`);
    }
    for (const keyword of ["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"]) {
      const a = object(before[keyword]) ? before[keyword] as Obj : {}, b = object(after[keyword]) ? after[keyword] as Obj : {};
      for (const name of Object.keys(a)) {
        const child = `${path}/${display(name)}`;
        if (own(b, name)) visit(a[name], b[name], child, depth + 1, output);
        else if (keyword === "$defs" || keyword === "definitions") add("breaking", "schema-reference", child, "schema definition removed");
        else add(output || after.additionalProperties === false ? "breaking" : "info", "property", child, "parameter removed");
      }
      for (const name of Object.keys(b)) if (!own(a, name)) {
        const child = `${path}/${display(name)}`;
        if (keyword === "dependentSchemas") visit({}, b[name], child, depth + 1, output);
        else add("info", "property", child, "parameter or schema definition added");
      }
    }
    const additional = (value: unknown) => value === undefined || value === true || object(value) && !Object.keys(value).length ? true : value;
    const aAdditional = additional(before.additionalProperties), bAdditional = additional(after.additionalProperties);
    if (!same(aAdditional, bAdditional)) visit(aAdditional, bAdditional, `${path}/additionalProperties`, depth + 1, output);
    for (const keyword of ["items", "contains", "not", "if", "then", "else", "propertyNames", "unevaluatedProperties", "unevaluatedItems"]) {
      if (same(before[keyword], after[keyword])) continue;
      if (before[keyword] === undefined || after[keyword] === undefined) add(classify(after[keyword] !== undefined, output), "constraint", `${path}/${keyword}`, "schema constraint changed");
      else visit(before[keyword], after[keyword], `${path}/${keyword}`, depth + 1, output);
    }
    for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
      const a = before[keyword], b = after[keyword];
      if (a === undefined && b === undefined) continue;
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
        const removed = Array.isArray(a) ? a.filter(v => !Array.isArray(b) || !b.some(w => schemaOrder(v) === schemaOrder(w))).length : 0;
        const added = Array.isArray(b) ? b.filter(v => !Array.isArray(a) || !a.some(w => schemaOrder(v) === schemaOrder(w))).length : 0;
        const narrowed = keyword === "anyOf" ? removed > 0 : keyword === "allOf" ? added > 0 : null;
        add(narrowed === null ? "warning" : classify(narrowed, output), "composition", path, `${keyword} changed`);
        continue;
      }
      const sorted = (values: unknown[]) => values.map(value => ({ value, order: schemaOrder(value) })).sort((x, y) => x.order < y.order ? -1 : x.order > y.order ? 1 : 0).map(entry => entry.value);
      const aBranches = keyword === "prefixItems" ? a : sorted(a), bBranches = keyword === "prefixItems" ? b : sorted(b);
      aBranches.forEach((v, i) => visit(v, bBranches[i], `${path}/${keyword}/${i}`, depth + 1, output));
    }
  };
  const byName = new Map(current.map(tool => [tool.name, tool]));
  for (const tool of baseline) {
    toolName = tool.name;
    const now = byName.get(tool.name), path = display(tool.name);
    if (!now) { add("breaking", "tool-removed", path, "tool removed"); continue; }
    visit(tool.inputSchema, now.inputSchema, path, 0, false);
    if (tool.outputSchema && !now.outputSchema) add("breaking", "output-schema", `${path}/output`, "output schema contract removed");
    else if (!tool.outputSchema && now.outputSchema) add("info", "output-schema", `${path}/output`, "output schema contract added");
    else if (tool.outputSchema && now.outputSchema) visit(tool.outputSchema, now.outputSchema, `${path}/output`, 0, true);
    if (tool.description !== now.description) add("info", "description", path, "tool description changed");
    if (!same(tool.annotations, now.annotations)) add("warning", "annotations", path, "tool behavior annotations changed");
  }
  const oldNames = new Set(baseline.map(tool => tool.name));
  for (const tool of current) if (!oldNames.has(tool.name)) { toolName = tool.name; add("info", "tool-added", display(tool.name), "tool added"); }
  // A large number of metadata differences must never hide a later breaking change.
  return drift.sort((a, b) => ({ breaking: 0, warning: 1, info: 2 })[a.severity] - ({ breaking: 0, warning: 1, info: 2 })[b.severity]);
}

export const mcpSchemaChanges = (baseline: McpToolSchema[], current: McpToolSchema[]) => mcpSchemaDrift(baseline, current).filter(change => change.severity === "breaking").map(change => change.message);
