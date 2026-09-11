// Module resolve hook: maps the project's "@/..." path alias to ./src/... and
// appends a .ts extension when none is given, so Node (with its built-in
// TypeScript type-stripping) can run scripts that reuse the app's libs without
// any extra dependency. Used only by the local import:recorded CLI.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath, extname } from "node:path";
import { existsSync } from "node:fs";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    let full = resolvePath(process.cwd(), "src", specifier.slice(2));
    if (!extname(full)) full += ".ts";
    return nextResolve(pathToFileURL(full).href, context);
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !extname(specifier) && context.parentURL?.startsWith("file:")) {
    const full = resolvePath(dirname(fileURLToPath(context.parentURL)), `${specifier}.ts`);
    if (existsSync(full)) return nextResolve(pathToFileURL(full).href, context);
  }
  return nextResolve(specifier, context);
}
