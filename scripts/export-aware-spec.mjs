import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(process.argv[2] ?? join(root, "aware-spec"));
if (!output.startsWith(root + "\\") && !output.startsWith(root + "/")) throw new Error("AWARE output must stay inside the workspace.");

const apacheNotice = `AWARE protocol schemas and reference implementation\n\nCopyright 2026 Ayaan Ali\n\nLicensed under the Apache License, Version 2.0. You may obtain a copy of the License at:\nhttps://www.apache.org/licenses/LICENSE-2.0\n\nUnless required by applicable law or agreed to in writing, software distributed under the License is distributed on an AS IS BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.\n`;
const docsNotice = `AWARE protocol documentation\n\nCopyright 2026 Ayaan Ali\n\nLicensed under the Creative Commons Attribution 4.0 International License (CC BY 4.0):\nhttps://creativecommons.org/licenses/by/4.0/\n\nYou must give appropriate credit, provide a link to the license, and indicate if changes were made.\n`;
const readme = `# AWARE protocol

A standalone public specification package for the M9R web-coordination envelope. The JSON Schema in \`schema/aware-web-protocol-v0.schema.json\` is exported from the validated in-repo protocol package; the wire shape is unchanged by this export.

- Protocol schemas and reference code: Apache-2.0 (see \`LICENSE-APACHE\`).
- Human-readable specification and examples: CC BY 4.0 (see \`LICENSE-CC-BY-4.0\`).
- The schema currently retains the \`m9r-web/0\` protocol identifier so existing implementations remain conformant. A future AWARE wire identifier must be versioned explicitly rather than silently changing this file.

Implementation status: this is a protocol specification and an early reference implementation. The ledger enforces its schema, attribution, membership, quiet-until-invited, disclosure, and spend-cap rules only on paths that call the ledger; it is not currently wired to every M9R execution path. In particular, do not describe AWARE as governing every browser, shell, or file action until those paths are integrated.

This directory is a publication staging tree. It is intentionally separate from the BUSL-licensed application root, but it is not a hosted Git repository and this script does not create or push a remote.
`;

if (existsSync(output)) await rm(output, { recursive: true, force: true });
await mkdir(join(output, "schema"), { recursive: true });
await writeFile(join(output, ".gitignore"), "node_modules/\ndist/\n", "utf8");
await cp(join(root, "packages", "web-protocol-placeholder", "schema", "protocol.schema.json"), join(output, "schema", "aware-web-protocol-v0.schema.json"));
await writeFile(join(output, "LICENSE-APACHE"), apacheNotice, "utf8");
await writeFile(join(output, "LICENSE-CC-BY-4.0"), docsNotice, "utf8");
await writeFile(join(output, "README.md"), readme, "utf8");
await writeFile(join(output, "package.json"), JSON.stringify({ name: "@m9r/aware-spec", version: "0.1.0", private: false, description: "AWARE web coordination protocol schemas", license: "Apache-2.0", files: ["schema", "README.md", "LICENSE-APACHE", "LICENSE-CC-BY-4.0"] }, null, 2) + "\n", "utf8");
console.log(`Exported AWARE spec staging tree to ${output}`);
