import { fileURLToPath } from "node:url";
import path from "node:path";

/** Package root, both from src/ (tsx) and dist/ (built). Holds events/example, policies/, templates/. */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}
