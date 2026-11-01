import { join } from "node:path";

/** Test-only global preference location; never falls through to inherited Pi settings overrides. */
export function isolatedSettingsFile(agentDir: string): string {
  return join(agentDir, "settings.json");
}
