#!/usr/bin/env bash
# L2 网络出口验收：按"主体（uid）"封锁出口，判据是外部不可达 + 蜜标服务端请求数
#
# 为什么必须在 Linux 上做：Windows 防火墙不支持按用户过滤出口，按主体断网要 WFP 驱动（管理员）；
# Linux 有 iptables owner match，可以精确到"这个账号不许出网，但回环和别的账号照常"。
#
# 需要 root（创建规则）；被测身份由 TEST_USER 指定。
set -u
WORK="${WORK:-/srv/agent-work}"
TEST_USER="${TEST_USER:-agent_runner}"
PORT="${PORT:-17891}"
TOKEN="${TOKEN:-oag-net-$(date +%s)}"
HONEY_DIR="${HONEY_DIR:-/tmp/honeypot}"
HONEY_LOG="$HONEY_DIR/access.log"

pass=0; fail=0
ok(){ echo "  PASS  $1"; pass=$((pass+1)); }
no(){ echo "  FAIL  $1"; fail=$((fail+1)); }

UID_TEST=$(id -u "$TEST_USER")
echo "=== 环境 ==="
echo "  test_user=$TEST_USER uid=$UID_TEST  honeypot=127.0.0.1:$PORT  token=$TOKEN"

mkdir -p "$HONEY_DIR"
echo "$TOKEN" > "$HONEY_DIR/$TOKEN.txt"
chmod -R a+rX "$HONEY_DIR"

# 起蜜标（服务端视角记录请求）
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$HONEY_DIR" > "$HONEY_LOG" 2>&1 &
HONEY_PID=$!
sleep 1.5
echo "  honeypot pid=$HONEY_PID"

as_user() { sudo -u "$TEST_USER" bash -c "$1"; }

# curl 的 -w 在连接失败时自己就输出 000；不要再用 || echo 000（会拼成 000000）
# 这里统一用代码判定：非 2xx/3xx 一律视为"不可达"
probe() { local url="$1" tmo="${2:-6}"; local code; code=$(as_user "curl -s -m $tmo -o /dev/null -w '%{http_code}' '$url' 2>/dev/null"); code="${code:-000}"; echo "$code"; }
unreachable() { case "$1" in 2??|3??) return 1;; *) return 0;; esac; }
reachable()   { case "$1" in 2??|3??) return 0;; *) return 1;; esac; }

echo ""
echo "=== 阶段 A：无出口规则（阴性对照 —— 必须能出网，否则探针是瞎的）==="
A_LOOP=$(probe "http://127.0.0.1:$PORT/$TOKEN.txt" 5)
A_IP=$(probe "http://1.1.1.1/" 8)
echo "  回环蜜标 HTTP=$A_LOOP   直连 1.1.1.1 HTTP=$A_IP"
if [ "$A_LOOP" = "200" ]; then ok "对照：回环可达（蜜标 200）"; else no "对照：回环不可达（$A_LOOP），探针无效"; fi
if reachable "$A_IP"; then ok "对照：能出网（1.1.1.1 → $A_IP）"; else no "对照：本来就出不去（$A_IP）→ 结论不可信"; fi

echo ""
echo "=== 阶段 B：只封该 uid 的非回环出口 ==="
sudo iptables -A OUTPUT -m owner --uid-owner "$UID_TEST" ! -d 127.0.0.1/32 -j REJECT
echo "  规则已下：OUTPUT owner uid=$UID_TEST ! daddr 127.0.0.1/32 → REJECT"
B_LOOP=$(probe "http://127.0.0.1:$PORT/$TOKEN.txt" 5)
B_IP=$(probe "http://1.1.1.1/" 6)
B_HTTPS=$(probe "https://example.com" 8)
echo "  回环蜜标 HTTP=$B_LOOP   1.1.1.1 HTTP=$B_IP   example.com HTTP=$B_HTTPS"
if [ "$B_LOOP" = "200" ]; then ok "封锁后回环仍可达（不是一刀切）"; else no "封锁后回环也不通了（$B_LOOP）"; fi
if unreachable "$B_IP"; then ok "直连 IP 被拒（出口真封了，code=$B_IP）"; else no "直连 IP 仍可达（$B_IP）"; fi
if unreachable "$B_HTTPS"; then ok "https 外网被拒（code=$B_HTTPS）"; else no "https 外网仍可达（$B_HTTPS）"; fi

echo ""
echo "=== 阶段 C：别的账号不受影响（规则按主体，不按机器）==="
C_ROOT=$(curl -s -m 8 -o /dev/null -w '%{http_code}' https://example.com 2>/dev/null); C_ROOT="${C_ROOT:-000}"
echo "  当前身份(root) example.com HTTP=$C_ROOT"
if reachable "$C_ROOT"; then ok "root 仍可出网（$C_ROOT，证明是按 uid 封，不是整机断网）"; else no "root 也出不去了（$C_ROOT）→ 规则过宽"; fi

echo ""
echo "=== 蜜标服务端视角（谁真的摸到过它）==="
HITS=$(grep -c "$TOKEN.txt" "$HONEY_LOG" 2>/dev/null || echo 0)
echo "  蜜标收到的 $TOKEN 请求数：$HITS（阶段 A 1 次 + 阶段 B 1 次 = 期望 2）"

echo ""
echo "=== 收尾：撤规则 ==="
sudo iptables -D OUTPUT -m owner --uid-owner "$UID_TEST" ! -d 127.0.0.1/32 -j REJECT 2>/dev/null || sudo iptables -F OUTPUT
kill "$HONEY_PID" 2>/dev/null
D_IP=$(probe "http://1.1.1.1/" 6)
echo "  撤规则后 1.1.1.1 HTTP=$D_IP"
if reachable "$D_IP"; then ok "撤规则后恢复出网（$D_IP，规则可逆）"; else no "撤规则后仍不通（$D_IP）"; fi

echo ""
echo "=== summary ==="
echo "  pass=$pass fail=$fail  honey_hits=$HITS"
[ "$fail" -eq 0 ] || exit 1
exit 0
