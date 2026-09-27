# shellcheck shell=bash
# shellcheck disable=SC2034  # the variables set here are used by the scripts that source this file
#
# Settings and helpers shared by install.sh, link-device.sh, start.sh and stop.sh.
# Sourced, never run directly. Works with bash 3.2 (the macOS default) and newer.
#
# Files:
#   config    ${XDG_CONFIG_HOME:-~/.config}/signal-automator/config.env  (SIGNAL_AUTOMATOR_CONFIG overrides)
#   signal-cli installed by install.sh: ${XDG_DATA_HOME:-~/.local/share}/signal-automator/signal-cli/
#   logs, PIDs ${XDG_STATE_HOME:-~/.local/state}/signal-automator/

AUTOMATOR_DIR=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)

CONFIG_FILE=${SIGNAL_AUTOMATOR_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/signal-automator/config.env}
DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}/signal-automator
STATE_DIR=${XDG_STATE_HOME:-$HOME/.local/state}/signal-automator
DAEMON_PID_FILE=$STATE_DIR/daemon.pid
SERVER_PID_FILE=$STATE_DIR/server.pid
DAEMON_LOG=$STATE_DIR/daemon.log
SERVER_LOG=$STATE_DIR/server.log
# Text that the command lines of the processes started by start.sh contain.
SERVER_MATCH=server/dist/index.js
DAEMON_MATCH=daemon

DEFAULT_PORT=7583
DEFAULT_SIGNAL_CLI_URL=http://127.0.0.1:7584
DEFAULT_DEVICE_NAME='Signal Automator'
DEFAULT_DAEMON_ARGS='--ignore-attachments --ignore-stories'
MIN_NODE=20
MIN_JAVA=21

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_BOLD=$'\033[1m' C_DIM=$'\033[2m' C_GREEN=$'\033[32m' C_RESET=$'\033[0m'
else
  C_BOLD='' C_DIM='' C_GREEN='' C_RESET=''
fi
if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
  C_ERR=$'\033[31m' C_WARN=$'\033[33m' C_ERESET=$'\033[0m'
else
  C_ERR='' C_WARN='' C_ERESET=''
fi

say() { printf '%s\n' "$*"; }
step() { printf '%s==>%s %s\n' "$C_BOLD" "$C_RESET" "$*"; }
ok() { printf '%s%s%s\n' "$C_GREEN" "$*" "$C_RESET"; }
warn() { printf '%swarning:%s %s\n' "$C_WARN" "$C_ERESET" "$*" >&2; }
die() {
  printf '%serror:%s %s\n' "$C_ERR" "$C_ERESET" "$*" >&2
  exit 1
}
have() { command -v -- "$1" >/dev/null 2>&1; }
is_macos() { [ "$(uname -s)" = Darwin ]; }

