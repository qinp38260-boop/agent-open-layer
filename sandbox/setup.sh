#!/usr/bin/env bash
# 容器内初始化：只装工具，不注入任何宿主凭据
set -euo pipefail
echo "[oag-sandbox] installing agent runtime"
npm i -g @openai/codex@0.167.0 >/dev/null 2>&1 || echo "  codex 安装失败（可离线）"
echo "[oag-sandbox] done. 注意：容器内没有宿主密钥，模型调用请通过宿主侧 broker 或临时令牌。"
