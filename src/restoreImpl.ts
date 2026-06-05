import * as cache from "@actions/cache";
import * as core from "@actions/core";
import * as fs from "fs";
import { Inputs, Outputs, State } from "./constants";
import * as custom from "./custom/cache";
import { IStateProvider, NullStateProvider, StateProvider } from "./stateProvider";
import * as utils from "./utils/actionUtils";

function detectIRCache(): boolean {
  if (process.env.IR_CACHE_URL) return true;
  try {
    const url = fs.readFileSync("/etc/ir/cache-url", "utf-8").trim();
    return !!url;
  } catch {
    return false;
  }
}

const useIRCache = detectIRCache();

export async function restoreImpl(
  stateProvider: IStateProvider,
  earlyExit?: boolean
): Promise<string | undefined> {
  try {
    if (!useIRCache && !utils.isCacheFeatureAvailable()) {
      core.setOutput(Outputs.CacheHit, "false");
      return;
    }

    if (!utils.isValidEvent()) {
      utils.logWarning(
        `Event Validation Error: The event type ${process.env["GITHUB_EVENT_NAME"]} is not supported.`
      );
      return;
    }

    const primaryKey = core.getInput(Inputs.Key, { required: true });
    stateProvider.setState(State.CachePrimaryKey, primaryKey);

    const restoreKeys = utils.getInputAsArray(Inputs.RestoreKeys);
    const cachePaths = utils.getInputAsArray(Inputs.Path, { required: true });
    const enableCrossOsArchive = utils.getInputAsBool(Inputs.EnableCrossOsArchive);
    const failOnCacheMiss = utils.getInputAsBool(Inputs.FailOnCacheMiss);
    const lookupOnly = utils.getInputAsBool(Inputs.LookupOnly);

    let cacheKey: string | undefined;

    if (useIRCache) {
      core.info("Using IR cache (S3-backed, via control plane)");
      cacheKey = await custom.restoreCache(
        cachePaths, primaryKey, restoreKeys, { lookupOnly }, enableCrossOsArchive
      );
    } else {
      cacheKey = await cache.restoreCache(
        cachePaths, primaryKey, restoreKeys, { lookupOnly }, enableCrossOsArchive
      );
    }

    if (!cacheKey) {
      if (failOnCacheMiss) {
        throw new Error(`Failed to restore cache entry. Input key: ${primaryKey}`);
      }
      core.info(`Cache not found for keys: ${[primaryKey, ...restoreKeys].join(", ")}`);
      return;
    }

    stateProvider.setState(State.CacheMatchedKey, cacheKey);
    const isExactKeyMatch = utils.isExactKeyMatch(primaryKey, cacheKey);
    core.setOutput(Outputs.CacheHit, isExactKeyMatch.toString());

    if (lookupOnly) {
      core.info(`Cache found and can be restored from key: ${cacheKey}`);
    } else {
      core.info(`Cache restored from key: ${cacheKey}`);
    }

    return cacheKey;
  } catch (error: unknown) {
    core.setFailed((error as Error).message);
    if (earlyExit) {
      process.exit(1);
    }
  }
}

export async function restoreOnlyRun(earlyExit?: boolean): Promise<void> {
  await restoreImpl(new NullStateProvider(), earlyExit);
  if (earlyExit) {
    process.exit(0);
  }
}

export async function restoreRun(earlyExit?: boolean): Promise<void> {
  await restoreImpl(new StateProvider(), earlyExit);
  if (earlyExit) {
    process.exit(0);
  }
}
