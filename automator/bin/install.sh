#!/usr/bin/env bash
# Installs what Signal Automator needs on macOS or Linux, then builds it.
#
#   1. Checks for Node.js 20 or newer (and npm).
#   2. Installs signal-cli if it is not found:
#        - macOS with Homebrew: brew install signal-cli
#        - otherwise the latest release from https://github.com/AsamK/signal-cli
#          into ~/.local/share/signal-automator/signal-cli: the Java build when
#          Java 21+ is installed, else the native build on x86-64 Linux.
#      Its path is saved as SIGNAL_CLI in ~/.config/signal-automator/config.env.
#   3. Runs npm install and npm run build in the automator directory.
#
# Usage: bin/install.sh [--skip-signal-cli] [--force-signal-cli] [--no-build]
#
#   --skip-signal-cli   do not look for or install signal-cli (for mock mode only)
#   --force-signal-cli  download the latest signal-cli even if one is installed
#   --no-build          skip npm install and npm run build
#
# Safe to run again, for example to update after pulling new code.

set -euo pipefail
# shellcheck source-path=SCRIPTDIR
# shellcheck source=_common.sh disable=SC1091
. "$(dirname -- "${BASH_SOURCE[0]}")/_common.sh"

# SIGNAL_CLI_RELEASES_API can point at a mirror of the GitHub releases API (or a test server).
RELEASES_API=${SIGNAL_CLI_RELEASES_API:-https://api.github.com/repos/AsamK/signal-cli/releases/latest}

usage() { sed -n '2,/^$/s/^# \{0,1\}//p' "${BASH_SOURCE[0]}"; }

skip_signal_cli=0
force_signal_cli=0
build=1
while [ $# -gt 0 ]; do
  case $1 in
    --skip-signal-cli) skip_signal_cli=1 ;;
    --force-signal-cli) force_signal_cli=1 ;;
    --no-build) build=0 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

config_load

# ---------------------------------------------------------------- downloads

# fetch URL [FILE]: downloads URL to FILE, or to stdout without one.
fetch() {
  local out=${2:--}
  if have curl; then
    curl -fsSL --retry 2 -o "$out" "$1"
  elif have wget; then
    wget -q -O "$out" "$1"
  else
    die 'curl or wget is needed to download signal-cli.'
  fi
}

sha256_of() {
  node -e '
    const hash = require("crypto").createHash("sha256");
    hash.update(require("fs").readFileSync(process.argv[1]));
    process.stdout.write(hash.digest("hex"));
  ' "$1"
}

# Reads the GitHub release JSON on stdin and prints "tag<TAB>name<TAB>url<TAB>digest"
# for the asset of the given kind ("jvm" or "native").
pick_asset() {
  # shellcheck disable=SC2016  # ${...} here is JavaScript, not the shell
  node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => {
      let release;
      try {
        release = JSON.parse(raw);
      } catch {
        console.error("GitHub sent a response that is not JSON");
        process.exit(3);
      }
      const native = process.argv[1] === "native";
      const wanted = (name) =>
        native
          ? /^signal-cli-.*-Linux-native\.tar\.gz$/i.test(name)
          : /^signal-cli-v?\d[\w.+-]*\.tar\.gz$/.test(name) && !/native|client|linux|macos|windows/i.test(name);
      const asset = (release.assets || []).find((a) => wanted(a.name));
      if (!asset) {
        const names = (release.assets || []).map((a) => a.name).join(", ");
        console.error(`no ${native ? "Linux native" : "Java"} build among the assets of ${release.tag_name}: ${names}`);
        process.exit(3);
      }
      console.log([release.tag_name, asset.name, asset.browser_download_url, asset.digest || ""].join("\t"));
    });
  ' "$1"
}

