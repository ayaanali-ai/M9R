import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const validatorPath = join(process.cwd(), ".next", "dev", "types", "validator.ts");

try {
  const content = readFileSync(validatorPath, "utf8");
  const fixed = content.replace(/^ype __Unused = __Check$/gm, "type __Unused = __Check");
  if (content !== fixed) {
    writeFileSync(validatorPath, fixed, "utf8");
    console.log("Fixed Next.js 16.3.4 generated validator.ts syntax error (missing 't' in 'type')");
  }
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}