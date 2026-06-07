import * as cache from "@actions/cache";
import * as core from "@actions/core";
import * as fs from "fs";
import { Inputs, State } from "./constants";
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

  // Render build metrics to job summary (if collector ran)
  renderMetricsSummary();

  if (earlyExit) {
    process.exit(0);
  }
}

function renderMetricsSummary(): void {
  const metricsFile = process.env.IR_METRICS_FILE || "/tmp/ir-metrics.jsonl";
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;

  if (!summaryFile || !fs.existsSync(metricsFile)) {
    return;
  }

  try {
    const lines = fs.readFileSync(metricsFile, "utf-8").trim().split("\n").filter(Boolean);
    if (lines.length < 2) return;

    const samples = lines.map((l) => JSON.parse(l));

    const cpuValues = samples.map((s: any) => s.cpu || 0);
    const memValues = samples.map((s: any) => s.mem_used_mb || 0);
    const memTotal = samples[0]?.mem_total_mb || 1;

    const cpuAvg = avg(cpuValues);
    const cpuPeak = Math.max(...cpuValues);
    const memAvg = avg(memValues);
    const memPeak = Math.max(...memValues);
    const duration = samples.length > 1
      ? samples[samples.length - 1].ts - samples[0].ts
      : 0;

    const cpuChart = sparkline(cpuValues, 0, 100);
    const memChart = sparkline(memValues, 0, memTotal);

    const summary = [
      "",
      "### 📊 IR Build Metrics",
      "",
      `| Metric | Chart | Avg | Peak |`,
      `|--------|-------|-----|------|`,
      `| CPU | \`${cpuChart}\` | ${cpuAvg.toFixed(0)}% | ${cpuPeak.toFixed(0)}% |`,
      `| Memory | \`${memChart}\` | ${formatMB(memAvg)} | ${formatMB(memPeak)} / ${formatMB(memTotal)} |`,
      "",
      `*Duration: ${duration}s | Samples: ${samples.length}*`,
      "",
    ].join("\n");

    fs.appendFileSync(summaryFile, summary);
    core.info("Build metrics rendered to job summary");
  } catch (err) {
    core.debug(`Failed to render metrics: ${err}`);
  }
}

function sparkline(values: number[], min: number, max: number): string {
  const blocks = " ▁▂▃▄▅▆▇█";
  const range = max - min || 1;
  // Downsample to max 20 points for readable chart
  const step = Math.max(1, Math.floor(values.length / 20));
  const sampled = values.filter((_, i) => i % step === 0);
  return sampled
    .map((v) => {
      const idx = Math.min(8, Math.floor(((v - min) / range) * 8));
      return blocks[idx];
    })
    .join("");
}

function avg(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / (values.length || 1);
}

function formatMB(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}GB`;
  return `${mb.toFixed(0)}MB`;
}
