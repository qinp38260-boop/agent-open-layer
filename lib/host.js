/** 定位 DSH 宿主：home / profile 目录 / 版本。只读。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function dshHome(explicit) {
  const env = String(process.env.DSH_HOME || "").trim();
  if (explicit) return explicit;
  if (env) return env;
  return path.join(os.homedir(), ".dsh");
}

export function profilesDir(home) {
  return path.join(home, "profiles");
}

export function profileDir(home, profile = "web") {
  return path.join(profilesDir(home), profile);
}

export function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** 版本探测：优先 @deepseek-ai/dsh，其次任意 @deepseek-ai/*；都读 package.json。 */
export function hostVersion(home) {
  const bases = [
    path.join(profilesDir(home), "node_modules", "@deepseek-ai"),
    path.join(profilesDir(home), "node_modules"),
    path.join(home, "node_modules", "@deepseek-ai"),
  ];
  for (const base of bases) {
    const pkg = readJson(path.join(base, "dsh", "package.json"));
    if (pkg?.version) return { version: pkg.version, base, from: "dsh" };
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base)) {
      const v = readJson(path.join(base, name, "package.json"))?.version;
      if (v) return { version: v, base, from: name };
    }
  }
  return { version: "unknown", base: null, from: null };
}

/** profile 的补丁层文件（我们唯一会写的文件）。 */
export function patchFile(home, profile = "web") {
  return path.join(profileDir(home, profile), "cordis.patch.yml");
}
