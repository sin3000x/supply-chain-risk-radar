#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

# Load optional .env overrides (ignored by git)
if [[ -f "$APP_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$APP_DIR/.env"
  set +a
fi

export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-4179}"
CLI_HOST=""
CLI_PORT=""

VAR_DIR="$APP_DIR/var"
SUPERVISOR_PID_FILE="$VAR_DIR/radar-supervisor.pid"
SERVER_PID_FILE="$VAR_DIR/radar-server.pid"
STATE_FILE="$VAR_DIR/radar.state"
LOG_FILE="$VAR_DIR/radar.log"
MAX_LOG_BYTES=$((10 * 1024 * 1024)) # 10 MB

mkdir -p "$VAR_DIR"

log_msg() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

read_pid() {
  local file="$1"
  if [[ -f "$file" ]]; then
    tr -d '[:space:]' < "$file"
  fi
}

pid_alive() {
  local pid="${1:-}"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

is_running() {
  local sup_pid srv_pid
  sup_pid="$(read_pid "$SUPERVISOR_PID_FILE")"
  srv_pid="$(read_pid "$SERVER_PID_FILE")"
  pid_alive "$sup_pid" || pid_alive "$srv_pid"
}

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "错误: 未找到 node，请先安装 Node.js >= 22.18.0" >&2
    exit 1
  fi
  local ver major minor
  ver="$(node -v | sed 's/^v//')"
  major="${ver%%.*}"
  minor="${ver#*.}"; minor="${minor%%.*}"
  if (( major < 22 || (major == 22 && minor < 18) )); then
    echo "错误: 当前 Node.js 版本为 v$ver，需要 >= 22.18.0" >&2
    exit 1
  fi
}

rotate_log_if_needed() {
  if [[ -f "$LOG_FILE" ]]; then
    local size
    size="$(wc -c < "$LOG_FILE" | tr -d '[:space:]')"
    if (( size > MAX_LOG_BYTES )); then
      mv -f "$LOG_FILE" "${LOG_FILE}.1"
    fi
  fi
}

health_check() {
  node -e "
    fetch('http://127.0.0.1:${PORT}/api/health', { signal: AbortSignal.timeout(2000) })
      .then(r => process.exit(r.ok ? 0 : 1))
      .catch(() => process.exit(1));
  " >/dev/null 2>&1
}

get_lan_ips() {
  if command -v ipconfig >/dev/null 2>&1; then
    # macOS
    local iface ip
    for iface in en0 en1 en2 en3; do
      ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
      if [[ -n "$ip" ]]; then
        echo "$ip"
      fi
    done
  elif command -v hostname >/dev/null 2>&1; then
    hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -v '^127\.' || true
  fi
}

print_urls() {
  echo "  本机访问:               http://127.0.0.1:${PORT}"
  if [[ "$HOST" == "0.0.0.0" || "$HOST" == "::" ]]; then
    local ips ip
    ips="$(get_lan_ips | sort -u)"
    if [[ -n "$ips" ]]; then
      while IFS= read -r ip; do
        echo "  内网访问:               http://${ip}:${PORT}"
      done <<< "$ips"
    else
      echo "  内网访问:               http://<本机内网IP>:${PORT}"
    fi
  else
    echo "  监听地址:               http://${HOST}:${PORT}"
  fi
}

_supervise() {
  echo "$$" > "$SUPERVISOR_PID_FILE"
  local stopping=0
  local child_pid=""
  local backoff=2

  cleanup_child() {
    stopping=1
    if pid_alive "$child_pid"; then
      log_msg "[supervisor] 收到停止信号，正在优雅关闭服务 (PID: $child_pid)..."
      kill -TERM "$child_pid" 2>/dev/null || true
      local waited=0
      while pid_alive "$child_pid" && (( waited < 10 )); do
        sleep 1
        waited=$((waited + 1))
      done
      if pid_alive "$child_pid"; then
        log_msg "[supervisor] 超时未退出，强制终止 (PID: $child_pid)"
        kill -KILL "$child_pid" 2>/dev/null || true
      fi
    fi
    rm -f "$SERVER_PID_FILE" "$SUPERVISOR_PID_FILE" "$STATE_FILE"
    log_msg "[supervisor] 服务已停止"
    exit 0
  }

  trap cleanup_child TERM INT
  trap '' HUP

  printf 'HOST=%q\nPORT=%q\n' "$HOST" "$PORT" > "$STATE_FILE"
  log_msg "[supervisor] 守护进程启动 (PID: $$, HOST=${HOST}, PORT=${PORT})"

  while true; do
    local start_ts end_ts elapsed exit_code
    start_ts="$(date +%s)"

    node --disable-warning=ExperimentalWarning "$APP_DIR/server.mjs" &
    child_pid=$!
    echo "$child_pid" > "$SERVER_PID_FILE"
    log_msg "[supervisor] Node 服务已启动 (PID: $child_pid)"

    set +e
    wait "$child_pid"
    exit_code=$?
    set -e

    rm -f "$SERVER_PID_FILE"
    child_pid=""

    if (( stopping == 1 )); then
      break
    fi

    end_ts="$(date +%s)"
    elapsed=$((end_ts - start_ts))
    if (( elapsed >= 60 )); then
      backoff=2
    fi

    log_msg "[supervisor] 服务异常退出 (exit=${exit_code}, 运行时长=${elapsed}s)，${backoff}s 后自动重启..."
    sleep "$backoff"
    if (( backoff < 30 )); then
      backoff=$((backoff * 2))
      if (( backoff > 30 )); then
        backoff=30
      fi
    fi
  done
}

port_in_use() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$PORT" 2>/dev/null | grep -q ":$PORT "
  else
    return 1
  fi
}

