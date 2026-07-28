import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

function digestHeader(hash: crypto.Hash, kind: string, logicalPath: string): void {
  hash.update(JSON.stringify([kind, logicalPath.replaceAll(path.sep, "/")]));
  hash.update("\0");
}

async function hashPath(hash: crypto.Hash, absolutePath: string, logicalPath: string): Promise<void> {
  const stat = await fs.promises.lstat(absolutePath);
  if (stat.isSymbolicLink()) {
    digestHeader(hash, "symlink", logicalPath);
    hash.update(await fs.promises.readlink(absolutePath));
    hash.update("\0");
    return;
  }
  if (stat.isDirectory()) {
    digestHeader(hash, "directory", logicalPath);
    const entries = await fs.promises.readdir(absolutePath);
    entries.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const entry of entries) {
      await hashPath(hash, path.join(absolutePath, entry), path.posix.join(logicalPath, entry));
    }
    return;
  }
  if (stat.isFile()) {
    digestHeader(hash, "file", logicalPath);
    for await (const chunk of fs.createReadStream(absolutePath)) {
      hash.update(chunk);
    }
    hash.update("\0");
    return;
  }
  throw new Error(`Unsupported cache path type: ${absolutePath}`);
}

// Hashes normalized paths and contents while intentionally excluding timestamps,
// ownership, and permissions so equivalent cache trees produce the same digest.
export async function computeContentSHA256(cachePaths: string[]): Promise<string> {
  const hash = crypto.createHash("sha256");
  const roots = cachePaths.map((entry) => path.resolve(entry)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index];
    await hashPath(hash, root, `${index}`);
  }
  return hash.digest("hex");
}
