import * as cache from "@actions/cache";
import * as core from "@actions/core";
import { RefKey } from "../constants";

export function isExactKeyMatch(key: string, cacheKey?: string): boolean {
  return !!(
    cacheKey &&
    cacheKey.localeCompare(key, undefined, { sensitivity: "accent" }) === 0
  );
}

export function logWarning(message: string): void {
  const warningPrefix = "[warning]";
  core.info(`${warningPrefix}${message}`);
}

export function isValidEvent(): boolean {
  return RefKey in process.env && Boolean(process.env[RefKey]);
}

export function getInputAsArray(
  name: string,
  options?: core.InputOptions
): string[] {
  return core
    .getInput(name, options)
    .split("\n")
    .map((s) => s.replace(/^!\s+/, "!").trim())
    .filter((x) => x !== "");
}

export function getInputAsInt(
  name: string,
  options?: core.InputOptions
): number | undefined {
  const value = parseInt(core.getInput(name, options));
  if (isNaN(value) || value < 0) {
    return undefined;
  }
  return value;
}

export function getInputAsBool(
  name: string,
  options?: core.InputOptions
): boolean {
  const result = core.getInput(name, options);
  return result.toLowerCase() === "true";
}

export function isCacheFeatureAvailable(): boolean {
  if (cache.isFeatureAvailable()) {
    return true;
  }
  logWarning(
    "Cache feature is not available. Ensure ACTIONS_CACHE_URL is set or IR_CACHE_URL is configured."
  );
  return false;
}