cmd_start() {
  check_node
  if is_running; then
    echo "供应链风险雷达已在运行中。"
    cmd_status
    return 0
  fi

  if port_in_use; then
    echo "错误: 端口 ${PORT} 已被其他进程占用，请先停止占用进程或通过 PORT 环境变量更换端口：" >&2
    if command -v lsof >/dev/null 2>&1; then
      lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true
    fi
    exit 1
  fi

  rm -f "$SUPERVISOR_PID_FILE" "$SERVER_PID_FILE"
  rotate_log_if_needed

  nohup "$0" _supervise >> "$LOG_FILE" 2>&1 < /dev/null &

  local waited=0
  while (( waited < 20 )); do
    if health_check; then
      echo "供应链风险雷达启动成功！"
      print_urls
      echo "  日志文件:               $LOG_FILE"
      return 0
    fi
    sleep 0.5
    waited=$((waited + 1))
  done

  if is_running; then
    echo "进程已启动，但健康检查尚未就绪，请查看日志: $LOG_FILE"
    print_urls
    return 0
  else
    echo "启动失败，最近日志如下：" >&2
    tail -n 30 "$LOG_FILE" >&2 || true
    exit 1
  fi
}

cmd_stop() {
  local sup_pid srv_pid
  sup_pid="$(read_pid "$SUPERVISOR_PID_FILE")"
  srv_pid="$(read_pid "$SERVER_PID_FILE")"

  if ! pid_alive "$sup_pid" && ! pid_alive "$srv_pid"; then
    rm -f "$SUPERVISOR_PID_FILE" "$SERVER_PID_FILE"
    echo "供应链风险雷达未在运行。"
    return 0
  fi

  echo "正在停止供应链风险雷达..."
  if pid_alive "$sup_pid"; then
    kill -TERM "$sup_pid" 2>/dev/null || true
  elif pid_alive "$srv_pid"; then
    kill -TERM "$srv_pid" 2>/dev/null || true
  fi

  local waited=0
  while (pid_alive "$sup_pid" || pid_alive "$srv_pid") && (( waited < 12 )); do
    sleep 1
    waited=$((waited + 1))
  done

  if pid_alive "$srv_pid"; then
    kill -KILL "$srv_pid" 2>/dev/null || true
  fi
  if pid_alive "$sup_pid"; then
    kill -KILL "$sup_pid" 2>/dev/null || true
  fi

  rm -f "$SUPERVISOR_PID_FILE" "$SERVER_PID_FILE" "$STATE_FILE"
  echo "供应链风险雷达已停止。"
}

cmd_restart() {
  cmd_stop
  cmd_start
}

cmd_rebuild() {
  check_node
  local was_running=0
  if is_running; then
    was_running=1
    if [[ -f "$STATE_FILE" ]]; then
      local state_host="" state_port=""
      # shellcheck disable=SC1090
      source "$STATE_FILE"
      state_host="${HOST:-}"
      state_port="${PORT:-}"
      [[ -n "$CLI_HOST" ]] || HOST="${state_host:-$HOST}"
      [[ -n "$CLI_PORT" ]] || PORT="${state_port:-$PORT}"
      export HOST PORT
    fi
    cmd_stop
  fi

  node --disable-warning=ExperimentalWarning "$APP_DIR/rebuild-events.mjs"

  if (( was_running == 1 )); then
    cmd_start
  else
    echo "事件库重建完成，可运行 $(basename "$0") start 启动服务。"
  fi
}

