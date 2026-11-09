import { fileURLToPath } from "node:url";
import path from "node:path";

/** Package root, both from src/ (tsx) and dist/ (built). Holds config/ (copied from the repo's config/ at build). */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}
