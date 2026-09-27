#!/usr/bin/env bash
# Links this computer to your Signal account as an extra device, like Signal Desktop.
#
# Runs "signal-cli link", shows the link as a QR code in the terminal (with
# qrencode if it is installed, otherwise with Node.js) and waits while you scan
# it on your phone: Signal > Settings > Linked devices > Link new device.
# When the phone confirms, the account's number is saved as SIGNAL_ACCOUNT in
# ~/.config/signal-automator/config.env, where bin/start.sh picks it up.
#
# Usage: bin/link-device.sh [--name NAME] [--browser] [--force]
#
#   --name NAME   the name shown in Signal's list of linked devices (default: Signal Automator)
#   --browser     also open the QR code in your web browser
#   --force       link again although an account is already configured
#
# Like Signal Desktop, the linked device can read and send your messages from
# now on. You can unlink it at any time in Signal's Linked devices screen.

set -euo pipefail
# shellcheck source-path=SCRIPTDIR
# shellcheck source=_common.sh disable=SC1091
. "$(dirname -- "${BASH_SOURCE[0]}")/_common.sh"

usage() { sed -n '2,/^$/s/^# \{0,1\}//p' "${BASH_SOURCE[0]}"; }

name=$DEFAULT_DEVICE_NAME
browser=0
force=0
while [ $# -gt 0 ]; do
  case $1 in
    --name)
      if [ $# -lt 2 ] || [ -z "$2" ]; then die '--name needs a value'; fi
      name=$2
      shift
      ;;
    --name=*) name=${1#--name=} ;;
    --browser) browser=1 ;;
    --force) force=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

config_load
require_signal_cli

if [ -n "${SIGNAL_ACCOUNT:-}" ] && [ "$force" = 0 ]; then
  say "Already linked: SIGNAL_ACCOUNT=$SIGNAL_ACCOUNT (from $(pretty_path "$CONFIG_FILE") or the environment)."
  say 'Start the automator with bin/start.sh, or run this again with --force to link anew.'
  exit 0
fi

if pid=$(running_pid "$DAEMON_PID_FILE" "$DAEMON_MATCH"); then
  die "the signal-cli daemon is running (PID $pid). Stop it with bin/stop.sh first, then run this again."
fi

global_args=()
split_words global_args "${SIGNAL_CLI_ARGS:-}"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/signal-automator-link.XXXXXX")
page=$tmp/link-qr.html
link_pid=''

cleanup() {
  if [ -n "$link_pid" ] && kill -0 "$link_pid" 2>/dev/null; then
    kill "$link_pid" 2>/dev/null || true
  fi
  rm -rf -- "$tmp"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 129' HUP
trap 'exit 143' TERM

show_qr() {
  local uri=$1
  say ''
  say "${C_BOLD}On your phone, open Signal > Settings > Linked devices > Link new device, and scan this code:${C_RESET}"
  say ''
  if have qrencode; then
    qrencode -t ansiutf8 "$uri" || node "$AUTOMATOR_DIR/bin/qr.mjs" "$uri" || true
  elif have node; then
    node "$AUTOMATOR_DIR/bin/qr.mjs" "$uri" || true
  else
    say '(No QR code tool was found: install qrencode or Node.js, or use the link below.)'
  fi
  say ''
  if have node && node "$AUTOMATOR_DIR/bin/qr.mjs" --html "$page" "$uri" 2>/dev/null; then
    say 'If the code does not scan (small window, unusual font), open this page and scan it there:'
    say "  file://$page"
    if [ "$browser" = 1 ]; then open_in_browser "file://$page" || true; fi
  fi
  say 'Or paste this link into a QR code generator you trust (it is only valid for a few minutes):'
  say "  $uri"
  say ''
  say "${C_DIM}Waiting for your phone... (Ctrl+C to cancel)${C_RESET}"
}

step "Starting signal-cli link -n \"$name\""
mkfifo "$tmp/out"
"$SIGNAL_CLI_BIN" ${global_args[@]+"${global_args[@]}"} link -n "$name" >"$tmp/out" &
link_pid=$!

account=''
while IFS= read -r line; do
  case $line in
    sgnl://* | tsdevice:*) show_qr "$line" ;;
    'Associated with: '*) account=${line#Associated with: } ;;
    *) say "$line" ;;
  esac
done <"$tmp/out"

status=0
wait "$link_pid" || status=$?
link_pid=''

if [ "$status" -ne 0 ] || [ -z "$account" ]; then
  if [ "$status" -eq 0 ]; then
    die 'signal-cli finished without reporting the linked account. Try again.'
  fi
  die "linking did not complete (signal-cli exited with status $status). See the messages above; if the code expired, run this again."
fi

config_set SIGNAL_ACCOUNT "$account"
say ''
ok "Linked. This computer is now a linked device of $account."
say "Saved SIGNAL_ACCOUNT=$account in $(pretty_path "$CONFIG_FILE")."
say 'Next: bin/start.sh   (on the first start signal-cli may need a minute to sync contacts and groups)'
