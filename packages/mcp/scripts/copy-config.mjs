// Copies the shared files from the repo's config/ (and LICENSE) into this package,
// so `event_init` and the npm tarball have them. The copies are build output.
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(pkg, "..", "..");
mkdirSync(path.join(pkg, "config"), { recursive: true });
for (const f of ["event.example.yaml", "app-policy.yaml", "team-readme.template.md", ".env.example"]) {
  copyFileSync(path.join(repo, "config", f), path.join(pkg, "config", f));
}
copyFileSync(path.join(repo, "LICENSE"), path.join(pkg, "LICENSE"));
console.log("copied config/ and LICENSE into packages/mcp");
