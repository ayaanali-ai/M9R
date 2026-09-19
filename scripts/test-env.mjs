import { spawnSync } from "child_process";

console.log("Testing env var passing via spawnSync env option...");

const result = spawnSync("node", ["-e", "console.log(process.env.TEST_VAR)"], { 
  stdio: "inherit", 
  shell: true,
  env: { ...process.env, TEST_VAR: "hello" }
});

console.log("Exit code:", result.status);