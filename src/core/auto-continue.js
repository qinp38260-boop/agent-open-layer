/**
 * AUTO_CONTINUE（自动续跑）—— wrapper 层实现，不改宿主。
 *
 * 为什么是 wrapper：实测 Codex **没有**"自动继续"的配置键（`--ask-for-approval` 只管审批）；
 * 官方能力是 `codex exec resume <SESSION_ID> <PROMPT>`，所以续跑只能在**外面驱动**。
 *
 * 安全护栏（写成硬约束，不是建议）：
 *   - maxContinues 默认 1，硬上限 10（策略校验里也拦）
 *   - 每轮都写审计（轮次/原因/上一步摘要）
 *   - shouldContinue 由调用方给判定；默认只认"未出现完成标记"
 *   - runner 抛错 → 立即停，绝不吞掉错误继续续跑
 */
import { AdapterError, ErrorCode } from "../adapter/types.js";
import { logAudit } from "./audit.js";

export const HARD_MAX_CONTINUES = 10;
const DONE_MARKERS = [/^\s*done\b/i, /\bDONE\b/, /✅/, /任务完成/, /all done/i];

export function defaultShouldContinue({ text, round, maxContinues }) {
  // round 为 0 基索引：已经续跑 round 次；达到上限就停（总轮数 = 1 + maxContinues）
  if (round >= maxContinues) return false;
  const t = String(text ?? "").trim();
  if (!t) return false; // 空回复不续跑（避免空转）
  return !DONE_MARKERS.some((re) => re.test(t));
}

/**
 * @param {{ runner: Function, prompt: string, maxContinues?: number, continuePrompt?: string,
 *           shouldContinue?: Function, home?: string, label?: string }} opts
 * runner({ prompt, sessionId, round }) → { text, sessionId?, raw? }
 */
export async function runWithContinue(opts) {
  const maxContinues = Math.max(0, Math.min(opts.maxContinues ?? 1, HARD_MAX_CONTINUES));
  if (typeof opts.runner !== "function") throw new AdapterError(ErrorCode.CAPABILITY_MISSING, "runWithContinue 需要 runner");
  const shouldContinue = opts.shouldContinue ?? defaultShouldContinue;
  const continuePrompt = opts.continuePrompt ?? "Continue from where you stopped. Reply done when finished.";
  const label = opts.label ?? "auto-continue";

  const rounds = [];
  let sessionId;
  let prompt = opts.prompt;

  for (let round = 0; round <= maxContinues; round += 1) {
    let r;
    try {
      r = await opts.runner({ prompt, sessionId, round });
    } catch (e) {
      logAudit(opts.home, `${label}-abort`, { round, error: String(e.message ?? e).slice(0, 200) });
      throw new AdapterError(ErrorCode.WRITE_FAILED, `第 ${round + 1} 轮执行失败，已停止（不自动重试）：${e.message}`);
    }
    sessionId = r?.sessionId ?? sessionId;
    const text = String(r?.text ?? "");
    rounds.push({ round: round + 1, text: text.slice(0, 400) });
    const go = shouldContinue({ text, round, maxContinues, sessionId }); // 0 基
    logAudit(opts.home, `${label}-round`, { round: round + 1, continued: Boolean(go), sessionId, text: text.slice(0, 200) });
    if (!go) break;
    if (round === maxContinues) break;
    prompt = continuePrompt;
  }

  return { rounds, sessionId, continues: Math.max(0, rounds.length - 1), text: rounds.at(-1)?.text ?? "" };
}
