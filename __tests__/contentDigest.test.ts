import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { computeContentSHA256 } from "../src/custom/contentDigest";

describe("computeContentSHA256", () => {
  const tempDirectories: string[] = [];

  async function makeTree(): Promise<string> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ir-cache-digest-"));
    tempDirectories.push(root);
    await fs.promises.mkdir(path.join(root, "nested"));
    await fs.promises.writeFile(path.join(root, "alpha.txt"), "alpha");
    await fs.promises.writeFile(path.join(root, "nested", "beta.txt"), "beta");
    return root;
  }

  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map((directory) => fs.promises.rm(directory, { recursive: true, force: true })));
  });

  it("is stable when only timestamps and permissions change", async () => {
    const root = await makeTree();
    const before = await computeContentSHA256([root]);
    await fs.promises.chmod(path.join(root, "alpha.txt"), 0o600);
    await fs.promises.utimes(path.join(root, "alpha.txt"), new Date(1_000), new Date(2_000));
    expect(await computeContentSHA256([root])).toBe(before);
  });

  it("changes when file content changes", async () => {
    const root = await makeTree();
    const before = await computeContentSHA256([root]);
    await fs.promises.writeFile(path.join(root, "alpha.txt"), "modified");
    expect(await computeContentSHA256([root])).not.toBe(before);
  });

  it("is independent of directory enumeration order", async () => {
    const first = await makeTree();
    const second = await makeTree();
    expect(await computeContentSHA256([first])).toBe(await computeContentSHA256([second]));
  });
});
