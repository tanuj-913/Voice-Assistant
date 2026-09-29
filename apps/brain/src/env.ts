import { parseEnv, type Env } from '@assistant/schemas';

let cached: Env | null = null;

/** Parsed once; every later call reuses the validated result. */
export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
