/**
 * Node loader hook that resolves extensionless relative imports ("./roots")
 * to ".ts" so the TypeScript sources run directly under Node's type stripping,
 * with no bundler and no tsx dependency.
 *
 * We deliberately return no `format` so Node applies its normal .ts handling
 * (type stripping) to the resolved file.
 */

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export async function resolve(specifier, context, nextResolve) {
  // "server-only" is a build-time marker Next.js resolves; it does not exist
  // as a real package at runtime. Map it to an empty module for the tests.
  if (specifier === "server-only") {
    return { url: "data:text/javascript,", shortCircuit: true };
  }

  const isRelative = specifier.startsWith(".") || specifier.startsWith("/");
  if (isRelative) {
    const base = context.parentURL ?? pathToFileURL(process.cwd() + "/").href;
    const resolved = new URL(specifier, base);
    if (!path.extname(resolved.pathname)) {
      for (const ext of [".ts", ".tsx", "/index.ts"]) {
        const candidate = new URL(resolved.href + ext);
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true };
        }
      }
    }
  }
  return nextResolve(specifier, context);
}