# install_from_github KIND: downloads and unpacks the latest release, prints the executable.
install_from_github() {
  local kind=$1 json line tag name url digest tmp dest actual exe
  step "Looking up the latest signal-cli release" >&2
  json=$(fetch "$RELEASES_API") || die "could not reach $RELEASES_API (offline, behind a proxy, or rate limited?). Install signal-cli yourself and set SIGNAL_CLI in $(pretty_path "$CONFIG_FILE")."
  line=$(printf '%s' "$json" | pick_asset "$kind") || die 'could not find a suitable signal-cli download.'
  IFS=$'\t' read -r tag name url digest <<<"$line"
  dest=$DATA_HOME/signal-cli/${tag#v}

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/signal-automator-install.XXXXXX")
  # shellcheck disable=SC2064  # expand now: tmp is local to this function
  trap "rm -rf -- '$tmp'" EXIT
  step "Downloading $name" >&2
  fetch "$url" "$tmp/$name" || die "download failed: $url"
  case $digest in
    sha256:*)
      actual=$(sha256_of "$tmp/$name")
      [ "$actual" = "${digest#sha256:}" ] || die "checksum mismatch for $name (expected ${digest#sha256:}, got $actual)"
      say "Checksum OK (sha256 $actual)" >&2
      ;;
    *) warn "GitHub did not publish a checksum for $name; skipping verification" ;;
  esac

  rm -rf -- "$dest"
  mkdir -p -- "$dest"
  tar -xzf "$tmp/$name" -C "$dest" || die "could not unpack $name"
  exe=$(find "$dest" -maxdepth 3 -type f -name signal-cli | head -n 1)
  [ -n "$exe" ] || die "unpacked $name, but it contains no signal-cli executable"
  chmod +x "$exe"
  say "$exe"
}

install_signal_cli() {
  local java exe
  if is_macos && have brew; then
    if brew list --versions signal-cli >/dev/null 2>&1; then
      step 'Updating signal-cli with Homebrew (brew upgrade signal-cli)'
      brew upgrade signal-cli || true
    else
      step 'Installing signal-cli with Homebrew (brew install signal-cli)'
      brew install signal-cli
    fi
    exe=$(command -v signal-cli) || die 'brew installed signal-cli, but it is not on the PATH.'
  else
    java=$(java_major)
    if [ -n "$java" ] && [ "$java" -ge "$MIN_JAVA" ]; then
      exe=$(install_from_github jvm)
    elif [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ]; then
      if [ -n "$java" ]; then
        say "Java $java is too old for the Java build of signal-cli (needs $MIN_JAVA+); using the native Linux build."
      else
        say "Java is not installed; using the native Linux build of signal-cli, which does not need it."
      fi
      exe=$(install_from_github native)
    else
      if [ -n "$java" ]; then
        die "signal-cli needs Java $MIN_JAVA or newer (found Java $java). $(java_hint) Then run this script again."
      fi
      die "signal-cli needs Java $MIN_JAVA or newer, and it was not found. $(java_hint) Then run this script again."
    fi
  fi
  config_set SIGNAL_CLI "$exe"
  ok "Installed signal-cli: $exe"
}

# ---------------------------------------------------------------- steps

step "Checking Node.js"
require_node
say "Node.js $(node --version), npm $(npm --version)"

if [ "$skip_signal_cli" = 1 ]; then
  say 'Skipping signal-cli (--skip-signal-cli): only mock mode (bin/start.sh --mock) will work.'
else
  step 'Checking signal-cli'
  existing=''
  if [ "$force_signal_cli" = 0 ]; then existing=$(find_signal_cli || true); fi
  if [ -n "$existing" ]; then
    say "Found signal-cli: $existing"
    if version=$("$existing" --version 2>&1); then
      say "$version"
      if [ "${SIGNAL_CLI:-}" != "$existing" ]; then config_set SIGNAL_CLI "$existing"; fi
    else
      warn "'$existing --version' failed:"
      printf '%s\n' "$version" | sed 's/^/  /' >&2
      java=$(java_major)
      if [ -z "$java" ] || [ "$java" -lt "$MIN_JAVA" ]; then
        warn "signal-cli needs Java $MIN_JAVA or newer (found: ${java:-none}). $(java_hint)"
      fi
      warn 'Run this script with --force-signal-cli to download a fresh copy.'
    fi
  else
    install_signal_cli
  fi
fi

if [ "$build" = 1 ]; then
  step "Installing npm packages (npm install in $(pretty_path "$AUTOMATOR_DIR"))"
  (cd -- "$AUTOMATOR_DIR" && npm install)
  step 'Building the server and the web UI (npm run build)'
  (cd -- "$AUTOMATOR_DIR" && npm run build)
fi

say ''
ok 'Done.'
if [ "$skip_signal_cli" = 1 ]; then
  say 'Next: bin/start.sh --mock   (try the app without a phone; messages are not really sent)'
elif [ -n "${SIGNAL_ACCOUNT:-}" ]; then
  say "Linked account: $SIGNAL_ACCOUNT. Next: bin/start.sh"
else
  say 'Next steps:'
  say '  bin/link-device.sh     link this computer to your Signal account (scan a QR code with your phone)'
  say '  bin/start.sh           start signal-cli and the automator, then open http://127.0.0.1:7583'
  say '  bin/start.sh --mock    or try it first without a phone (messages are not really sent)'
fi
