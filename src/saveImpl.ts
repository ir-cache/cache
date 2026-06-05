import * as cache from "@actions/cache";
import * as core from "@actions/core";
import { Inputs, State } from "./constants";
import * as custom from "./custom/cache";
import { IStateProvider, NullStateProvider, StateProvider } from "./stateProvider";
import * as utils from "./utils/actionUtils";

const useIRCache = !!process.env.IR_CACHE_URL;

process.on("uncaughtException", (e) => utils.logWarning(e.message));

export async function saveImpl(
  stateProvider: IStateProvider
): Promise<number | void> {
  let cacheId = -1;
  try {
    if (!useIRCache && !utils.isCacheFeatureAvailable()) {
      return;
    }

    if (!utils.isValidEvent()) {
      utils.logWarning(
        `Event Validation Error: The event type ${process.env["GITHUB_EVENT_NAME"]} is not supported.`
      );
      return;
    }

    const primaryKey =
      stateProvider.getState(State.CachePrimaryKey) || core.getInput(Inputs.Key);

    if (!primaryKey) {
      utils.logWarning("Key is not specified.");
      return;
    }

    const restoredKey = stateProvider.getCacheState();
    if (utils.isExactKeyMatch(primaryKey, restoredKey)) {
      core.info(`Cache hit occurred on the primary key ${primaryKey}, not saving cache.`);
      return;
    }

    const cachePaths = utils.getInputAsArray(Inputs.Path, { required: true });
    const enableCrossOsArchive = utils.getInputAsBool(Inputs.EnableCrossOsArchive);

    if (useIRCache) {
      core.info("Using IR cache (S3-backed, via control plane)");
      cacheId = await custom.saveCache(
        cachePaths, primaryKey,
        { uploadChunkSize: utils.getInputAsInt(Inputs.UploadChunkSize) },
        enableCrossOsArchive
      );
    } else {
      cacheId = await cache.saveCache(
        cachePaths, primaryKey,
        { uploadChunkSize: utils.getInputAsInt(Inputs.UploadChunkSize) },
        enableCrossOsArchive
      );
    }

    if (cacheId !== -1) {
      core.info(`Cache saved with key: ${primaryKey}`);
    }
  } catch (error: unknown) {
    utils.logWarning((error as Error).message);
  }
  return cacheId;
}

export async function saveOnlyRun(earlyExit?: boolean): Promise<void> {
  try {
    const cacheId = await saveImpl(new NullStateProvider());
    if (cacheId === -1) {
      core.warning("Cache save failed.");
    }
  } catch (err) {
    console.error(err);
    if (earlyExit) {
      process.exit(1);
    }
  }
  if (earlyExit) {
    process.exit(0);
  }
}

export async function saveRun(earlyExit?: boolean): Promise<void> {
  try {
    await saveImpl(new StateProvider());
  } catch (err) {
    console.error(err);
    if (earlyExit) {
      process.exit(1);
    }
  }
  if (earlyExit) {
    process.exit(0);
  }
}
