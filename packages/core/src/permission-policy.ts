import type { PermissionConfig, PermissionProfile } from "./types.js";

export class PermissionPolicy {
  constructor(private readonly profiles: Record<string, PermissionConfig>) {}

  requireAllowed(profile: PermissionProfile): PermissionConfig {
    const config = this.profiles[profile];
    if (!config) {
      throw Object.assign(new Error(`Unknown permission profile ${profile}`), {
        statusCode: 400,
        code: "PERMISSION_UNKNOWN"
      });
    }
    if (profile === "dangerous-admin" || config.enabled === false) {
      throw Object.assign(new Error(`Permission profile ${profile} is disabled`), {
        statusCode: 403,
        code: "PERMISSION_DISABLED"
      });
    }
    return config;
  }

  canWrite(profile: PermissionProfile): boolean {
    return this.requireAllowed(profile).allow_write === true;
  }

  canRunShell(profile: PermissionProfile): boolean | "limited" {
    return this.requireAllowed(profile).allow_shell ?? false;
  }
}