# Shows a path with $HOME abbreviated to ~.
# shellcheck disable=SC2088  # a literal ~, for display
pretty_path() {
  case $1 in
    "$HOME"/*) printf '~/%s\n' "${1#"$HOME"/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

# ---------------------------------------------------------------- config file

# Exports the KEY=value lines of the config file. Blank lines and lines starting
# with # are skipped, one pair of surrounding quotes is removed, and nothing is
# evaluated. Only AUTOMATOR_*, SIGNAL_* and JAVA_HOME are accepted. A variable
# that is already set in the environment wins over the file.
config_load() {
  [ -f "$CONFIG_FILE" ] || return 0
  local line key value shown
  shown=$(pretty_path "$CONFIG_FILE")
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    line=${line#"${line%%[![:space:]]*}"}
    case $line in '' | '#'*) continue ;; esac
    case $line in 'export '*) line=${line#export } ;; esac
    case $line in
      *=*) ;;
      *)
        warn "$shown: ignoring a line without '=': $line"
        continue
        ;;
    esac
    key=${line%%=*}
    key=${key%"${key##*[![:space:]]}"}
    value=${line#*=}
    value=${value#"${value%%[![:space:]]*}"}
    value=${value%"${value##*[![:space:]]}"}
    case $value in
      \"*\" | \'*\')
        value=${value#?}
        value=${value%?}
        ;;
    esac
    case $key in
      '' | *[!A-Za-z0-9_]*) key='' ;;
      AUTOMATOR_* | SIGNAL_* | JAVA_HOME) ;;
      *) key='' ;;
    esac
    if [ -z "$key" ]; then
      warn "$shown: ignoring unknown setting: ${line%%=*}"
      continue
    fi
    if [ -z "${!key+set}" ]; then
      export "$key=$value"
    fi
  done <"$CONFIG_FILE"
}

# Writes a value the way config_load reads it back: bare when it is plain, else single-quoted.
config_quote() {
  case $1 in
    *\'*) printf '%s' "$1" ;;
    *[!A-Za-z0-9_./:@+,=-]*) printf "'%s'" "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}

# config_set KEY VALUE: stores KEY=VALUE in the config file, replacing an earlier
# value, and exports it. The file is readable by the current user only.
config_set() {
  local key=$1 value=$2 dir tmp
  dir=$(dirname -- "$CONFIG_FILE")
  mkdir -p -- "$dir"
  tmp=$(mktemp "$dir/.config.env.XXXXXX")
  if [ -f "$CONFIG_FILE" ]; then
    grep -v -E "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" -- "$CONFIG_FILE" >"$tmp" || true
  else
    {
      say '# Signal Automator settings for bin/*.sh (KEY=value, one per line).'
      say '# Environment variables with the same names take precedence.'
    } >"$tmp"
  fi
  printf '%s=%s\n' "$key" "$(config_quote "$value")" >>"$tmp"
  chmod 600 "$tmp"
  mv -f -- "$tmp" "$CONFIG_FILE"
  export "$key=$value"
}

# ---------------------------------------------------------------- prerequisites

node_major() {
  have node || return 0
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true
}

node_hint() {
  if is_macos; then
    say "Install it with 'brew install node' or from https://nodejs.org."
  else
    say 'Install the LTS release from https://nodejs.org, with nvm (https://github.com/nvm-sh/nvm) or your package manager (check that it is new enough).'
  fi
}

require_node() {
  local major
  major=$(node_major)
  [ -n "$major" ] || die "Node.js $MIN_NODE or newer is required, but 'node' was not found. $(node_hint)"
  [ "$major" -ge "$MIN_NODE" ] || die "Node.js $MIN_NODE or newer is required (found $(node --version)). $(node_hint)"
  have npm || die "npm was not found next to node $(node --version). $(node_hint)"
}

# Prints the Java executable to use (JAVA_HOME first, then the PATH), or nothing.
java_cmd() {
  if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then
    say "$JAVA_HOME/bin/java"
  elif have java; then
    say java
  fi
}

# Prints the major version of that Java runtime (8, 17, 21, ...), or nothing.
java_major() {
  local java out version
  java=$(java_cmd)
  [ -n "$java" ] || return 0
  out=$("$java" -version 2>&1) || return 0
  version=$(printf '%s\n' "$out" | sed -n 's/.*version "\([^"]*\)".*/\1/p' | head -n 1)
  case $version in 1.*) version=${version#1.} ;; esac
  version=${version%%[!0-9]*}
  [ -z "$version" ] || say "$version"
}

java_hint() {
  if is_macos; then
    say "Install it with 'brew install openjdk@21' or from https://adoptium.net."
  else
    say 'Install it from your package manager (e.g. openjdk-21-jre-headless or java-21-openjdk-headless) or from https://adoptium.net.'
  fi
}

# Prints the signal-cli executable: $SIGNAL_CLI (usually saved by install.sh),
# then signal-cli on the PATH, then the newest copy under DATA_HOME. Fails if none.
find_signal_cli() {
  local found
  if [ -n "${SIGNAL_CLI:-}" ]; then
    if [ -f "$SIGNAL_CLI" ] && [ -x "$SIGNAL_CLI" ]; then
      say "$SIGNAL_CLI"
      return 0
    fi
    if found=$(command -v -- "$SIGNAL_CLI" 2>/dev/null) && [ -n "$found" ]; then
      say "$found"
      return 0
    fi
    warn "SIGNAL_CLI=$SIGNAL_CLI is not an executable file; looking for signal-cli elsewhere"
  fi
  if found=$(command -v signal-cli 2>/dev/null) && [ -n "$found" ]; then
    say "$found"
    return 0
  fi
  [ -d "$DATA_HOME/signal-cli" ] || return 1
  local newest='' candidate
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    if [ -z "$newest" ] || [ "$candidate" -nt "$newest" ]; then newest=$candidate; fi
  done <<<"$(find "$DATA_HOME/signal-cli" -maxdepth 4 -type f -name signal-cli -perm -u+x 2>/dev/null)"
  [ -n "$newest" ] || return 1
  say "$newest"
}

require_signal_cli() {
  SIGNAL_CLI_BIN=$(find_signal_cli) || die "signal-cli was not found. Run bin/install.sh first, or set SIGNAL_CLI in $(pretty_path "$CONFIG_FILE") to its path."
}

# Word-splits a settings string (like SIGNAL_CLI_ARGS) into the array named by $1.
# Expand the result with ${name[@]+"${name[@]}"}, which bash 3.2 accepts under set -u when it is empty.
split_words() {
  local IFS=$' \t\n'
  read -r -a "$1" <<<"$2"
}

# ---------------------------------------------------------------- HTTP and URLs

