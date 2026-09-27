#!/usr/bin/env bash
# Stops Signal Automator: the automator server and the signal-cli daemon that
# bin/start.sh started in the background. Both get a moment to shut down
# cleanly (the server saves its state) before they are killed.
#
# Usage: bin/stop.sh [--server-only]
#
#   --server-only   keep the signal-cli daemon running (the next start is faster)

set -euo pipefail
# shellcheck source-path=SCRIPTDIR
# shellcheck source=_common.sh disable=SC1091
. "$(dirname -- "${BASH_SOURCE[0]}")/_common.sh"

usage() { sed -n '2,/^$/s/^# \{0,1\}//p' "${BASH_SOURCE[0]}"; }

server_only=0
while [ $# -gt 0 ]; do
  case $1 in
    --server-only) server_only=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

config_load

stopped=0
if pid=$(running_pid "$SERVER_PID_FILE" "$SERVER_MATCH"); then
  step "Stopping the automator server (PID $pid)"
  # The server exits by itself at most 10s after SIGTERM.
  stop_pid "$pid" 'the automator server' 15
  stopped=1
fi
rm -f -- "$SERVER_PID_FILE"

if [ "$server_only" = 0 ]; then
  if pid=$(running_pid "$DAEMON_PID_FILE" "$DAEMON_MATCH"); then
    step "Stopping the signal-cli daemon (PID $pid)"
    stop_pid "$pid" 'the signal-cli daemon' 20
    stopped=1
  fi
  rm -f -- "$DAEMON_PID_FILE"
fi

if [ "$stopped" = 1 ]; then
  ok 'Stopped.'
else
  say 'Nothing to stop: no server or daemon started by bin/start.sh is running.'
fi

url=$(ui_url)
if http_up "$url/api/status"; then
  warn "an automator server still answers at $url. bin/start.sh did not start it in the background (npm start, --foreground or another copy?), so stop it where it runs, with Ctrl+C."
fi
if [ "$server_only" = 0 ]; then
  daemon_url=${SIGNAL_CLI_URL:-$DEFAULT_SIGNAL_CLI_URL}
  if http_up "$daemon_url/api/v1/check"; then
    say "Note: a signal-cli daemon that bin/start.sh did not start is still running at $daemon_url."
  fi
fi
