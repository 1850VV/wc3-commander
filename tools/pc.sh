#!/usr/bin/env bash
# Drive the commander bridge on the Windows game PC from a Mac/Linux machine over SSH.
#
#   tools/pc.sh status    code version, bridge process and its session, health
#   tools/pc.sh pull      git pull --ff-only in the PC's checkout
#   tools/pc.sh start     stop any bridge, start it on the PC's desktop (scheduled task), open the tunnel
#   tools/pc.sh stop      stop the bridge on the PC
#   tools/pc.sh tunnel    forward http://127.0.0.1:8790/ on this machine to the PC (not needed when the
#                         bridge was installed with -Lan and this machine is on the same network)
#   tools/pc.sh untunnel  close that forward
#   tools/pc.sh log [n]   last n lines (default 40) of bridge\run.log on the PC
#
# Needs: an SSH host alias (PC_HOST, default "pc") whose shell is PowerShell; the repository on the
# PC at PC_REPO (relative to the PC user's home, default Documents\ChatGPT\wc3-commander); and, for
# "start", the scheduled task from "tools\windows\bridge.ps1 install" run once on the PC.
set -euo pipefail

HOST_ALIAS=${PC_HOST:-pc}
REPO=${PC_REPO:-'Documents\ChatGPT\wc3-commander'}
PORT=8790
TASK=wc3-commander-bridge

remote() { ssh -o BatchMode=yes -o ConnectTimeout=8 "$HOST_ALIAS" "$1"; }
bridge() { remote "powershell -NoProfile -ExecutionPolicy Bypass -File \"$REPO\\tools\\windows\\bridge.ps1\" $1"; }
# the console's address on the PC's LAN, when the bridge listens there and this machine can reach it
lan_url() {
  local ip
  for ip in $(remote "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { \$_.IPAddress -like '192.168.*' -or \$_.IPAddress -like '10.*' } | ForEach-Object IPAddress" 2>/dev/null | tr -d '\r'); do
    if curl -s -m 2 "http://$ip:$PORT/api/health" >/dev/null; then echo "http://$ip:$PORT/"; return; fi
  done
}
tunnel_up() { lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; }

tunnel() {
  if tunnel_up; then echo "本机 $PORT 端口已在转发"; return; fi
  ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -fN -L "$PORT:127.0.0.1:$PORT" "$HOST_ALIAS"
  echo "已转发：http://127.0.0.1:$PORT/"
}

case "${1:-status}" in
  status) bridge status ;;
  pull) remote "git -C \"$REPO\" pull --ff-only" ;;
  stop) bridge stop ;;
  start)
    bridge stop
    sleep 2  # let the previous task run end so the task can start again
    remote "schtasks /Run /TN $TASK" >/dev/null
    echo "已请求在 PC 桌面上启动，等待服务就绪…"
    for _ in $(seq 1 30); do
      if remote "try { (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:$PORT/api/health -TimeoutSec 2).Content } catch { exit 1 }" >/dev/null 2>&1; then
        bridge status
        lan=""
        for _ in 1 2 3 4 5; do lan=$(lan_url); [ -n "$lan" ] && break; sleep 1; done  # LAN can lag localhost by a moment
        if [ -n "$lan" ]; then echo "直接打开：$lan（局域网，不用转发）"; else tunnel; fi
        exit 0
      fi
      sleep 1
    done
    echo "30 秒内服务没有响应，PC 上的日志：" >&2
    "$0" log 20 >&2 || true
    exit 1
    ;;
  tunnel) tunnel ;;
  untunnel) pkill -f "ssh .*-L $PORT:127.0.0.1:$PORT $HOST_ALIAS" && echo "已关闭转发" || echo "没有转发在运行" ;;
  log) remote "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Content -Encoding utf8 -Tail ${2:-40} \"$REPO\\bridge\\run.log\"" ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
