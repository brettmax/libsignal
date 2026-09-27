#!/usr/bin/env bash
# Starts Signal Automator: the signal-cli daemon in the background, then the
# automator server, and opens http://127.0.0.1:7583 in your browser.
#
# Usage: bin/start.sh [--mock] [--port PORT] [--no-browser] [--foreground]
#
#   --mock         try it without Signal: a fake transport with three pretend
#                  contacts, where nothing is really sent. Mock mode keeps its
#                  own data in automator/data/mock (AUTOMATOR_MOCK_DATA_DIR).
#   --port PORT    serve the UI on another port (AUTOMATOR_PORT, default 7583)
#   --no-browser   do not open the browser
#   --foreground   run the server in this terminal: Ctrl+C stops it, and also
#                  the daemon if this script started it
#
# Settings come from the environment and ~/.config/signal-automator/config.env:
# SIGNAL_ACCOUNT (saved by bin/link-device.sh), SIGNAL_CLI, SIGNAL_CLI_URL,
# SIGNAL_CLI_ARGS, SIGNAL_CLI_DAEMON_ARGS and the server's AUTOMATOR_* settings.
# Relative paths in them are relative to the automator directory.
# Logs go to ~/.local/state/signal-automator/. Stop everything with bin/stop.sh.

set -euo pipefail
# shellcheck source-path=SCRIPTDIR
# shellcheck source=_common.sh disable=SC1091
. "$(dirname -- "${BASH_SOURCE[0]}")/_common.sh"

usage() { sed -n '2,/^$/s/^# \{0,1\}//p' "${BASH_SOURCE[0]}"; }

mock=0
port=''
browser=1
foreground=0
while [ $# -gt 0 ]; do
  case $1 in
    --mock) mock=1 ;;
    --port)
      [ $# -ge 2 ] || die '--port needs a value'
      port=$2
      shift
      ;;
    --port=*) port=${1#--port=} ;;
    --no-browser) browser=0 ;;
    --foreground) foreground=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

config_load
if [ -n "$port" ]; then
  case $port in *[!0-9]* | '') die "--port must be a number (got $port)" ;; esac
  export AUTOMATOR_PORT=$port
fi
if [ "${AUTOMATOR_TRANSPORT:-}" = mock ]; then mock=1; fi
require_node
cd -- "$AUTOMATOR_DIR"

server_entry=$AUTOMATOR_DIR/server/dist/index.js
[ -f "$server_entry" ] || die "the server has not been built yet. Run bin/install.sh (or npm install && npm run build in $(pretty_path "$AUTOMATOR_DIR"))."
web_dist=${AUTOMATOR_WEB_DIST:-$AUTOMATOR_DIR/web/dist}
if [ ! -f "$web_dist/index.html" ]; then
  warn "the web UI has not been built ($(pretty_path "$web_dist") is missing); run npm run build in $(pretty_path "$AUTOMATOR_DIR")."
fi

url=$(ui_url)
if [ "$mock" = 1 ]; then want_kind=mock; else want_kind=signal-cli; fi

# ---------------------------------------------------------------- already running?

wait_for_server() {
  local pid=$1 waited=0
  until http_up "$url/api/status"; do
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      rm -f -- "$SERVER_PID_FILE"
      show_log_tail "$SERVER_LOG" 25
      if grep -q EADDRINUSE -- "$SERVER_LOG" 2>/dev/null; then
        die "port ${AUTOMATOR_PORT:-$DEFAULT_PORT} is already in use by another program. Pick another one with --port."
      fi
      die "the automator server stopped during startup; see the log above ($(pretty_path "$SERVER_LOG"))."
    fi
    [ "$waited" -lt 60 ] || die "the automator server did not answer at $url within 60s; see $(pretty_path "$SERVER_LOG")."
    sleep 1
    waited=$((waited + 1))
  done
}