# http_up URL: succeeds if anything answers HTTP at URL (any status code).
http_up() {
  node -e '
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 3000).unref();
    fetch(process.argv[1], { signal: ac.signal, redirect: "manual" }).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  ' "$1" >/dev/null 2>&1
}

# Prints the transport kind ("signal-cli" or "mock") of the automator at URL, or nothing.
server_kind() {
  node -e '
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 3000).unref();
    fetch(process.argv[1] + "/api/status", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : {}))
      .then((s) => process.stdout.write(String((s && s.kind) || "")), () => {});
  ' "$1" 2>/dev/null || true
}

# Splits http://HOST[:PORT][/path] into HOST and PORT (the globals URL_HOST and URL_PORT).
parse_http_url() {
  local rest hostport
  rest=${1#http://}
  [ "$rest" != "$1" ] || return 1
  hostport=${rest%%/*}
  case $hostport in
    \[*\]:*)
      URL_HOST=${hostport%%\]:*}
      URL_HOST=${URL_HOST#\[}
      URL_PORT=${hostport##*\]:}
      ;;
    \[*\])
      URL_HOST=${hostport#\[}
      URL_HOST=${URL_HOST%\]}
      URL_PORT=80
      ;;
    *:*)
      URL_HOST=${hostport%:*}
      URL_PORT=${hostport##*:}
      ;;
    *)
      URL_HOST=$hostport
      URL_PORT=80
      ;;
  esac
  case $URL_PORT in '' | *[!0-9]*) return 1 ;; esac
  [ -n "$URL_HOST" ]
}

is_local_host() {
  case $1 in
    localhost | ::1 | 127.*) return 0 ;;
    *) return 1 ;;
  esac
}

# HOST:PORT, with IPv6 addresses in brackets.
host_port() {
  case $1 in
    *:*) printf '[%s]:%s\n' "$1" "$2" ;;
    *) printf '%s:%s\n' "$1" "$2" ;;
  esac
}

# The address to open in a browser for the server's AUTOMATOR_HOST and AUTOMATOR_PORT.
ui_url() {
  local host=${AUTOMATOR_HOST:-127.0.0.1}
  case $host in '' | 0.0.0.0 | ::) host=127.0.0.1 ;; esac
  printf 'http://%s\n' "$(host_port "$host" "${AUTOMATOR_PORT:-$DEFAULT_PORT}")"
}

open_in_browser() {
  if is_macos && have open; then
    open "$1" >/dev/null 2>&1 &
  elif have xdg-open && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; }; then
    xdg-open "$1" >/dev/null 2>&1 &
  elif have wslview; then
    wslview "$1" >/dev/null 2>&1 &
  else
    return 1
  fi
}

# ---------------------------------------------------------------- background processes

# running_pid PIDFILE [PATTERN]: prints the PID recorded in PIDFILE if that process
# is alive and its command line contains PATTERN (which guards against reused PIDs).
running_pid() {
  local pid=''
  [ -r "$1" ] || return 1
  IFS= read -r pid <"$1" || true
  case $pid in '' | *[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  if [ -n "${2:-}" ]; then
    case $(process_command "$pid") in
      *"$2"*) ;;
      *) return 1 ;;
    esac
  fi
  say "$pid"
}

# The full command line of a process (-ww: not cut to the terminal width).
process_command() {
  ps -ww -p "$1" -o command= 2>/dev/null || true
}

# launch_background LOG PIDFILE COMMAND...: starts COMMAND detached from this
# terminal (in its own session where setsid exists), writing its output to LOG
# (the previous log is kept as LOG.1), and records the PID in LAUNCHED_PID and PIDFILE.
launch_background() {
  local log=$1 pidfile=$2
  shift 2
  mkdir -p -- "$STATE_DIR"
  if [ -f "$log" ]; then mv -f -- "$log" "$log.1"; fi
  if have setsid; then
    setsid "$@" </dev/null >"$log" 2>&1 &
  else
    nohup "$@" </dev/null >"$log" 2>&1 &
  fi
  LAUNCHED_PID=$!
  say "$LAUNCHED_PID" >"$pidfile"
}

# stop_pid PID NAME SECONDS: asks the process to stop (SIGTERM) and kills it
# (SIGKILL) if it is still running after SECONDS.
stop_pid() {
  local pid=$1 name=$2 seconds=$3 waited=0
  kill -TERM "$pid" 2>/dev/null || return 0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$seconds" ]; then
      warn "$name did not stop within ${seconds}s; killing it"
      kill -KILL "$pid" 2>/dev/null || true
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

# Prints the last lines of a log file, indented, to stderr.
show_log_tail() {
  [ -s "$1" ] || return 0
  printf '%s--- last lines of %s ---%s\n' "$C_DIM" "$(pretty_path "$1")" "$C_RESET" >&2
  tail -n "${2:-20}" -- "$1" | sed 's/^/  /' >&2
}
