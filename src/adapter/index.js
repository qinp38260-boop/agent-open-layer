/** 跑完把 registry 注册好（CLI 与测试共用） */
import { register } from "./registry.js";
import { dshAdapter } from "./dsh/index.js";

export function bootstrap(options = {}) {
  register(dshAdapter(options));
  return true;
}

export { register, get, list, detectAny } from "./registry.js";
export { dshAdapter };