running=''
if running=$(running_pid "$SERVER_PID_FILE" "$SERVER_MATCH"); then
  wait_for_server "$running"
fi
if [ -n "$running" ] || http_up "$url/api/status"; then
  kind=$(server_kind "$url")
  case $kind in
    "$want_kind")
      ok "Signal Automator is already running: $url"
      if [ "$browser" = 1 ]; then open_in_browser "$url" || true; fi
      exit 0
      ;;
    '') die "something else is already using port ${AUTOMATOR_PORT:-$DEFAULT_PORT}. Pick another port with --port (or set AUTOMATOR_PORT)." ;;
    *) die "Signal Automator is already running at $url with the $kind transport. Stop it first with bin/stop.sh." ;;
  esac
fi

# ---------------------------------------------------------------- signal-cli daemon

started_daemon=''
opener=''

# For --foreground: stops the daemon this script started when the server exits.
on_exit() {
  if [ -n "$opener" ]; then kill "$opener" 2>/dev/null || true; fi
  if [ -n "$started_daemon" ] && kill -0 "$started_daemon" 2>/dev/null; then
    say 'Stopping the signal-cli daemon...'
    stop_pid "$started_daemon" 'the signal-cli daemon' 20
    rm -f -- "$DAEMON_PID_FILE"
  fi
}

daemon_hint() {
  if grep -q -i 'not registered' -- "$DAEMON_LOG" 2>/dev/null; then
    say "signal-cli has no working link for $SIGNAL_ACCOUNT (unlinked on the phone?): run bin/link-device.sh --force."
  elif grep -q -i 'in use by another instance' -- "$DAEMON_LOG" 2>/dev/null; then
    say 'Another signal-cli process is using this account; stop it first.'
  elif grep -q -E 'UnsupportedClassVersionError|compiled by a more recent version' -- "$DAEMON_LOG" 2>/dev/null; then
    say "signal-cli needs Java $MIN_JAVA or newer. $(java_hint)"
  elif grep -q -i -E 'address already in use|BindException' -- "$DAEMON_LOG" 2>/dev/null; then
    say "Port $URL_PORT is taken; set SIGNAL_CLI_URL to another port, e.g. http://127.0.0.1:7590."
  elif grep -q -i -E 'UnsatisfiedLinkError|signal_jni|libsignal-client' -- "$DAEMON_LOG" 2>/dev/null; then
    say "signal-cli could not load libsignal's native library, which its Java build includes only for some platforms (not ARM Linux). See Troubleshooting in README.md."
  else
    say "See the log above ($(pretty_path "$DAEMON_LOG"))."
  fi
}

wait_for_daemon() {
  local pid=$1 waited=0 limit=${SIGNAL_CLI_START_TIMEOUT:-120}
  printf 'Waiting for signal-cli to come up (this can take a while on the first start)'
  until http_up "$SIGNAL_CLI_URL/api/v1/check"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      say ''
      rm -f -- "$DAEMON_PID_FILE"
      show_log_tail "$DAEMON_LOG" 25
      die "the signal-cli daemon stopped during startup. $(daemon_hint)"
    fi
    if [ "$waited" -ge "$limit" ]; then
      say ''
      show_log_tail "$DAEMON_LOG" 25
      die "signal-cli did not answer at $SIGNAL_CLI_URL within ${limit}s. It is still running (PID $pid): check $(pretty_path "$DAEMON_LOG"), or stop it with bin/stop.sh."
    fi
    printf '.'
    sleep 1
    waited=$((waited + 1))
  done
  say ''
  ok "signal-cli daemon is up at $SIGNAL_CLI_URL"
}