cmd_status() {
  local sup_pid srv_pid
  sup_pid="$(read_pid "$SUPERVISOR_PID_FILE")"
  srv_pid="$(read_pid "$SERVER_PID_FILE")"

  if pid_alive "$sup_pid" || pid_alive "$srv_pid"; then
    if [[ -f "$STATE_FILE" ]]; then
      local state_host="" state_port=""
      # shellcheck disable=SC1090
      source "$STATE_FILE"
      state_host="${HOST:-}"
      state_port="${PORT:-}"
      [[ -n "$CLI_HOST" ]] && HOST="$CLI_HOST" || HOST="${state_host:-$HOST}"
      [[ -n "$CLI_PORT" ]] && PORT="$CLI_PORT" || PORT="${state_port:-$PORT}"
    fi
    echo "状态: 运行中"
    echo "  守护进程 PID: ${sup_pid:-无}"
    echo "  Node服务 PID: ${srv_pid:-无}"
    if health_check; then
      echo "  健康检查:     正常 (http://127.0.0.1:${PORT}/api/health)"
    else
      echo "  健康检查:     未响应"
    fi
    print_urls
    echo "  日志文件:     $LOG_FILE"
  else
    echo "状态: 未运行"
    return 1
  fi
}

cmd_logs() {
  local lines="${1:-100}"
  if [[ ! -f "$LOG_FILE" ]]; then
    echo "暂无日志文件: $LOG_FILE"
    return 0
  fi
  tail -n "$lines" -f "$LOG_FILE"
}

usage() {
  cat <<EOF
用法: $(basename "$0") <命令> [选项]

命令:
  start       后台启动服务并开启崩溃自动重启守护 (默认监听 ${HOST}:${PORT})
  stop        优雅停止服务与守护进程
  restart     重启服务
  rebuild     备份并无损按当前规则重建 var/events.json（若在运行则自动停服后重启）
  status      查看运行状态、PID、健康检查与内网访问地址
  logs [N]    实时查看日志 (默认最近 100 行)

选项:
  --host, -H <IP>     指定监听 IP (默认 0.0.0.0，如 127.0.0.1 或内网网卡 IP)
  --port, -p <PORT>   指定监听端口 (默认 4179)

示例:
  $(basename "$0") start --port 8080
  $(basename "$0") start --host 192.168.1.100 --port 8080
  $(basename "$0") restart -p 4180

环境变量 (可在项目根目录 .env 中配置，命令行参数优先级更高):
  HOST        监听地址，默认 0.0.0.0 (允许内网访问)
  PORT        监听端口，默认 4179
EOF
}

POSITIONAL=()
while (( $# > 0 )); do
  case "$1" in
    --host|-H)
      [[ $# -ge 2 ]] || { echo "错误: $1 需要指定 IP 地址" >&2; exit 1; }
      CLI_HOST="$2"
      shift 2
      ;;
    --host=*)
      CLI_HOST="${1#*=}"
      shift
      ;;
    --port|-p)
      [[ $# -ge 2 ]] || { echo "错误: $1 需要指定端口号" >&2; exit 1; }
      CLI_PORT="$2"
      shift 2
      ;;
    --port=*)
      CLI_PORT="${1#*=}"
      shift
      ;;
    -h|--help|help)
      usage
      exit 0
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

if [[ -n "$CLI_HOST" ]]; then
  export HOST="$CLI_HOST"
fi
if [[ -n "$CLI_PORT" ]]; then
  if ! [[ "$CLI_PORT" =~ ^[0-9]+$ ]] || (( CLI_PORT < 1 || CLI_PORT > 65535 )); then
    echo "错误: 无效端口号 '$CLI_PORT' (需为 1-65535 之间的整数)" >&2
    exit 1
  fi
  export PORT="$CLI_PORT"
fi

CMD="${POSITIONAL[0]:-}"
ARG1="${POSITIONAL[1]:-}"

case "$CMD" in
  _supervise) _supervise ;;
  start)      cmd_start ;;
  stop)       cmd_stop ;;
  restart)    cmd_restart ;;
  rebuild)    cmd_rebuild ;;
  status)     cmd_status ;;
  logs)       cmd_logs "${ARG1:-100}" ;;
  "")         usage ;;
  *)
    echo "未知命令: $CMD" >&2
    usage >&2
    exit 1
    ;;
esac
