/** 跑完把 registry 注册好（CLI 与测试共用） */
import { register } from "./registry.js";
import { dshAdapter } from "./dsh/index.js";
import { codexAdapter } from "./codex/index.js";
import { claudeAdapter } from "./claude/index.js";

export function bootstrap(options = {}) {
  register(dshAdapter({ home: options.dshHome, profile: options.profile, cli: options.dshCli, auditHome: options.auditHome }));
  register(codexAdapter({ home: options.codexHome, cli: options.codexCli, auditHome: options.auditHome }));
  register(claudeAdapter({ home: options.claudeHome, configPath: options.claudeConfig, auditHome: options.auditHome }));
  return true;
}

export { register, get, list, detectAny, _reset } from "./registry.js";
export { dshAdapter, codexAdapter, claudeAdapter };