start_daemon() {
  local pid address
  parse_http_url "$SIGNAL_CLI_URL" || die "SIGNAL_CLI_URL must look like http://127.0.0.1:7584 (got $SIGNAL_CLI_URL)."
  if http_up "$SIGNAL_CLI_URL/api/v1/check"; then
    say "Using the signal-cli daemon that is already running at $SIGNAL_CLI_URL."
    return 0
  fi
  if pid=$(running_pid "$DAEMON_PID_FILE" "$DAEMON_MATCH"); then
    wait_for_daemon "$pid"
    return 0
  fi
  is_local_host "$URL_HOST" || die "nothing answers at SIGNAL_CLI_URL=$SIGNAL_CLI_URL, and a daemon on another computer cannot be started from here."
  require_signal_cli

  global_args=()
  daemon_args=()
  split_words global_args "${SIGNAL_CLI_ARGS:-}"
  split_words daemon_args "${SIGNAL_CLI_DAEMON_ARGS-$DEFAULT_DAEMON_ARGS}"
  address=$(host_port "$URL_HOST" "$URL_PORT")
  step "Starting the signal-cli daemon for $SIGNAL_ACCOUNT on $address"
  launch_background "$DAEMON_LOG" "$DAEMON_PID_FILE" \
    "$SIGNAL_CLI_BIN" ${global_args[@]+"${global_args[@]}"} -a "$SIGNAL_ACCOUNT" \
    daemon --http "$address" ${daemon_args[@]+"${daemon_args[@]}"}
  started_daemon=$LAUNCHED_PID
  wait_for_daemon "$LAUNCHED_PID"
}

if [ "$mock" = 1 ]; then
  export AUTOMATOR_TRANSPORT=mock
  AUTOMATOR_DATA_DIR=${AUTOMATOR_MOCK_DATA_DIR:-${AUTOMATOR_DATA_DIR:-$AUTOMATOR_DIR/data}/mock}
  export AUTOMATOR_DATA_DIR
  mkdir -p -- "$AUTOMATOR_DATA_DIR"
  step "Mock mode: nothing is really sent (data in $(pretty_path "$AUTOMATOR_DATA_DIR"))"
else
  [ -n "${SIGNAL_ACCOUNT:-}" ] || die 'no Signal account is configured yet. Link this computer first with bin/link-device.sh (or try bin/start.sh --mock).'
  export AUTOMATOR_TRANSPORT=signal-cli SIGNAL_ACCOUNT
  export SIGNAL_CLI_URL=${SIGNAL_CLI_URL:-$DEFAULT_SIGNAL_CLI_URL}
  start_daemon
fi

# ---------------------------------------------------------------- server

if [ "$foreground" = 1 ]; then
  trap on_exit EXIT
  if [ "$browser" = 1 ]; then
    (
      tries=0
      while [ "$tries" -lt 60 ]; do
        if http_up "$url/api/status"; then
          open_in_browser "$url" || true
          break
        fi
        sleep 1
        tries=$((tries + 1))
      done
    ) &
    opener=$!
  fi
  step "Starting the automator at $url (Ctrl+C to stop)"
  status=0
  node "$server_entry" || status=$?
  exit "$status"
fi

step "Starting the automator at $url"
launch_background "$SERVER_LOG" "$SERVER_PID_FILE" node "$server_entry"
wait_for_server "$LAUNCHED_PID"

say ''
ok "Signal Automator is running: $url"
if [ "$mock" = 1 ]; then
  say '  mode:   mock (nothing is really sent)'
  say "  log:    $(pretty_path "$SERVER_LOG")"
else
  say "  mode:   signal-cli, account $SIGNAL_ACCOUNT"
  say "  logs:   $(pretty_path "$SERVER_LOG") and $(pretty_path "$DAEMON_LOG")"
fi
say '  stop:   bin/stop.sh'
case ${AUTOMATOR_HOST:-} in
  0.0.0.0 | ::) warn "AUTOMATOR_HOST=$AUTOMATOR_HOST: anyone on your network can open the UI and send messages as you." ;;
esac
if [ "$browser" = 1 ]; then
  open_in_browser "$url" || say "Open $url in your browser."
fi
