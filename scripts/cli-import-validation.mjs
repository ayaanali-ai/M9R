import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";

/** Node ESM does not add extensions to relative imports. Check emitted static
 * imports/exports against their exact paths, independent of bundler fallback. */
export function validateCliRelativeImports(directory) {
  for (const name of readdirSync(directory).filter(value => value.endsWith(".js"))) {
    const path = resolve(directory, name);
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) continue;
      const target = resolve(dirname(path), specifier.text);
      const within = relative(resolve(directory), target);
      if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within) || !existsSync(target) || !statSync(target).isFile()) {
        throw new Error(`CLI module ${name} references missing relative import ${specifier.text}.`);
      }
    }
  }
}
