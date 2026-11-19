import { spawnSync } from "node:child_process";

for (const file of ["security.test.ts", "operations.test.ts", "transfers.test.ts", "server-info.test.ts", "pipeline.test.ts", "automation.test.ts"]) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--import", "./test/register.mjs", `test/${file}`], {
    stdio: "inherit", env: { ...process.env, ...(["pipeline.test.ts", "automation.test.ts"].includes(file) ? { VPM_TEST_FAKE_EXEC: "1" } : {}) },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
