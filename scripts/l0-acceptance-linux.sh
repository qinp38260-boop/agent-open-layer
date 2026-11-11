#!/usr/bin/env bash
# L0 主体隔离验收（在 GitHub runner 上以专用用户执行）
# 判据：金丝雀式文件操作 —— 该成的必须成，该拒的必须拒。不看"配置里写了什么"。
set -u
WORK="${WORK:-/srv/agent-work}"
GUARD="${GUARD:-/srv/gate/oag-guard.mjs}"
POLICY="${POLICY:-/srv/gate/policy.json}"
SECRET="${SECRET:-/srv/secret/app.env}"

pass=0; fail=0
ok()   { echo "  ALLOWED  $1"; pass=$((pass+1)); }
bad()  { echo "  BLOCKED  $1"; pass=$((pass+1)); }
oops() { echo "  !! $1"; fail=$((fail+1)); }

echo "=== identity ==="
echo "  whoami=$(whoami)  uid=$(id -u)"
echo ""

echo "=== 该允许的（工作目录内）==="
if echo ok > "$WORK/canary.txt" 2>/dev/null; then ok "write $WORK/canary.txt"; else oops "工作目录写不进去（隔离过度）"; fi
if cat "$WORK/canary.txt" >/dev/null 2>&1; then ok "read $WORK/canary.txt"; else oops "工作目录读不了"; fi
if mkdir -p "$WORK/sub/dir" 2>/dev/null; then ok "mkdir $WORK/sub/dir"; else oops "工作目录不能建子目录"; fi

echo ""
echo "=== 该拒绝的（敏感区）==="
if cat "$SECRET" >/dev/null 2>&1; then oops "读到了密钥文件 $SECRET ← 隔离失效"; else bad "read $SECRET"; fi
if echo x > /etc/oag-should-fail.txt 2>/dev/null; then oops "写进了 /etc ← 隔离失效"; rm -f /etc/oag-should-fail.txt; else bad "write /etc/oag-should-fail.txt"; fi
if ls "$HOME/.ssh" >/dev/null 2>&1; then oops "能列 ~/.ssh"; else bad "list ~/.ssh"; fi
if ls /root >/dev/null 2>&1; then oops "能列 /root ← 隔离失效"; else bad "list /root"; fi

echo ""
echo "=== 抗篡改（闸门与被监控目录）==="
if echo " " >> "$GUARD" 2>/dev/null; then oops "改写了闸门脚本 ← 抗篡改失效"; else bad "tamper $GUARD"; fi
if echo " " >> "$POLICY" 2>/dev/null; then oops "改写了策略文件 ← 抗篡改失效"; else bad "tamper $POLICY"; fi
if rm -f "$GUARD" 2>/dev/null; then oops "删掉了闸门脚本 ← 抗篡改失效"; else bad "delete $GUARD"; fi
if cp /bin/true "$GUARD" 2>/dev/null; then oops "覆盖了闸门脚本 ← 抗篡改失效"; else bad "overwrite $GUARD"; fi

echo ""
echo "=== 闸门本身能否以该身份运行（否则等于摆设）==="
if command -v node >/dev/null 2>&1; then
  OUT=$(echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","cwd":"'"$WORK"'","tool_input":{"command":"echo hi"}}' | node "$GUARD" 2>&1)
  if echo "$OUT" | grep -q '"decision"\|^{}'; then ok "run guard -> $(echo "$OUT" | head -c 70)"; else oops "闸门跑不起来：$(echo "$OUT" | head -c 120)"; fi
else
  oops "该用户没有 node"
fi

echo ""
echo "=== summary ==="
echo "  pass=$pass fail=$fail"
[ "$fail" -eq 0 ] || exit 1
exit 0
