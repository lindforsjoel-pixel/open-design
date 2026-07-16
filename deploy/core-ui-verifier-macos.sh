#!/bin/bash
set -Eeuo pipefail

umask 077
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# The verifier runs agent-produced Core UI code. Keep command resolution and
# package-manager behavior independent of the daemon's inherited environment.
while IFS='=' read -r name _value; do
  case "$name" in
    BASH_ENV|ENV|CDPATH|CI|CORE_V2_*|GIT_*|HOST|INIT_CWD|LD_*|DYLD_*|NODE_ENV|NODE_OPTIONS|NODE_PATH|NPM_CONFIG_*|npm_config_*|ORIGIN|PORT|PUBLIC_*|SOURCE_DATE_EPOCH|SVELTEKIT_*|VITE_*|BODY_SIZE_LIMIT|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy)
      unset "$name"
      ;;
  esac
done < <(/usr/bin/env)
export LANG=C
export LC_ALL=C
export TZ=UTC

readonly SCRIPT_NAME="${0##*/}"
readonly CORE_V2_REL="99_System/core-v2"
readonly WEB_REL="$CORE_V2_REL/apps/web"
readonly APP_REL="$WEB_REL/src/app.html"
readonly STATIC_ROOT="$WEB_REL/static/"
readonly RECEIPT_PREFIX="${STATIC_ROOT}open-design/attestations/"
readonly CORE_UI_PROJECT_ID="1d0665de-a2b6-4845-ad78-d947c5cc0d5f"
readonly CORE_UI_TARGET_ORIGIN="https://studio-macbook-server.taila20f18.ts.net:8444"
readonly CORE_UI_PREVIEW_ORIGIN="https://studio-macbook-server.taila20f18.ts.net:8446"
readonly PREVIEW_PORT="3132"
readonly PREVIEW_DEAD_API_PORT="9"
readonly API_PORT="3130"
readonly WEB_PORT="3131"
readonly EXPECTED_NODE_VERSION="v24.15.0"
readonly EXPECTED_NPM_VERSION="11.12.1"
readonly EXPECTED_USER="joellindfors"
readonly EXPECTED_HOME="/Users/joellindfors"
readonly EXPECTED_REPOSITORY="/Users/joellindfors/Core"

MODE=""
REPOSITORY=""
ATTESTATION=""
CHALLENGE=""
RECEIPT_PATH=""
REQUESTED_PREVIEW_PORT=""
EXPECTED_BUILD_DIGEST=""
BUILD_EPOCH=""

ACCOUNT_HOME=""
CURRENT_UID=""
CURRENT_USER=""
STATE_ROOT=""
LOCK_DIR=""
LOCK_HELD=0
SUCCESS=0
STARTED_PREVIEW_PID=""
STARTED_PREVIEW_CWD=""
PREVIEW_OWNER_FILE=""
NPM_USER_CONFIG=""
NPM_GLOBAL_CONFIG=""
PREVIEW_STATE_CHALLENGE=""
PREVIEW_STATE_ATTESTATION=""
PREVIEW_STATE_PID=""
PREVIEW_STATE_WORKTREE=""
EXISTING_PREVIEW_PID=""
EXISTING_PREVIEW_WORKTREE=""
SWAP_STATE_PHASE=""
SWAP_STATE_ATTESTATION=""
SWAP_STATE_DIGEST=""
SWAP_STATE_PRIOR_DIGEST=""
SWAP_STATE_LIVE_BUILD=""
SWAP_STATE_SWAP_BUILD=""
SWAP_STATE_API_SERVICE_PID=""
SWAP_STATE_API_LISTENER_PID=""
SWAP_STATE_WEB_SERVICE_PID=""
SWAP_STATE_WEB_LISTENER_PID=""
DEPLOY_RESULT_API_PID=""
DEPLOY_RESULT_API_SERVICE_PID=""
DEPLOY_RESULT_WEB_PID=""
DEPLOY_RESULT_WEB_SERVICE_PID=""
TEMP_FILES=""
FAILURE_MESSAGE="Verifier failed unexpectedly."

usage() {
  cat >&2 <<EOF
Usage:
  $SCRIPT_NAME candidate --repository ROOT --attestation A --challenge HEX --receipt-path REL --preview-port 3132
  $SCRIPT_NAME deployment --repository ROOT --attestation A --build-digest HEX
EOF
}

log() {
  printf '%s\n' "[$SCRIPT_NAME] $*" >&2
}

emit_error_json() {
  /usr/bin/python3 - "$MODE" "$FAILURE_MESSAGE" <<'PY'
import json
import sys

print(json.dumps({
    "schemaVersion": 1,
    "ok": False,
    "mode": sys.argv[1] or None,
    "error": sys.argv[2],
}, separators=(",", ":")))
PY
}

die() {
  FAILURE_MESSAGE="$1"
  trap - ERR
  log "$FAILURE_MESSAGE"
  emit_error_json
  exit 1
}

append_temp_file() {
  if [[ -z "$TEMP_FILES" ]]; then
    TEMP_FILES="$1"
  else
    TEMP_FILES="${TEMP_FILES}
$1"
  fi
}

safe_remove_temp_files() {
  local item
  [[ -n "$TEMP_FILES" ]] || return 0
  while IFS= read -r item; do
    [[ -n "$item" ]] || continue
    case "$item" in
      "$STATE_ROOT"/*)
        if [[ -e "$item" && ! -L "$item" ]]; then
          /bin/rm -f -- "$item" 2>/dev/null || true
        fi
        ;;
    esac
  done <<< "$TEMP_FILES"
}

process_uid() {
  /bin/ps -p "$1" -o uid= 2>/dev/null | /usr/bin/awk '{$1=$1; print}'
}

process_cwd() {
  /usr/sbin/lsof -a -p "$1" -d cwd -Fn 2>/dev/null \
    | /usr/bin/sed -n 's/^n//p' \
    | /usr/bin/head -n 1
}

process_command() {
  /bin/ps -ww -p "$1" -o command= 2>/dev/null | /usr/bin/awk '{$1=$1; print}'
}

process_descends_from() {
  local current="$1"
  local ancestor="$2"
  local parent=""
  local depth=""
  [[ "$current" =~ ^[1-9][0-9]*$ && "$ancestor" =~ ^[1-9][0-9]*$ ]] || return 1
  for depth in $(/usr/bin/jot 12 1); do
    parent="$(/bin/ps -p "$current" -o ppid= 2>/dev/null | /usr/bin/awk '{$1=$1; print}')"
    [[ "$parent" =~ ^[1-9][0-9]*$ ]] || return 1
    [[ "$parent" == "$ancestor" ]] && return 0
    [[ "$parent" != "1" && "$parent" != "$current" ]] || return 1
    current="$parent"
  done
  return 1
}

live_listener_process_is_exact() {
  local pid="$1"
  local port="$2"
  local expected_cwd="$3"
  local command=""
  [[ "$(process_uid "$pid")" == "$CURRENT_UID" ]] || return 1
  [[ "$(process_cwd "$pid")" == "$expected_cwd" ]] || return 1
  command="$(process_command "$pid")"
  case "$port" in
    "$API_PORT")
      [[ "$command" == *"/node"* \
        && "$command" == *"node_modules/tsx/"* \
        && "$command" == *"src/api/server.ts" ]]
      ;;
    "$WEB_PORT")
      [[ "$command" == "node build" || "$command" == "/usr/local/bin/node build" ]]
      ;;
    *)
      return 1
      ;;
  esac
}

candidate_process_is_owned() {
  local pid="$1"
  local cwd="$2"
  local command=""
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  /bin/kill -0 "$pid" 2>/dev/null || return 1
  [[ "$(process_uid "$pid")" == "$CURRENT_UID" ]] || return 1
  [[ "$(process_cwd "$pid")" == "$cwd" ]] || return 1
  command="$(process_command "$pid")"
  [[ "$command" == "node build" || "$command" == "/usr/local/bin/node build" ]] || return 1
  return 0
}

listener_pids() {
  /usr/sbin/lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null \
    | /usr/bin/sort -u
}

single_listener_pid() {
  local port="$1"
  local pids=""
  local count=""
  pids="$(listener_pids "$port")"
  [[ -n "$pids" ]] || return 1
  count="$(printf '%s\n' "$pids" | /usr/bin/awk 'NF { count++ } END { print count + 0 }')"
  [[ "$count" == "1" ]] || return 2
  printf '%s\n' "$pids"
}

listener_is_exact() {
  local pid="$1"
  local port="$2"
  local names=""
  names="$(/usr/sbin/lsof -nP -a -p "$pid" -iTCP:"$port" -sTCP:LISTEN -Fn 2>/dev/null \
    | /usr/bin/sed -n 's/^n//p')"
  [[ "$names" == "127.0.0.1:${port}" ]]
}

stop_owned_candidate_process() {
  local pid="$1"
  local cwd="$2"
  local attempt=""
  candidate_process_is_owned "$pid" "$cwd" \
    || die "Refusing to stop preview PID $pid because its owner, command, or working directory is not exact."
  /bin/kill -TERM "$pid" \
    || die "Could not stop the owned preview PID $pid."
  for attempt in $(/usr/bin/jot 40 1); do
    if ! /bin/kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    /bin/sleep 0.25
  done
  die "Owned preview PID $pid did not stop after SIGTERM."
}

cleanup() {
  local status=$?
  local attempt=""
  safe_remove_temp_files
  if [[ "$SUCCESS" != "1" && -n "$STARTED_PREVIEW_PID" && -n "$STARTED_PREVIEW_CWD" ]]; then
    if candidate_process_is_owned "$STARTED_PREVIEW_PID" "$STARTED_PREVIEW_CWD"; then
      /bin/kill -TERM "$STARTED_PREVIEW_PID" 2>/dev/null || true
      for attempt in $(/usr/bin/jot 40 1); do
        /bin/kill -0 "$STARTED_PREVIEW_PID" 2>/dev/null || break
        /bin/sleep 0.25
      done
      if /bin/kill -0 "$STARTED_PREVIEW_PID" 2>/dev/null \
        && candidate_process_is_owned "$STARTED_PREVIEW_PID" "$STARTED_PREVIEW_CWD"; then
        /bin/kill -KILL "$STARTED_PREVIEW_PID" 2>/dev/null || true
      fi
    fi
    if ! /bin/kill -0 "$STARTED_PREVIEW_PID" 2>/dev/null \
      && [[ -n "$PREVIEW_OWNER_FILE" && -f "$PREVIEW_OWNER_FILE" && ! -L "$PREVIEW_OWNER_FILE" ]]; then
      /bin/rm -f -- "$PREVIEW_OWNER_FILE" 2>/dev/null || true
    fi
  fi
  if [[ "$LOCK_HELD" == "1" && -n "$LOCK_DIR" ]]; then
    if [[ -f "$LOCK_DIR/pid" && ! -L "$LOCK_DIR/pid" ]]; then
      /bin/rm -f -- "$LOCK_DIR/pid" 2>/dev/null || true
    fi
    /bin/rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
  return "$status"
}
trap cleanup EXIT

unexpected_error() {
  local status=$?
  trap - ERR
  FAILURE_MESSAGE="Verifier command failed at line ${BASH_LINENO[0]:-unknown}."
  log "$FAILURE_MESSAGE"
  emit_error_json
  exit "$status"
}
trap unexpected_error ERR

set_arg_once() {
  local name="$1"
  local current="$2"
  local value="$3"
  [[ -z "$current" ]] || die "Argument $name was provided more than once."
  [[ -n "$value" ]] || die "Argument $name requires a value."
}

parse_args() {
  [[ $# -ge 1 ]] || {
    usage
    die "A verifier mode is required."
  }
  MODE="$1"
  shift
  [[ "$MODE" == "candidate" || "$MODE" == "deployment" ]] || {
    usage
    die "Unknown verifier mode: $MODE"
  }

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --repository)
        [[ $# -ge 2 ]] || die "--repository requires a value."
        set_arg_once "--repository" "$REPOSITORY" "$2"
        REPOSITORY="$2"
        shift 2
        ;;
      --attestation)
        [[ $# -ge 2 ]] || die "--attestation requires a value."
        set_arg_once "--attestation" "$ATTESTATION" "$2"
        ATTESTATION="$2"
        shift 2
        ;;
      --challenge)
        [[ "$MODE" == "candidate" ]] || die "--challenge is only valid in candidate mode."
        [[ $# -ge 2 ]] || die "--challenge requires a value."
        set_arg_once "--challenge" "$CHALLENGE" "$2"
        CHALLENGE="$2"
        shift 2
        ;;
      --receipt-path)
        [[ "$MODE" == "candidate" ]] || die "--receipt-path is only valid in candidate mode."
        [[ $# -ge 2 ]] || die "--receipt-path requires a value."
        set_arg_once "--receipt-path" "$RECEIPT_PATH" "$2"
        RECEIPT_PATH="$2"
        shift 2
        ;;
      --preview-port)
        [[ "$MODE" == "candidate" ]] || die "--preview-port is only valid in candidate mode."
        [[ $# -ge 2 ]] || die "--preview-port requires a value."
        set_arg_once "--preview-port" "$REQUESTED_PREVIEW_PORT" "$2"
        REQUESTED_PREVIEW_PORT="$2"
        shift 2
        ;;
      --build-digest)
        [[ "$MODE" == "deployment" ]] || die "--build-digest is only valid in deployment mode."
        [[ $# -ge 2 ]] || die "--build-digest requires a value."
        set_arg_once "--build-digest" "$EXPECTED_BUILD_DIGEST" "$2"
        EXPECTED_BUILD_DIGEST="$2"
        shift 2
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        usage
        die "Unknown argument: $1"
        ;;
    esac
  done

  [[ -n "$REPOSITORY" ]] || die "--repository is required."
  [[ -n "$ATTESTATION" ]] || die "--attestation is required."
  if [[ "$MODE" == "candidate" ]]; then
    [[ -n "$CHALLENGE" ]] || die "--challenge is required in candidate mode."
    [[ -n "$RECEIPT_PATH" ]] || die "--receipt-path is required in candidate mode."
    [[ -n "$REQUESTED_PREVIEW_PORT" ]] || die "--preview-port is required in candidate mode."
  else
    [[ -n "$EXPECTED_BUILD_DIGEST" ]] || die "--build-digest is required in deployment mode."
  fi
}

ensure_private_dir() {
  local dir="$1"
  local owner=""
  local mode=""
  if [[ ! -e "$dir" ]]; then
    /bin/mkdir "$dir" || die "Could not create verifier state directory: $dir"
    /bin/chmod 700 "$dir" || die "Could not protect verifier state directory: $dir"
  fi
  [[ -d "$dir" && ! -L "$dir" ]] || die "Unsafe verifier state directory: $dir"
  owner="$(/usr/bin/stat -f '%u' "$dir")"
  mode="$(/usr/bin/stat -f '%Lp' "$dir")"
  [[ "$owner" == "$CURRENT_UID" ]] || die "Verifier state directory is not owned by the current user: $dir"
  (( (8#$mode & 077) == 0 )) || die "Verifier state directory is accessible by another user: $dir"
}

ensure_private_empty_file() {
  local file="$1"
  local mode=""
  if [[ ! -e "$file" ]]; then
    /usr/bin/touch "$file" || die "Could not create private verifier config: $file"
    /bin/chmod 600 "$file" || die "Could not protect private verifier config: $file"
  fi
  [[ -f "$file" && ! -L "$file" ]] || die "Verifier config is linked or non-regular: $file"
  [[ "$(/usr/bin/stat -f '%u' "$file")" == "$CURRENT_UID" ]] || die "Verifier config has an unknown owner: $file"
  mode="$(/usr/bin/stat -f '%Lp' "$file")"
  (( (8#$mode & 077) == 0 )) || die "Verifier config permissions are too broad: $file"
  [[ "$(/usr/bin/stat -f '%z' "$file")" == "0" ]] || die "Verifier config must remain empty: $file"
}

validate_host_and_user() {
  [[ "$(/usr/bin/uname -s)" == "Darwin" ]] || die "The Core UI verifier only supports macOS."
  CURRENT_UID="$(/usr/bin/id -u)"
  CURRENT_USER="$(/usr/bin/id -un)"
  [[ "$CURRENT_UID" != "0" ]] || die "The Core UI verifier must not run as root."
  [[ "$CURRENT_USER" == "$EXPECTED_USER" ]] \
    || die "The Core UI verifier must run as the dedicated $EXPECTED_USER account."
  ACCOUNT_HOME="$(/usr/bin/python3 - <<'PY'
import os
import pwd
print(pwd.getpwuid(os.getuid()).pw_dir)
PY
)"
  [[ -n "$ACCOUNT_HOME" && "$ACCOUNT_HOME" == /* ]] || die "Could not determine the current account home."
  [[ "$ACCOUNT_HOME" == "$EXPECTED_HOME" ]] \
    || die "The Core UI verifier account home is not the pinned studio-server home."
  [[ "$(/bin/realpath "$ACCOUNT_HOME")" == "$ACCOUNT_HOME" ]] || die "The account home must be a canonical, non-symlink path."
  [[ "$(/usr/bin/stat -f '%u' "$ACCOUNT_HOME")" == "$CURRENT_UID" ]] || die "The account home is not owned by the current user."
  [[ "${HOME:-}" == "$ACCOUNT_HOME" ]] || die "The inherited HOME does not match the current macOS account."

  ensure_private_dir "$ACCOUNT_HOME/.core-open-design"
  STATE_ROOT="$ACCOUNT_HOME/.core-open-design/core-ui-verifier"
  ensure_private_dir "$STATE_ROOT"
  ensure_private_dir "$STATE_ROOT/candidates"
  ensure_private_dir "$STATE_ROOT/deployment"
  ensure_private_dir "$STATE_ROOT/locks"
  ensure_private_dir "$STATE_ROOT/tmp"
  ensure_private_dir "$STATE_ROOT/npm-cache"
  PREVIEW_OWNER_FILE="$STATE_ROOT/preview-${PREVIEW_PORT}.json"
  NPM_USER_CONFIG="$STATE_ROOT/npm-user.conf"
  NPM_GLOBAL_CONFIG="$STATE_ROOT/npm-global.conf"
  ensure_private_empty_file "$NPM_USER_CONFIG"
  ensure_private_empty_file "$NPM_GLOBAL_CONFIG"
}

validate_repository() {
  local canonical=""
  local git_root=""
  local owner=""
  local mode=""
  [[ "$REPOSITORY" == /* ]] || die "--repository must be an absolute path."
  [[ "$REPOSITORY" == "$EXPECTED_REPOSITORY" ]] \
    || die "--repository must be the pinned live Core repository."
  [[ -d "$REPOSITORY" && ! -L "$REPOSITORY" ]] || die "Repository is missing or is a symlink: $REPOSITORY"
  canonical="$(/bin/realpath "$REPOSITORY")"
  [[ "$canonical" == "$REPOSITORY" ]] || die "--repository must be the exact canonical repository root."
  git_root="$(/usr/bin/git -C "$REPOSITORY" rev-parse --show-toplevel 2>/dev/null)" \
    || die "Repository is not a Git worktree: $REPOSITORY"
  [[ "$git_root" == "$REPOSITORY" ]] || die "--repository must name the Git worktree root."
  owner="$(/usr/bin/stat -f '%u' "$REPOSITORY")"
  [[ "$owner" == "$CURRENT_UID" ]] || die "Repository is not owned by the current user."
  mode="$(/usr/bin/stat -f '%Lp' "$REPOSITORY")"
  (( (8#$mode & 022) == 0 )) || die "Repository root is writable by another principal."
  [[ -d "$REPOSITORY/.git" && ! -L "$REPOSITORY/.git" ]] \
    || die "Repository must be the primary Core checkout, not a linked worktree."
  [[ "$(/usr/bin/stat -f '%u' "$REPOSITORY/.git")" == "$CURRENT_UID" ]] \
    || die "Repository Git directory is not owned by the current user."
  mode="$(/usr/bin/stat -f '%Lp' "$REPOSITORY/.git")"
  (( (8#$mode & 022) == 0 )) || die "Repository Git directory is writable by another principal."
  [[ "$ATTESTATION" =~ ^[a-f0-9]{40}$ ]] || die "--attestation must be one exact lowercase 40-character Git commit."
  [[ "$(/usr/bin/git -C "$REPOSITORY" rev-parse "${ATTESTATION}^{commit}" 2>/dev/null)" == "$ATTESTATION" ]] \
    || die "Attestation commit is unavailable or does not resolve exactly."
  BUILD_EPOCH="$(/usr/bin/git -C "$REPOSITORY" show -s --format=%ct "$ATTESTATION")"
  [[ "$BUILD_EPOCH" =~ ^[1-9][0-9]*$ ]] || die "Attestation commit has an invalid source date."
  /usr/bin/git -C "$REPOSITORY" cat-file -e "${ATTESTATION}:${CORE_V2_REL}/package.json" 2>/dev/null \
    || die "Attestation commit does not contain Core V2."
}

validate_runtime() {
  local node_version=""
  local npm_version=""
  [[ -x /usr/local/bin/node ]] || die "Required Node binary is missing: /usr/local/bin/node"
  [[ -x /usr/local/bin/npm ]] || die "Required npm binary is missing: /usr/local/bin/npm"
  node_version="$(/usr/local/bin/node --version)"
  npm_version="$(/usr/local/bin/npm --version)"
  [[ "$node_version" == "$EXPECTED_NODE_VERSION" ]] \
    || die "Core UI verification requires Node $EXPECTED_NODE_VERSION, found $node_version."
  [[ "$npm_version" == "$EXPECTED_NPM_VERSION" ]] \
    || die "Core UI verification requires npm $EXPECTED_NPM_VERSION, found $npm_version."
}

read_token() {
  local token_file="$ACCOUNT_HOME/.core-v2/api-token"
  local mode=""
  local owner=""
  local token=""
  [[ -f "$token_file" && ! -L "$token_file" ]] || die "Core V2 API token is missing or unsafe: $token_file"
  owner="$(/usr/bin/stat -f '%u' "$token_file")"
  mode="$(/usr/bin/stat -f '%Lp' "$token_file")"
  [[ "$owner" == "$CURRENT_UID" ]] || die "Core V2 API token is not owned by the current user."
  (( (8#$mode & 077) == 0 )) || die "Core V2 API token permissions are too broad."
  token="$(/usr/bin/tr -d '\r\n' < "$token_file")"
  [[ "$token" =~ ^[a-f0-9]{48}$ ]] || die "Core V2 API token must be one 24-byte lowercase hex token."
  printf '%s' "$token"
}

acquire_lock() {
  local existing_pid=""
  LOCK_DIR="$STATE_ROOT/locks/operation.lock"
  if ! /bin/mkdir "$LOCK_DIR" 2>/dev/null; then
    [[ -d "$LOCK_DIR" && ! -L "$LOCK_DIR" ]] || die "Verifier operation lock is unsafe."
    [[ "$(/usr/bin/stat -f '%u' "$LOCK_DIR")" == "$CURRENT_UID" ]] || die "Verifier operation lock has an unknown owner."
    if [[ -f "$LOCK_DIR/pid" && ! -L "$LOCK_DIR/pid" ]]; then
      existing_pid="$(<"$LOCK_DIR/pid")"
    fi
    if [[ "$existing_pid" =~ ^[1-9][0-9]*$ ]] && /bin/kill -0 "$existing_pid" 2>/dev/null; then
      die "Another Core UI verifier operation is already running as PID $existing_pid."
    fi
    [[ -z "$(/bin/ls -A "$LOCK_DIR" 2>/dev/null | /usr/bin/grep -v '^pid$' || true)" ]] \
      || die "Stale verifier operation lock contains unknown files."
    /bin/rm -f -- "$LOCK_DIR/pid" 2>/dev/null || true
    /bin/rmdir "$LOCK_DIR" 2>/dev/null || die "Could not recover the stale verifier operation lock."
    /bin/mkdir "$LOCK_DIR" || die "Could not acquire the verifier operation lock."
  fi
  /bin/chmod 700 "$LOCK_DIR"
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
  /bin/chmod 600 "$LOCK_DIR/pid"
  LOCK_HELD=1
}

validate_tree_blob() {
  local worktree="$1"
  local revision="$2"
  local relative="$3"
  local entry=""
  entry="$(/usr/bin/git -C "$worktree" ls-tree "$revision" -- "$relative")"
  [[ "$entry" =~ ^100644[[:space:]]blob[[:space:]][a-f0-9]{40}[[:space:]] ]] \
    || die "Git path must be one ordinary 100644 blob at the attestation commit: $relative"
  [[ "${entry#*$'\t'}" == "$relative" ]] \
    || die "Git tree path did not resolve exactly: $relative"
}

validate_tree_executable() {
  local worktree="$1"
  local revision="$2"
  local relative="$3"
  local entry=""
  entry="$(/usr/bin/git -C "$worktree" ls-tree "$revision" -- "$relative")"
  [[ "$entry" =~ ^100755[[:space:]]blob[[:space:]][a-f0-9]{40}[[:space:]] ]] \
    || die "Git path must be one ordinary executable 100755 blob at the attestation commit: $relative"
  [[ "${entry#*$'\t'}" == "$relative" ]] \
    || die "Git tree path did not resolve exactly: $relative"
}

attestation_binding() {
  local root="$1"
  local expected_challenge="$2"
  local expected_receipt="$3"
  /usr/bin/python3 - "$root" "$APP_REL" "$STATIC_ROOT" "$expected_challenge" "$expected_receipt" "$ATTESTATION" "$CORE_UI_PROJECT_ID" "$CORE_UI_TARGET_ORIGIN" <<'PY'
import json
import os
import re
import stat
import sys
from html.parser import HTMLParser

root, app_rel, static_root, expected_challenge, expected_receipt, attestation, project_id, target_origin = sys.argv[1:]
app_path = os.path.join(root, app_rel)

def ordinary_file(path, limit):
    st = os.lstat(path)
    if not stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode) or st.st_nlink != 1:
        raise SystemExit(f"unsafe or linked attestation file: {path}")
    if st.st_size <= 0 or st.st_size > limit:
        raise SystemExit(f"attestation file has an invalid size: {path}")
    return open(path, "rb").read()

app_bytes = ordinary_file(app_path, 2 * 1024 * 1024)
app = app_bytes.decode("utf-8")

class MetaParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.metas = {}
    def handle_starttag(self, tag, attrs):
        if tag.lower() != "meta":
            return
        values = {str(k).lower(): v for k, v in attrs}
        name = values.get("name")
        if name:
            self.metas.setdefault(name.lower(), []).append(values.get("content"))

parser = MetaParser()
parser.feed(app)
names = [
    "open-design-challenge",
    "open-design-design-revision",
    "open-design-implementation-commit",
    "open-design-target-origin",
    "open-design-receipt-path",
]
for name in names:
    if len(parser.metas.get(name, [])) != 1:
        raise SystemExit(f"app.html must contain exactly one {name} meta")

challenge = parser.metas["open-design-challenge"][0] or ""
public_receipt = parser.metas["open-design-receipt-path"][0] or ""
if not re.fullmatch(r"[a-f0-9]{64}", challenge):
    raise SystemExit("app.html challenge is invalid")
if expected_challenge and challenge != expected_challenge:
    raise SystemExit("app.html challenge does not match the daemon challenge")
receipt_rel = static_root + public_receipt.removeprefix("/")
required_receipt = f"{static_root}open-design/attestations/{challenge}.json"
if receipt_rel != required_receipt:
    raise SystemExit("app.html receipt path is not the challenge-bound static receipt")
if expected_receipt and receipt_rel != expected_receipt:
    raise SystemExit("app.html receipt path does not match the daemon receipt path")

receipt_bytes = ordinary_file(os.path.join(root, receipt_rel), 16 * 1024)
seen = set()
def pairs_hook(pairs):
    result = {}
    for key, value in pairs:
        if key in seen:
            raise ValueError(f"duplicate receipt key: {key}")
        seen.add(key)
        result[key] = value
    return result

try:
    receipt = json.loads(receipt_bytes, object_pairs_hook=pairs_hook)
except Exception as error:
    raise SystemExit(f"receipt is invalid JSON: {error}")

keys = [
    "schemaVersion",
    "kind",
    "challenge",
    "projectId",
    "runId",
    "designRevision",
    "baseBranch",
    "baseCommit",
    "gitRemote",
    "implementationCommit",
    "targetOrigin",
    "receiptPath",
]
if list(receipt.keys()) != keys:
    raise SystemExit("receipt keys or key order are not canonical")
if type(receipt["schemaVersion"]) is not int or receipt["schemaVersion"] != 2:
    raise SystemExit("receipt schemaVersion is invalid")
if receipt["kind"] != "open-design-core-ui-attestation":
    raise SystemExit("receipt kind is invalid")
for key in keys[2:]:
    if not isinstance(receipt[key], str):
        raise SystemExit(f"receipt field {key} must be a string")
if receipt["challenge"] != challenge:
    raise SystemExit("receipt challenge does not match app.html")
if receipt["projectId"] != project_id:
    raise SystemExit("receipt projectId is not Core UI")
if not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", receipt["runId"]):
    raise SystemExit("receipt runId is invalid")
for key in ("designRevision", "baseCommit", "implementationCommit"):
    if not re.fullmatch(r"[a-f0-9]{40}", receipt[key]):
        raise SystemExit(f"receipt {key} is not a full lowercase Git SHA")
if receipt["implementationCommit"] == attestation:
    raise SystemExit("implementation and attestation commits must be distinct")
if not receipt["baseBranch"] or any(ord(ch) < 32 or ord(ch) == 127 for ch in receipt["baseBranch"]):
    raise SystemExit("receipt baseBranch is invalid")
if not receipt["gitRemote"] or any(ord(ch) < 32 or ord(ch) == 127 for ch in receipt["gitRemote"]):
    raise SystemExit("receipt gitRemote is invalid")
if receipt["targetOrigin"] != target_origin:
    raise SystemExit("receipt targetOrigin is not the live Core UI origin")
if receipt["receiptPath"] != receipt_rel:
    raise SystemExit("receipt receiptPath does not match app.html")

expected_meta = {
    "open-design-challenge": receipt["challenge"],
    "open-design-design-revision": receipt["designRevision"],
    "open-design-implementation-commit": receipt["implementationCommit"],
    "open-design-target-origin": receipt["targetOrigin"],
    "open-design-receipt-path": public_receipt,
}
for name, value in expected_meta.items():
    if parser.metas[name][0] != value:
        raise SystemExit(f"app.html {name} is not bound to the receipt")

canonical = (json.dumps(receipt, ensure_ascii=False, indent=2, separators=(",", ": ")) + "\n").encode()
if receipt_bytes != canonical:
    raise SystemExit("receipt bytes are not canonical")

block = "\n".join([
    "    <!-- open-design-attestation:start -->",
    f'    <meta name="open-design-challenge" content="{receipt["challenge"]}" />',
    f'    <meta name="open-design-design-revision" content="{receipt["designRevision"]}" />',
    f'    <meta name="open-design-implementation-commit" content="{receipt["implementationCommit"]}" />',
    f'    <meta name="open-design-target-origin" content="{receipt["targetOrigin"]}" />',
    f'    <meta name="open-design-receipt-path" content="{public_receipt}" />',
    "    <!-- open-design-attestation:end -->",
])
if app.count("<!-- open-design-attestation:start -->") != 1 or app.count("<!-- open-design-attestation:end -->") != 1:
    raise SystemExit("app.html attestation sentinel is not unique")
if app.count(block) != 1:
    raise SystemExit("app.html attestation block is not canonical")

print("\t".join([challenge, receipt_rel, receipt["implementationCommit"]]))
PY
}

create_or_validate_candidate_worktree() {
  local candidate_dir="$STATE_ROOT/candidates/$CHALLENGE"
  local worktree="$candidate_dir/worktree"
  local root=""
  local common=""
  local expected_common=""
  ensure_private_dir "$candidate_dir"
  if [[ ! -e "$worktree" ]]; then
    log "Creating isolated candidate worktree at $ATTESTATION."
    /usr/bin/git -C "$REPOSITORY" worktree add --detach "$worktree" "$ATTESTATION" >&2 \
      || die "Could not create the isolated candidate worktree. Recover the partial worktree before retrying."
  fi
  [[ -d "$worktree" && ! -L "$worktree" ]] || die "Candidate worktree path is unsafe."
  [[ "$(/usr/bin/stat -f '%u' "$worktree")" == "$CURRENT_UID" ]] || die "Candidate worktree has an unknown owner."
  root="$(/usr/bin/git -C "$worktree" rev-parse --show-toplevel 2>/dev/null)" \
    || die "Candidate state does not contain a valid Git worktree."
  [[ "$root" == "$worktree" ]] || die "Candidate worktree root is not exact."
  [[ "$(/usr/bin/git -C "$worktree" rev-parse HEAD)" == "$ATTESTATION" ]] \
    || die "The challenge worktree is already bound to another attestation commit."
  common="$(/bin/realpath "$(/usr/bin/git -C "$worktree" rev-parse --git-common-dir)")"
  expected_common="$(/bin/realpath "$REPOSITORY/.git")"
  [[ "$common" == "$expected_common" ]] || die "Candidate worktree belongs to another repository."
  [[ -z "$(/usr/bin/git -C "$worktree" status --porcelain=v1 --untracked-files=all)" ]] \
    || die "Candidate worktree has uncommitted or untracked changes."
  printf '%s\n' "$worktree"
}

run_npm() {
  local core_dir="$1"
  local cache_dir="$2"
  shift 2
  [[ ! -e "$core_dir/.npmrc" ]] \
    || die "Core V2 verification refuses repository-controlled npm configuration."
  ensure_private_dir "$cache_dir"
  (
    cd "$core_dir"
    /usr/bin/env -i \
      HOME="$ACCOUNT_HOME" \
      USER="$CURRENT_USER" \
      LOGNAME="$CURRENT_USER" \
      PATH="$PATH" \
      LANG=C \
      LC_ALL=C \
      TZ=UTC \
      TMPDIR="$STATE_ROOT/tmp" \
      CI=1 \
      SOURCE_DATE_EPOCH="$BUILD_EPOCH" \
      CORE_V2_BUILD_VERSION="$ATTESTATION" \
      NPM_CONFIG_USERCONFIG="$NPM_USER_CONFIG" \
      NPM_CONFIG_GLOBALCONFIG="$NPM_GLOBAL_CONFIG" \
      NPM_CONFIG_CACHE="$cache_dir" \
      /usr/local/bin/npm "$@"
  ) >&2
}

assert_no_nested_mounts() {
  /usr/bin/python3 - "$1" <<'PY'
import os
import stat
import sys

root = sys.argv[1]
root_stat = os.lstat(root)
if not stat.S_ISDIR(root_stat.st_mode) or stat.S_ISLNK(root_stat.st_mode):
    raise SystemExit("removal root is linked or non-directory")
root_device = root_stat.st_dev
for current, dirs, _files in os.walk(root, topdown=True, followlinks=False):
    retained = []
    for name in dirs:
        path = os.path.join(current, name)
        value = os.lstat(path)
        if stat.S_ISLNK(value.st_mode):
            continue
        if not stat.S_ISDIR(value.st_mode):
            raise SystemExit(f"non-directory appeared in directory traversal: {path}")
        if value.st_dev != root_device:
            raise SystemExit(f"nested mount detected under removal root: {path}")
        retained.append(name)
    dirs[:] = retained
PY
}

reset_generated_web_build() {
  local root="$1"
  local web_dir="$2"
  local relative=""
  local target=""
  [[ "$web_dir" == "$root/$WEB_REL" && -d "$web_dir" && ! -L "$web_dir" ]] \
    || die "Core V2 web directory failed its generated-build reset guard."
  for relative in "$WEB_REL/.svelte-kit" "$WEB_REL/build"; do
    /usr/bin/git -C "$root" check-ignore -q -- "$relative" \
      || die "Refusing to remove a generated path that is not Git-ignored: $relative"
    target="$root/$relative"
    if [[ -e "$target" ]]; then
      [[ -d "$target" && ! -L "$target" ]] \
        || die "Generated Core V2 path is linked or non-directory: $relative"
      [[ "$(/usr/bin/stat -f '%u' "$target")" == "$CURRENT_UID" ]] \
        || die "Generated Core V2 path has an unknown owner: $relative"
      assert_no_nested_mounts "$target" \
        || die "Generated Core V2 path contains an unsafe nested mount: $relative"
      /bin/rm -rf -- "$target" \
        || die "Could not reset generated Core V2 path: $relative"
    fi
  done
}

compute_build_inventory() {
  local build_dir="$1"
  local inventory_path="$2"
  local source_root="$3"
  /usr/bin/python3 - "$build_dir" "$inventory_path" "$source_root" <<'PY'
import hashlib
import json
import os
import stat
import sys
import tempfile

root, output, source_root = sys.argv[1:]
root_stat = os.lstat(root)
if not stat.S_ISDIR(root_stat.st_mode) or stat.S_ISLNK(root_stat.st_mode):
    raise SystemExit("build output is missing or linked")
source_needle = os.path.realpath(source_root).encode()

entries = []
for current, dirs, files in os.walk(root, topdown=True, followlinks=False):
    dirs.sort()
    files.sort()
    for name in dirs:
        path = os.path.join(current, name)
        st = os.lstat(path)
        if not stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode):
            raise SystemExit(f"build contains a linked or non-directory entry: {path}")
    for name in files:
        path = os.path.join(current, name)
        st = os.lstat(path)
        if not stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode) or st.st_nlink != 1:
            raise SystemExit(f"build contains a link or non-regular file: {path}")
        rel = os.path.relpath(path, root).replace(os.sep, "/")
        if any(ch in rel for ch in ("\x00", "\n", "\r", "\t")):
            raise SystemExit("build contains an unsafe filename")
        digest = hashlib.sha256()
        found_source_path = False
        tail = b""
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
                searchable = tail + chunk
                if source_needle in searchable:
                    found_source_path = True
                tail = searchable[-max(0, len(source_needle) - 1):]
        if found_source_path:
            raise SystemExit(f"build embeds its absolute source worktree path: {path}")
        entries.append({
            "path": rel,
            "size": st.st_size,
            "sha256": digest.hexdigest(),
        })

if not entries:
    raise SystemExit("build inventory is empty")
payload = (json.dumps(entries, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
build_digest = hashlib.sha256(payload).hexdigest()
document = {
    "schemaVersion": 1,
    "algorithm": "sha256",
    "buildDigest": build_digest,
    "files": entries,
}
fd, temp = tempfile.mkstemp(prefix=".build-inventory.", dir=os.path.dirname(output), text=True)
with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
    json.dump(document, handle, ensure_ascii=False, separators=(",", ":"))
    handle.write("\n")
os.chmod(temp, 0o600)
os.replace(temp, output)
print(build_digest)
PY
}

read_preview_owner() {
  local parsed=""
  [[ -e "$PREVIEW_OWNER_FILE" ]] || return 1
  [[ -f "$PREVIEW_OWNER_FILE" && ! -L "$PREVIEW_OWNER_FILE" ]] || die "Preview owner state is unsafe."
  [[ "$(/usr/bin/stat -f '%u' "$PREVIEW_OWNER_FILE")" == "$CURRENT_UID" ]] || die "Preview owner state has an unknown owner."
  (( (8#$(/usr/bin/stat -f '%Lp' "$PREVIEW_OWNER_FILE") & 077) == 0 )) \
    || die "Preview owner state permissions are too broad."
  parsed="$(/usr/bin/python3 - "$PREVIEW_OWNER_FILE" "$STATE_ROOT/candidates" "$PREVIEW_PORT" <<'PY'
import json
import os
import re
import sys

path, candidates, port = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    value = json.load(handle)
if set(value) != {"schemaVersion", "challenge", "attestationCommit", "pid", "worktree", "port"}:
    raise SystemExit("preview owner state has unknown fields")
if value["schemaVersion"] != 1 or value["port"] != int(port):
    raise SystemExit("preview owner state schema or port is invalid")
if not re.fullmatch(r"[a-f0-9]{64}", value["challenge"]):
    raise SystemExit("preview owner challenge is invalid")
if not re.fullmatch(r"[a-f0-9]{40}", value["attestationCommit"]):
    raise SystemExit("preview owner attestation is invalid")
if type(value["pid"]) is not int or value["pid"] <= 0:
    raise SystemExit("preview owner PID is invalid")
expected = os.path.join(candidates, value["challenge"], "worktree")
if value["worktree"] != expected:
    raise SystemExit("preview owner worktree is outside verifier state")
print("\t".join([
    value["challenge"],
    value["attestationCommit"],
    str(value["pid"]),
    value["worktree"],
]))
PY
)" || die "Preview owner state is invalid."
  IFS=$'\t' read -r PREVIEW_STATE_CHALLENGE PREVIEW_STATE_ATTESTATION PREVIEW_STATE_PID PREVIEW_STATE_WORKTREE <<< "$parsed"
  [[ -n "$PREVIEW_STATE_CHALLENGE" \
    && -n "$PREVIEW_STATE_ATTESTATION" \
    && -n "$PREVIEW_STATE_PID" \
    && -n "$PREVIEW_STATE_WORKTREE" ]] \
    || die "Preview owner state could not be parsed."
}

write_preview_owner() {
  local pid="$1"
  local worktree="$2"
  local temp=""
  temp="$(/usr/bin/mktemp "$STATE_ROOT/.preview-owner.XXXXXX")" \
    || die "Could not create private preview owner state."
  append_temp_file "$temp"
  /usr/bin/python3 - "$temp" "$CHALLENGE" "$ATTESTATION" "$pid" "$worktree" "$PREVIEW_PORT" <<'PY'
import json
import os
import sys

path, challenge, attestation, pid, worktree, port = sys.argv[1:]
with open(path, "w", encoding="utf-8", newline="\n") as handle:
    json.dump({
        "schemaVersion": 1,
        "challenge": challenge,
        "attestationCommit": attestation,
        "pid": int(pid),
        "worktree": worktree,
        "port": int(port),
    }, handle, separators=(",", ":"))
    handle.write("\n")
os.chmod(path, 0o600)
PY
  /bin/mv -f -- "$temp" "$PREVIEW_OWNER_FILE"
}

remove_prior_candidate() {
  local challenge="$1"
  local worktree="$2"
  local candidate_dir="$STATE_ROOT/candidates/$challenge"
  local common=""
  local expected_common=""
  local cwd_users=""
  [[ "$challenge" =~ ^[a-f0-9]{64}$ ]] || die "Prior preview challenge is invalid."
  [[ "$challenge" != "$CHALLENGE" ]] || return 0
  [[ "$worktree" == "$candidate_dir/worktree" ]] \
    || die "Prior preview worktree is outside its exact verifier challenge directory."
  [[ -d "$candidate_dir" && ! -L "$candidate_dir" ]] \
    || die "Prior preview candidate directory is unsafe."
  [[ -d "$worktree" && ! -L "$worktree" ]] \
    || die "Prior preview worktree is unsafe."
  [[ "$(/usr/bin/stat -f '%u' "$candidate_dir")" == "$CURRENT_UID" \
    && "$(/usr/bin/stat -f '%u' "$worktree")" == "$CURRENT_UID" ]] \
    || die "Prior preview candidate has an unknown owner."
  [[ "$(/usr/bin/git -C "$worktree" rev-parse --show-toplevel 2>/dev/null)" == "$worktree" ]] \
    || die "Prior preview path is not an exact Git worktree."
  common="$(/bin/realpath "$(/usr/bin/git -C "$worktree" rev-parse --git-common-dir)")"
  expected_common="$(/bin/realpath "$REPOSITORY/.git")"
  [[ "$common" == "$expected_common" ]] \
    || die "Prior preview worktree belongs to another repository."
  cwd_users="$(/usr/sbin/lsof -n -d cwd -Fpn 2>/dev/null \
    | /usr/bin/python3 -c '
import os
import sys
root = os.path.realpath(sys.argv[1])
pid = None
matches = set()
for raw in sys.stdin:
    line = raw.rstrip("\n")
    if line.startswith("p"):
        pid = line[1:]
    elif line.startswith("n") and pid:
        cwd = os.path.realpath(line[1:])
        if cwd == root or cwd.startswith(root + os.sep):
            matches.add(pid)
print("\n".join(sorted(matches, key=int)))
' "$worktree")" || die "Could not audit processes using the prior preview worktree."
  [[ -z "$cwd_users" ]] || die "A process still has its working directory in the prior preview worktree."
  assert_no_nested_mounts "$worktree" \
    || die "Prior preview worktree contains an unsafe nested mount."
  log "Removing superseded verifier worktree for challenge $challenge."
  /usr/bin/git -C "$REPOSITORY" worktree remove --force "$worktree" >&2 \
    || die "Could not remove the superseded verifier Git worktree."
  [[ ! -e "$worktree" ]] || die "Superseded verifier worktree still exists after Git removal."
  [[ "$candidate_dir" == "$STATE_ROOT/candidates/$challenge" \
    && -d "$candidate_dir" \
    && ! -L "$candidate_dir" ]] \
    || die "Superseded candidate directory failed its final removal guard."
  assert_no_nested_mounts "$candidate_dir" \
    || die "Superseded candidate directory contains an unsafe nested mount."
  /bin/rm -rf -- "$candidate_dir" \
    || die "Could not remove the superseded verifier candidate directory."
}

inspect_existing_preview() {
  local listener=""
  local expected_cwd=""
  PREVIEW_STATE_CHALLENGE=""
  PREVIEW_STATE_ATTESTATION=""
  PREVIEW_STATE_PID=""
  PREVIEW_STATE_WORKTREE=""
  EXISTING_PREVIEW_PID=""
  EXISTING_PREVIEW_WORKTREE=""
  listener="$(listener_pids "$PREVIEW_PORT")"
  if read_preview_owner; then
    if /bin/kill -0 "$PREVIEW_STATE_PID" 2>/dev/null; then
      expected_cwd="$PREVIEW_STATE_WORKTREE/$WEB_REL"
      candidate_process_is_owned "$PREVIEW_STATE_PID" "$expected_cwd" \
      || die "Preview owner PID no longer matches the verifier-owned adapter-node process."
      [[ "$listener" == "$PREVIEW_STATE_PID" ]] || die "Preview listener does not match the verifier owner state."
      listener_is_exact "$PREVIEW_STATE_PID" "$PREVIEW_PORT" \
        || die "Verifier-owned preview is not bound exactly to 127.0.0.1:$PREVIEW_PORT."
      EXISTING_PREVIEW_PID="$PREVIEW_STATE_PID"
      EXISTING_PREVIEW_WORKTREE="$PREVIEW_STATE_WORKTREE"
      return 0
    fi
  fi

  if [[ -n "$listener" ]]; then
    die "Port $PREVIEW_PORT has a listener without a live, exact verifier owner."
  fi
  if [[ -e "$PREVIEW_OWNER_FILE" ]]; then
    /bin/rm -f -- "$PREVIEW_OWNER_FILE" \
      || die "Could not remove stale preview owner state."
  fi
  return 1
}

verify_http_binding() {
  local root_url="$1"
  local receipt_url="$2"
  local receipt_file="$3"
  local challenge="$4"
  local implementation="$5"
  local root_body=""
  local root_headers=""
  local receipt_body=""
  local receipt_headers=""
  local root_result=""
  local receipt_result=""
  local temp_dir="$6"

  root_body="$(/usr/bin/mktemp "$temp_dir/root.XXXXXX")" || return 1
  root_headers="$(/usr/bin/mktemp "$temp_dir/root-headers.XXXXXX")" || return 1
  receipt_body="$(/usr/bin/mktemp "$temp_dir/receipt.XXXXXX")" || return 1
  receipt_headers="$(/usr/bin/mktemp "$temp_dir/receipt-headers.XXXXXX")" || return 1
  append_temp_file "$root_body"
  append_temp_file "$root_headers"
  append_temp_file "$receipt_body"
  append_temp_file "$receipt_headers"

  root_result="$(/usr/bin/curl --silent --show-error --noproxy '*' --proto '=http' \
    --connect-timeout 3 --max-time 10 --max-redirs 0 --max-filesize 2097152 \
    --header 'Accept: text/html' --header 'Cache-Control: no-cache' \
    --dump-header "$root_headers" --output "$root_body" \
    --write-out $'%{http_code}\t%{content_type}' "$root_url")" \
    || return 1
  [[ "${root_result%%$'\t'*}" == "200" ]] || return 1
  case "${root_result#*$'\t'}" in
    text/html|text/html\;*) ;;
    *) return 1 ;;
  esac

  receipt_result="$(/usr/bin/curl --silent --show-error --noproxy '*' --proto '=http' \
    --connect-timeout 3 --max-time 10 --max-redirs 0 --max-filesize 16384 \
    --header 'Accept: application/json' --header 'Cache-Control: no-cache' \
    --dump-header "$receipt_headers" --output "$receipt_body" \
    --write-out $'%{http_code}\t%{content_type}' "$receipt_url")" \
    || return 1
  [[ "${receipt_result%%$'\t'*}" == "200" ]] || return 1
  case "${receipt_result#*$'\t'}" in
    application/json|application/json\;*) ;;
    *) return 1 ;;
  esac

  /usr/bin/python3 - "$root_body" "$receipt_body" "$receipt_file" "$challenge" "$implementation" "$CORE_UI_TARGET_ORIGIN" <<'PY'
import json
import sys
from html.parser import HTMLParser

root_path, served_path, expected_path, challenge, implementation, target_origin = sys.argv[1:]
served = open(served_path, "rb").read()
expected = open(expected_path, "rb").read()
if served != expected:
    raise SystemExit("served receipt bytes do not match the attestation commit")
receipt = json.loads(expected)
if receipt.get("challenge") != challenge:
    raise SystemExit("expected receipt challenge does not match verifier input")
if receipt.get("implementationCommit") != implementation:
    raise SystemExit("expected receipt implementation commit does not match verifier input")
if receipt.get("targetOrigin") != target_origin:
    raise SystemExit("expected receipt target origin is not Core UI")

class Parser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.metas = {}
    def handle_starttag(self, tag, attrs):
        if tag.lower() != "meta":
            return
        values = {str(k).lower(): v for k, v in attrs}
        name = values.get("name")
        if name:
            self.metas.setdefault(name.lower(), []).append(values.get("content"))

parser = Parser()
parser.feed(open(root_path, "r", encoding="utf-8").read())
receipt_public = f"/open-design/attestations/{challenge}.json"
expected_metas = {
    "open-design-challenge": receipt["challenge"],
    "open-design-design-revision": receipt["designRevision"],
    "open-design-implementation-commit": receipt["implementationCommit"],
    "open-design-target-origin": receipt["targetOrigin"],
    "open-design-receipt-path": receipt_public,
}
for name, value in expected_metas.items():
    if parser.metas.get(name) != [value]:
        raise SystemExit(f"served root has an invalid {name} binding")
PY
}

wait_for_exact_listener() {
  local pid="$1"
  local port="$2"
  local cwd="$3"
  local attempt=""
  for attempt in $(/usr/bin/jot 120 1); do
    if candidate_process_is_owned "$pid" "$cwd" \
      && [[ "$(listener_pids "$port")" == "$pid" ]] \
      && listener_is_exact "$pid" "$port"; then
      return 0
    fi
    if ! /bin/kill -0 "$pid" 2>/dev/null; then
      return 1
    fi
    /bin/sleep 0.25
  done
  return 1
}

emit_candidate_success() {
  local digest="$1"
  local pid="$2"
  /usr/bin/python3 - "$ATTESTATION" "$digest" "$pid" <<'PY'
import json
import sys

commit, digest, pid = sys.argv[1:]
checks = [
    {"name": "check", "status": "passed"},
    {"name": "test", "status": "passed"},
    {"name": "build", "status": "passed"},
    {"name": "browser", "status": "passed"},
]
print(json.dumps({
    "schemaVersion": 1,
    "mode": "candidate",
    "attestationCommit": commit,
    "buildDigest": digest,
    "checks": checks,
    "pid": int(pid),
}, separators=(",", ":")))
PY
}

run_candidate() {
  local worktree=""
  local core_dir=""
  local web_dir=""
  local binding=""
  local binding_challenge=""
  local binding_receipt=""
  local binding_implementation=""
  local receipt_file=""
  local candidate_dir=""
  local npm_cache=""
  local inventory=""
  local first_inventory=""
  local first_build_digest=""
  local build_digest=""
  local existing_pid=""
  local existing_worktree=""
  local existing_challenge=""
  local preview_cwd=""
  local preview_log=""
  local preview_pid=""
  local receipt_public=""

  [[ "$CHALLENGE" =~ ^[a-f0-9]{64}$ ]] || die "--challenge must be one exact lowercase 64-character value."
  [[ "$REQUESTED_PREVIEW_PORT" == "$PREVIEW_PORT" ]] \
    || die "Candidate preview must use exact loopback port $PREVIEW_PORT."
  [[ "$RECEIPT_PATH" == "${RECEIPT_PREFIX}${CHALLENGE}.json" ]] \
    || die "--receipt-path must be the exact challenge-bound Core V2 static receipt."
  [[ -z "$(listener_pids "$PREVIEW_DEAD_API_PORT")" ]] \
    || die "Candidate dead API loopback port $PREVIEW_DEAD_API_PORT unexpectedly has a listener."
  worktree="$(create_or_validate_candidate_worktree)"
  core_dir="$worktree/$CORE_V2_REL"
  web_dir="$worktree/$WEB_REL"
  candidate_dir="$STATE_ROOT/candidates/$CHALLENGE"
  npm_cache="$STATE_ROOT/npm-cache"
  inventory="$candidate_dir/build-inventory.json"
  first_inventory="$candidate_dir/build-inventory.first.json"
  receipt_file="$worktree/$RECEIPT_PATH"

  validate_tree_blob "$worktree" "$ATTESTATION" "$APP_REL"
  validate_tree_blob "$worktree" "$ATTESTATION" "$RECEIPT_PATH"
  binding="$(attestation_binding "$worktree" "$CHALLENGE" "$RECEIPT_PATH")" \
    || die "Candidate attestation source or receipt is invalid."
  IFS=$'\t' read -r binding_challenge binding_receipt binding_implementation <<< "$binding"
  [[ "$binding_challenge" == "$CHALLENGE" && "$binding_receipt" == "$RECEIPT_PATH" ]] \
    || die "Candidate attestation binding did not round-trip exactly."

  if inspect_existing_preview; then
    existing_challenge="$PREVIEW_STATE_CHALLENGE"
    existing_pid="$EXISTING_PREVIEW_PID"
    existing_worktree="$EXISTING_PREVIEW_WORKTREE"
  fi

  if [[ -n "$existing_pid" && "$existing_worktree" == "$worktree" ]]; then
    stop_owned_candidate_process "$existing_pid" "$worktree/$WEB_REL"
    /bin/rm -f -- "$PREVIEW_OWNER_FILE"
    existing_pid=""
    existing_worktree=""
  fi

  log "Installing exact Core V2 dependencies."
  run_npm "$core_dir" "$npm_cache" ci --no-audit --no-fund \
    || die "npm ci failed for the candidate attestation."
  log "Running Core V2 checks."
  run_npm "$core_dir" "$npm_cache" run check \
    || die "npm run check failed for the candidate attestation."
  log "Running Core V2 tests."
  run_npm "$core_dir" "$npm_cache" test \
    || die "npm test failed for the candidate attestation."

  log "Building the adapter-node Core UI candidate."
  reset_generated_web_build "$worktree" "$web_dir"
  run_npm "$core_dir" "$npm_cache" run web:build \
    || die "npm run web:build failed for the candidate attestation."
  log "Running Core V2 browser tests in CI mode."
  run_npm "$core_dir" "$npm_cache" run test:browser \
    || die "Core V2 browser tests failed for the candidate attestation."
  [[ -z "$(/usr/bin/git -C "$worktree" status --porcelain=v1 --untracked-files=all)" ]] \
    || die "Candidate verification changed tracked or untracked source files."

  first_build_digest="$(compute_build_inventory "$web_dir/build" "$first_inventory" "$worktree")" \
    || die "Could not create a safe deterministic candidate build inventory."
  [[ "$first_build_digest" =~ ^[a-f0-9]{64}$ ]] || die "Candidate first build digest is invalid."
  log "Rebuilding once to prove deterministic candidate output."
  reset_generated_web_build "$worktree" "$web_dir"
  run_npm "$core_dir" "$npm_cache" run web:build \
    || die "Candidate deterministic rebuild failed."
  [[ -z "$(/usr/bin/git -C "$worktree" status --porcelain=v1 --untracked-files=all)" ]] \
    || die "Candidate deterministic rebuild changed tracked or untracked source files."
  build_digest="$(compute_build_inventory "$web_dir/build" "$inventory" "$worktree")" \
    || die "Could not create the final safe candidate build inventory."
  [[ "$build_digest" =~ ^[a-f0-9]{64}$ ]] || die "Candidate build digest is invalid."
  [[ "$build_digest" == "$first_build_digest" ]] \
    || die "Two clean candidate builds produced different SHA-256 inventories."

  if [[ -n "$existing_pid" ]]; then
    stop_owned_candidate_process "$existing_pid" "$existing_worktree/$WEB_REL"
    /bin/rm -f -- "$PREVIEW_OWNER_FILE"
  fi
  [[ -z "$(listener_pids "$PREVIEW_PORT")" ]] || die "Port $PREVIEW_PORT was claimed before candidate preview startup."

  preview_cwd="$web_dir"
  preview_log="$candidate_dir/preview.log"
  if [[ -e "$preview_log" ]]; then
    [[ -f "$preview_log" && ! -L "$preview_log" ]] || die "Candidate preview log path is unsafe."
    [[ "$(/usr/bin/stat -f '%u' "$preview_log")" == "$CURRENT_UID" ]] || die "Candidate preview log has an unknown owner."
  fi
  : > "$preview_log"
  /bin/chmod 600 "$preview_log"

  log "Starting exact adapter-node preview on 127.0.0.1:$PREVIEW_PORT."
  (
    cd "$preview_cwd"
    exec /usr/bin/env -i \
      HOME="$ACCOUNT_HOME" \
      USER="$CURRENT_USER" \
      LOGNAME="$CURRENT_USER" \
      PATH="$PATH" \
      LANG=C \
      LC_ALL=C \
      TZ=UTC \
      TMPDIR="$STATE_ROOT/tmp" \
      HOST="127.0.0.1" \
      PORT="$PREVIEW_PORT" \
      ORIGIN="$CORE_UI_PREVIEW_ORIGIN" \
      CORE_V2_API_BASE="http://127.0.0.1:$PREVIEW_DEAD_API_PORT" \
      CORE_V2_WEB_ORIGIN="$CORE_UI_PREVIEW_ORIGIN" \
      CORE_V2_WEB_ORIGINS="$CORE_UI_PREVIEW_ORIGIN,http://127.0.0.1:$PREVIEW_PORT,http://localhost:$PREVIEW_PORT" \
      BODY_SIZE_LIMIT="256K" \
      SHUTDOWN_TIMEOUT="5" \
      /usr/bin/nohup /usr/local/bin/node build
  ) </dev/null >>"$preview_log" 2>&1 &
  preview_pid=$!
  STARTED_PREVIEW_PID="$preview_pid"
  STARTED_PREVIEW_CWD="$preview_cwd"
  wait_for_exact_listener "$preview_pid" "$PREVIEW_PORT" "$preview_cwd" \
    || die "Candidate preview did not become the exact loopback listener."
  write_preview_owner "$preview_pid" "$worktree"

  receipt_public="/${RECEIPT_PATH#"$STATIC_ROOT"}"
  verify_http_binding \
    "http://127.0.0.1:$PREVIEW_PORT/" \
    "http://127.0.0.1:$PREVIEW_PORT$receipt_public" \
    "$receipt_file" \
    "$binding_challenge" \
    "$binding_implementation" \
    "$candidate_dir" \
    || die "Candidate preview root or receipt verification failed."

  read_preview_owner || die "Candidate preview owner state disappeared after verification."
  [[ "$PREVIEW_STATE_CHALLENGE" == "$CHALLENGE" \
    && "$PREVIEW_STATE_ATTESTATION" == "$ATTESTATION" \
    && "$PREVIEW_STATE_PID" == "$preview_pid" \
    && "$PREVIEW_STATE_WORKTREE" == "$worktree" ]] \
    || die "Candidate preview owner state changed after verification."

  if [[ -n "$existing_challenge" && -n "$existing_worktree" ]]; then
    remove_prior_candidate "$existing_challenge" "$existing_worktree"
  fi

  SUCCESS=1
  emit_candidate_success "$build_digest" "$preview_pid"
}

validate_installed_service() {
  local label="$1"
  local launch_script="$2"
  local plist="/Library/LaunchDaemons/${label}.plist"
  [[ -f "$plist" && ! -L "$plist" ]] || die "Required system LaunchDaemon plist is missing or unsafe: $plist"
  [[ "$(/usr/bin/stat -f '%u:%g' "$plist")" == "0:0" ]] || die "System LaunchDaemon plist must be owned by root:wheel: $plist"
  (( (8#$(/usr/bin/stat -f '%Lp' "$plist") & 022) == 0 )) || die "System LaunchDaemon plist is writable by a non-root principal: $plist"
  /usr/bin/python3 - "$plist" "$label" "$launch_script" "$REPOSITORY/$CORE_V2_REL" "$CURRENT_USER" <<'PY'
import plistlib
import sys

path, label, launch_script, working_directory, user = sys.argv[1:]
with open(path, "rb") as handle:
    value = plistlib.load(handle)
if value.get("Label") != label:
    raise SystemExit("LaunchDaemon label mismatch")
if value.get("ProgramArguments") != [launch_script]:
    raise SystemExit("LaunchDaemon program mismatch")
if value.get("WorkingDirectory") != working_directory:
    raise SystemExit("LaunchDaemon working directory mismatch")
if value.get("UserName") != user:
    raise SystemExit("LaunchDaemon user mismatch")
if value.get("RunAtLoad") is not True or value.get("KeepAlive") is not True:
    raise SystemExit("LaunchDaemon persistence settings are invalid")
PY
}

try_service_pid() {
  local label="$1"
  local expected_program="$2"
  local output=""
  local pid=""
  output="$(/bin/launchctl print "system/$label" 2>/dev/null)" \
    || return 1
  printf '%s\n' "$output" | /usr/bin/grep -Fq "path = /Library/LaunchDaemons/${label}.plist" \
    || return 1
  printf '%s\n' "$output" | /usr/bin/grep -Fq "program = $expected_program" \
    || return 1
  printf '%s\n' "$output" | /usr/bin/grep -Fq "username = $CURRENT_USER" \
    || return 1
  pid="$(printf '%s\n' "$output" | /usr/bin/awk '/^[[:space:]]*pid = [0-9]+$/ { print $3; exit }')"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s\n' "$pid"
}

service_pid() {
  local pid=""
  pid="$(try_service_pid "$1" "$2")" \
    || die "Required system LaunchDaemon is missing, changed, or has no running PID: $1"
  printf '%s\n' "$pid"
}

try_wait_for_existing_service_pid() {
  local label="$1"
  local program="$2"
  local attempt=""
  local pid=""
  for attempt in $(/usr/bin/jot 120 1); do
    pid="$(try_service_pid "$label" "$program" 2>/dev/null || true)"
    if [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
      printf '%s\n' "$pid"
      return 0
    fi
    /bin/sleep 0.25
  done
  return 1
}

wait_for_existing_service_pid() {
  try_wait_for_existing_service_pid "$1" "$2" \
    || die "System LaunchDaemon $1 has no recoverable wrapper PID; administrator recovery is required."
}

try_exact_live_listener() {
  local port="$1"
  local expected_cwd="$2"
  local service_pid="${3:-}"
  local pid=""
  pid="$(single_listener_pid "$port")" || return 1
  live_listener_process_is_exact "$pid" "$port" "$expected_cwd" || return 1
  listener_is_exact "$pid" "$port" || return 1
  if [[ -n "$service_pid" ]]; then
    process_descends_from "$pid" "$service_pid" || return 1
  fi
  printf '%s\n' "$pid"
}

try_optional_owned_listener() {
  local port="$1"
  local expected_cwd="$2"
  local service_pid="$3"
  local pids=""
  local count=""
  pids="$(listener_pids "$port" 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    printf '0\n'
    return 0
  fi
  count="$(printf '%s\n' "$pids" | /usr/bin/awk 'NF { count++ } END { print count + 0 }')"
  [[ "$count" == "1" ]] || return 1
  live_listener_process_is_exact "$pids" "$port" "$expected_cwd" || return 1
  listener_is_exact "$pids" "$port" || return 1
  process_descends_from "$pids" "$service_pid" || return 1
  printf '%s\n' "$pids"
}

try_terminate_owned_service() {
  local label="$1"
  local program="$2"
  local expected_pid="$3"
  local core_dir="$4"
  local command_fragment="$5"
  local current_pid=""
  local command=""
  current_pid="$(try_service_pid "$label" "$program")" || return 1
  [[ "$current_pid" == "$expected_pid" ]] || return 1
  [[ "$(process_uid "$expected_pid")" == "$CURRENT_UID" ]] || return 1
  [[ "$(process_cwd "$expected_pid")" == "$core_dir" ]] || return 1
  [[ "$(/bin/ps -p "$expected_pid" -o ppid= | /usr/bin/awk '{$1=$1; print}')" == "1" ]] \
    || return 1
  command="$(process_command "$expected_pid")"
  [[ "$command" == *"node scripts/run-with-rotating-logs.mjs"* \
    && "$command" == *"$command_fragment"* ]] \
    || return 1
  /bin/kill -TERM "$expected_pid"
}

validate_live_listener() {
  local port="$1"
  local expected_cwd="$2"
  local service_pid="${3:-}"
  local pid=""
  pid="$(try_exact_live_listener "$port" "$expected_cwd" "$service_pid")" \
    || die "Port $port listener is missing or has an unexpected owner, command, binding, or service ancestry."
  printf '%s\n' "$pid"
}

optional_owned_listener() {
  local port="$1"
  local expected_cwd="$2"
  local service_pid="$3"
  local pid=""
  pid="$(try_optional_owned_listener "$port" "$expected_cwd" "$service_pid")" \
    || die "Port $port has a foreign, multiple, or malformed listener."
  printf '%s\n' "$pid"
}

terminate_owned_service() {
  local label="$1"
  local program="$2"
  local expected_pid="$3"
  local core_dir="$4"
  local command_fragment="$5"
  try_terminate_owned_service "$label" "$program" "$expected_pid" "$core_dir" "$command_fragment" \
    || die "Could not send SIGTERM to the exact owned service PID for $label."
}

wait_for_service_turnover() {
  local label="$1"
  local program="$2"
  local port="$3"
  local cwd="$4"
  local old_service_pid="$5"
  local old_listener_pid="$6"
  local attempt=""
  local new_service_pid=""
  local new_listener_pid=""
  for attempt in $(/usr/bin/jot 240 1); do
    new_service_pid="$(try_service_pid "$label" "$program" 2>/dev/null || true)"
    new_listener_pid="$(single_listener_pid "$port" 2>/dev/null || true)"
    if [[ "$new_service_pid" =~ ^[1-9][0-9]*$ \
      && "$new_listener_pid" =~ ^[1-9][0-9]*$ \
      && "$new_service_pid" != "$old_service_pid" \
      && "$new_listener_pid" != "$old_listener_pid" \
      ]] \
      && live_listener_process_is_exact "$new_listener_pid" "$port" "$cwd" \
      && listener_is_exact "$new_listener_pid" "$port" \
      && process_descends_from "$new_listener_pid" "$new_service_pid"; then
      printf '%s\t%s\n' "$new_service_pid" "$new_listener_pid"
      return 0
    fi
    /bin/sleep 0.25
  done
  return 1
}

verify_api_readiness() {
  local token="$1"
  local temp_dir="$2"
  local body_file=""
  local result=""
  body_file="$(/usr/bin/mktemp "$temp_dir/api-ready.XXXXXX")" || return 1
  append_temp_file "$body_file"
  result="$(printf 'header = "Authorization: Bearer %s"\n' "$token" \
    | /usr/bin/curl --config - --silent --show-error --noproxy '*' --proto '=http' \
      --connect-timeout 3 --max-time 15 --max-redirs 0 --max-filesize 262144 \
      --header 'Accept: application/json' \
      --output "$body_file" --write-out $'%{http_code}\t%{content_type}' \
      "http://127.0.0.1:$API_PORT/api/status/ready")" \
    || return 1
  [[ "${result%%$'\t'*}" == "200" ]] || return 1
  case "${result#*$'\t'}" in
    application/json|application/json\;*) ;;
    *) return 1 ;;
  esac
  /usr/bin/python3 - "$body_file" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)
if value.get("status") != "ready" or value.get("ready") is not True:
    raise SystemExit("Core V2 API is not ready")
PY
}

emit_deployment_success() {
  local digest="$1"
  local api_listener_pid="$2"
  local web_listener_pid="$3"
  /usr/bin/python3 - "$ATTESTATION" "$digest" "$api_listener_pid" "$web_listener_pid" <<'PY'
import json
import sys

commit, digest, api_listener, web_listener = sys.argv[1:]
print(json.dumps({
    "schemaVersion": 1,
    "mode": "deployment",
    "attestationCommit": commit,
    "buildDigest": digest,
    "pids": {
        "api": int(api_listener),
        "web": int(web_listener),
    },
}, separators=(",", ":")))
PY
}

processes_using_tree() {
  /usr/sbin/lsof -n -d cwd -Fpn 2>/dev/null \
    | /usr/bin/python3 -c '
import os
import sys
root = os.path.realpath(sys.argv[1])
pid = None
matches = set()
for raw in sys.stdin:
    line = raw.rstrip("\n")
    if line.startswith("p"):
        pid = line[1:]
    elif line.startswith("n") and pid:
        cwd = os.path.realpath(line[1:])
        if cwd == root or cwd.startswith(root + os.sep):
            matches.add(pid)
print("\n".join(sorted(matches, key=int)))
' "$1"
}

create_or_validate_deployment_worktree() {
  local deployment_dir="$STATE_ROOT/deployment"
  local worktree="$deployment_dir/worktree"
  local root=""
  local common=""
  local expected_common=""
  local users=""
  if [[ -e "$worktree" ]]; then
    [[ -d "$worktree" && ! -L "$worktree" ]] \
      || die "Deployment worktree path is linked or non-directory."
    [[ "$(/usr/bin/stat -f '%u' "$worktree")" == "$CURRENT_UID" ]] \
      || die "Deployment worktree has an unknown owner."
    root="$(/usr/bin/git -C "$worktree" rev-parse --show-toplevel 2>/dev/null)" \
      || die "Deployment state contains an invalid Git worktree."
    [[ "$root" == "$worktree" ]] || die "Deployment worktree root is not exact."
    common="$(/bin/realpath "$(/usr/bin/git -C "$worktree" rev-parse --git-common-dir)")"
    expected_common="$(/bin/realpath "$REPOSITORY/.git")"
    [[ "$common" == "$expected_common" ]] \
      || die "Deployment worktree belongs to another repository."
    if [[ "$(/usr/bin/git -C "$worktree" rev-parse HEAD)" != "$ATTESTATION" ]]; then
      users="$(processes_using_tree "$worktree")" \
        || die "Could not audit the previous deployment worktree."
      [[ -z "$users" ]] \
        || die "A process still uses the previous deployment worktree."
      assert_no_nested_mounts "$worktree" \
        || die "Previous deployment worktree contains an unsafe nested mount."
      log "Replacing the verifier deployment worktree with attestation $ATTESTATION."
      /usr/bin/git -C "$REPOSITORY" worktree remove --force "$worktree" >&2 \
        || die "Could not remove the previous verifier deployment worktree."
      [[ ! -e "$worktree" ]] \
        || die "Previous verifier deployment worktree still exists after removal."
    fi
  fi
  if [[ ! -e "$worktree" ]]; then
    log "Creating isolated deployment worktree at $ATTESTATION."
    /usr/bin/git -C "$REPOSITORY" worktree add --detach "$worktree" "$ATTESTATION" >&2 \
      || die "Could not create the isolated deployment worktree."
  fi
  [[ -d "$worktree" && ! -L "$worktree" ]] \
    || die "Deployment worktree is unavailable after creation."
  [[ "$(/usr/bin/git -C "$worktree" rev-parse --show-toplevel 2>/dev/null)" == "$worktree" ]] \
    || die "Deployment worktree root changed unexpectedly."
  [[ "$(/usr/bin/git -C "$worktree" rev-parse HEAD)" == "$ATTESTATION" ]] \
    || die "Deployment worktree is not at the exact attestation commit."
  [[ -z "$(/usr/bin/git -C "$worktree" status --porcelain=v1 --untracked-files=all)" ]] \
    || die "Deployment worktree has tracked or untracked changes."
  printf '%s\n' "$worktree"
}

directory_inventory_digest() {
  /usr/bin/python3 - "$1" <<'PY'
import hashlib
import json
import os
import stat
import sys

root = sys.argv[1]
root_stat = os.lstat(root)
if not stat.S_ISDIR(root_stat.st_mode) or stat.S_ISLNK(root_stat.st_mode):
    raise SystemExit("build directory is missing or linked")
entries = []
for current, dirs, files in os.walk(root, topdown=True, followlinks=False):
    dirs.sort()
    files.sort()
    for name in dirs:
        path = os.path.join(current, name)
        value = os.lstat(path)
        if not stat.S_ISDIR(value.st_mode) or stat.S_ISLNK(value.st_mode):
            raise SystemExit(f"build contains linked or non-directory entry: {path}")
    for name in files:
        path = os.path.join(current, name)
        value = os.lstat(path)
        if not stat.S_ISREG(value.st_mode) or stat.S_ISLNK(value.st_mode) or value.st_nlink != 1:
            raise SystemExit(f"build contains linked or non-regular entry: {path}")
        rel = os.path.relpath(path, root).replace(os.sep, "/")
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        entries.append({"path": rel, "size": value.st_size, "sha256": digest.hexdigest()})
if not entries:
    raise SystemExit("build inventory is empty")
payload = (json.dumps(entries, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
print(hashlib.sha256(payload).hexdigest())
PY
}

remove_private_build_dir() {
  local path="$1"
  local expected="$2"
  [[ "$path" == "$expected" ]] || die "Private build removal path is not exact."
  [[ -e "$path" ]] || return 0
  [[ -d "$path" && ! -L "$path" ]] \
    || die "Private build removal path is linked or non-directory."
  [[ "$(/usr/bin/stat -f '%u' "$path")" == "$CURRENT_UID" ]] \
    || die "Private build removal path has an unknown owner."
  assert_no_nested_mounts "$path" \
    || die "Private build removal path contains an unsafe nested mount."
  /bin/rm -rf -- "$path" \
    || die "Could not remove private verifier build state."
}

stage_deployment_build() {
  local source="$1"
  local target="$2"
  local inventory="$3"
  local expected_digest="$4"
  local source_root="$5"
  local copied_digest=""
  [[ -d "$source" && ! -L "$source" ]] \
    || die "Verified deployment build source is missing or unsafe."
  remove_private_build_dir "$target" "$STATE_ROOT/deployment/swap-build"
  /bin/cp -pR "$source" "$target" \
    || die "Could not stage the verified deployment build."
  [[ -d "$target" && ! -L "$target" ]] \
    || die "Staged deployment build is missing or unsafe."
  copied_digest="$(compute_build_inventory "$target" "$inventory" "$source_root")" \
    || die "Could not inventory the staged deployment build."
  [[ "$copied_digest" == "$expected_digest" ]] \
    || die "Staged deployment build does not match the verified worktree build."
}

write_swap_state() {
  local state_file="$1"
  local phase="$2"
  local live_build="$3"
  local swap_build="$4"
  local api_service_pid="$5"
  local api_listener_pid="$6"
  local web_service_pid="$7"
  local web_listener_pid="$8"
  [[ "$SWAP_STATE_PRIOR_DIGEST" =~ ^[a-f0-9]{64}$ ]] || return 1
  /usr/bin/python3 - \
    "$state_file" "$phase" "$ATTESTATION" "$EXPECTED_BUILD_DIGEST" "$SWAP_STATE_PRIOR_DIGEST" \
    "$live_build" "$swap_build" "$api_service_pid" "$api_listener_pid" \
    "$web_service_pid" "$web_listener_pid" <<'PY'
import json
import os
import tempfile
import sys

(path, phase, attestation, digest, prior_digest, live_build, swap_build,
 api_service, api_listener, web_service, web_listener) = sys.argv[1:]
document = {
    "schemaVersion": 1,
    "phase": phase,
    "attestationCommit": attestation,
    "buildDigest": digest,
    "priorBuildDigest": prior_digest,
    "liveBuild": live_build,
    "swapBuild": swap_build,
    "apiServicePid": int(api_service),
    "apiListenerPid": int(api_listener),
    "webServicePid": int(web_service),
    "webListenerPid": int(web_listener),
}
directory = os.path.dirname(path)
fd, temporary = tempfile.mkstemp(prefix=".swap-state.", dir=directory, text=True)
try:
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(document, handle, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
    directory_fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY
}

read_swap_state() {
  local state_file="$1"
  local live_build="$2"
  local swap_build="$3"
  local parsed=""
  [[ -e "$state_file" ]] || return 1
  [[ -f "$state_file" && ! -L "$state_file" ]] \
    || die "Deployment swap state is linked or non-regular."
  [[ "$(/usr/bin/stat -f '%u' "$state_file")" == "$CURRENT_UID" ]] \
    || die "Deployment swap state has an unknown owner."
  parsed="$(/usr/bin/python3 - "$state_file" "$live_build" "$swap_build" <<'PY'
import json
import re
import sys

path, expected_live, expected_swap = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    value = json.load(handle)
expected_keys = {
    "schemaVersion", "phase", "attestationCommit", "buildDigest", "priorBuildDigest",
    "liveBuild", "swapBuild", "apiServicePid", "apiListenerPid",
    "webServicePid", "webListenerPid",
}
if set(value) != expected_keys or value.get("schemaVersion") != 1:
    raise SystemExit("swap state schema is invalid")
if value.get("phase") not in {"prepared", "swapped", "rollback_pending", "rollback_swapped", "committed"}:
    raise SystemExit("swap state phase is invalid")
if not re.fullmatch(r"[a-f0-9]{40}", value.get("attestationCommit", "")):
    raise SystemExit("swap state attestation is invalid")
if not re.fullmatch(r"[a-f0-9]{64}", value.get("buildDigest", "")):
    raise SystemExit("swap state digest is invalid")
if not re.fullmatch(r"[a-f0-9]{64}", value.get("priorBuildDigest", "")):
    raise SystemExit("swap state prior digest is invalid")
if value.get("liveBuild") != expected_live or value.get("swapBuild") != expected_swap:
    raise SystemExit("swap state paths are invalid")
for key in ("apiServicePid", "apiListenerPid", "webServicePid"):
    if type(value.get(key)) is not int or value[key] <= 0:
        raise SystemExit(f"swap state {key} is invalid")
if type(value.get("webListenerPid")) is not int or value["webListenerPid"] < 0:
    raise SystemExit("swap state webListenerPid is invalid")
print("\t".join(str(value[key]) for key in (
    "phase", "attestationCommit", "buildDigest", "priorBuildDigest", "liveBuild", "swapBuild",
    "apiServicePid", "apiListenerPid", "webServicePid", "webListenerPid",
)))
PY
)" || die "Deployment swap state is invalid."
  IFS=$'\t' read -r \
    SWAP_STATE_PHASE SWAP_STATE_ATTESTATION SWAP_STATE_DIGEST SWAP_STATE_PRIOR_DIGEST \
    SWAP_STATE_LIVE_BUILD SWAP_STATE_SWAP_BUILD \
    SWAP_STATE_API_SERVICE_PID SWAP_STATE_API_LISTENER_PID \
    SWAP_STATE_WEB_SERVICE_PID SWAP_STATE_WEB_LISTENER_PID <<< "$parsed"
}

delete_swap_state() {
  local state_file="$1"
  [[ -e "$state_file" ]] || return 0
  [[ -f "$state_file" && ! -L "$state_file" ]] \
    || die "Deployment swap state became unsafe before deletion."
  /bin/rm -f -- "$state_file" \
    || die "Could not remove deployment swap state."
  /usr/bin/python3 - "$(/usr/bin/dirname "$state_file")" <<'PY'
import os
import sys
fd = os.open(sys.argv[1], os.O_RDONLY)
try:
    os.fsync(fd)
finally:
    os.close(fd)
PY
}

atomic_exchange_directories() {
  local left="$1"
  local right="$2"
  [[ -d "$left" && ! -L "$left" && -d "$right" && ! -L "$right" ]] \
    || return 1
  [[ "$(/usr/bin/stat -f '%d' "$left")" == "$(/usr/bin/stat -f '%d' "$right")" ]] \
    || return 1
  /usr/bin/python3 - "$left" "$right" <<'PY'
import ctypes
import errno
import os
import sys

left, right = (os.fsencode(value) for value in sys.argv[1:])
libc = ctypes.CDLL(None, use_errno=True)
renameatx_np = libc.renameatx_np
renameatx_np.argtypes = [
    ctypes.c_int, ctypes.c_char_p,
    ctypes.c_int, ctypes.c_char_p,
    ctypes.c_uint,
]
renameatx_np.restype = ctypes.c_int
AT_FDCWD = -2
RENAME_SWAP = 0x00000002
if renameatx_np(AT_FDCWD, left, AT_FDCWD, right, RENAME_SWAP) != 0:
    error = ctypes.get_errno()
    raise OSError(error, os.strerror(error))
for directory in {os.path.dirname(os.fsdecode(left)), os.path.dirname(os.fsdecode(right))}:
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        try:
            os.fsync(descriptor)
        except OSError as error:
            if error.errno not in {errno.EINVAL, errno.ENOTSUP}:
                raise
    finally:
        os.close(descriptor)
PY
}

verify_generic_web_readiness() {
  local temp_dir="$1"
  local body=""
  local result=""
  body="$(/usr/bin/mktemp "$temp_dir/web-ready.XXXXXX")" || return 1
  append_temp_file "$body"
  result="$(/usr/bin/curl --silent --show-error --noproxy '*' --proto '=http' \
    --connect-timeout 3 --max-time 10 --max-redirs 0 --max-filesize 2097152 \
    --header 'Accept: text/html' --header 'Cache-Control: no-cache' \
    --output "$body" --write-out $'%{http_code}\t%{content_type}' \
    "http://127.0.0.1:$WEB_PORT/")" || return 1
  [[ "${result%%$'\t'*}" == "200" ]] || return 1
  case "${result#*$'\t'}" in
    text/html|text/html\;*) return 0 ;;
    *) return 1 ;;
  esac
}

try_api_unchanged_and_ready() {
  local expected_service="$1"
  local expected_listener="$2"
  local api_label="$3"
  local api_program="$4"
  local api_cwd="$5"
  local token="$6"
  local temp_dir="$7"
  local current_service=""
  local current_listener=""
  current_service="$(try_service_pid "$api_label" "$api_program")" || return 1
  [[ "$current_service" == "$expected_service" ]] || return 1
  current_listener="$(try_exact_live_listener "$API_PORT" "$api_cwd" "$current_service")" \
    || return 1
  [[ "$current_listener" == "$expected_listener" ]] || return 1
  verify_api_readiness "$token" "$temp_dir" || return 1
  DEPLOY_RESULT_API_SERVICE_PID="$current_service"
  DEPLOY_RESULT_API_PID="$current_listener"
}

try_current_api_ready() {
  local api_label="$1"
  local api_program="$2"
  local api_cwd="$3"
  local token="$4"
  local temp_dir="$5"
  local current_service=""
  local current_listener=""
  current_service="$(try_wait_for_existing_service_pid "$api_label" "$api_program")" \
    || return 1
  current_listener="$(try_exact_live_listener "$API_PORT" "$api_cwd" "$current_service")" \
    || return 1
  verify_api_readiness "$token" "$temp_dir" || return 1
  DEPLOY_RESULT_API_SERVICE_PID="$current_service"
  DEPLOY_RESULT_API_PID="$current_listener"
}

try_current_web_ready() {
  local web_label="$1"
  local web_program="$2"
  local web_dir="$3"
  local receipt_public="$4"
  local receipt_file="$5"
  local challenge="$6"
  local implementation="$7"
  local temp_dir="$8"
  local attempt=""
  local current_service=""
  local current_listener=""
  local confirmed_service=""
  local confirmed_listener=""
  for attempt in $(/usr/bin/jot 120 1); do
    current_service="$(try_service_pid "$web_label" "$web_program" 2>/dev/null || true)"
    if [[ "$current_service" =~ ^[1-9][0-9]*$ ]]; then
      current_listener="$(try_exact_live_listener "$WEB_PORT" "$web_dir" "$current_service" 2>/dev/null || true)"
      if [[ "$current_listener" =~ ^[1-9][0-9]*$ ]]; then
        break
      fi
    fi
    /bin/sleep 0.25
  done
  [[ "$current_service" =~ ^[1-9][0-9]*$ \
    && "$current_listener" =~ ^[1-9][0-9]*$ ]] \
    || return 1
  try_verify_bound_web \
    "$receipt_public" "$receipt_file" "$challenge" "$implementation" "$temp_dir" \
    || return 1
  confirmed_service="$(try_service_pid "$web_label" "$web_program")" || return 1
  confirmed_listener="$(try_exact_live_listener "$WEB_PORT" "$web_dir" "$confirmed_service")" \
    || return 1
  [[ "$confirmed_service" == "$current_service" \
    && "$confirmed_listener" == "$current_listener" ]] \
    || return 1
  DEPLOY_RESULT_WEB_SERVICE_PID="$confirmed_service"
  DEPLOY_RESULT_WEB_PID="$confirmed_listener"
}

try_verify_bound_web() {
  local receipt_public="$1"
  local receipt_file="$2"
  local challenge="$3"
  local implementation="$4"
  local temp_dir="$5"
  local attempt=""
  for attempt in $(/usr/bin/jot 120 1); do
    if verify_http_binding \
      "http://127.0.0.1:$WEB_PORT/" \
      "http://127.0.0.1:$WEB_PORT$receipt_public" \
      "$receipt_file" \
      "$challenge" \
      "$implementation" \
      "$temp_dir"; then
      return 0
    fi
    /bin/sleep 0.25
  done
  return 1
}

try_complete_web_turnover() {
  local old_service="$1"
  local old_listener="$2"
  local web_label="$3"
  local web_program="$4"
  local core_dir="$5"
  local web_dir="$6"
  local receipt_public="$7"
  local receipt_file="$8"
  local challenge="$9"
  shift 9
  local implementation="$1"
  local temp_dir="$2"
  local current_service=""
  local current_listener=""
  local turnover=""
  local new_service=""
  local new_listener=""
  current_service="$(try_wait_for_existing_service_pid "$web_label" "$web_program")" \
    || return 1
  current_listener="$(try_optional_owned_listener "$WEB_PORT" "$web_dir" "$current_service")" \
    || return 1
  if [[ "$current_service" == "$old_service" ]]; then
    try_terminate_owned_service \
      "$web_label" "$web_program" "$current_service" "$core_dir" \
      "-- npm --workspace @core-v2/web run start" \
      || return 1
    turnover="$(wait_for_service_turnover \
      "$web_label" "$web_program" "$WEB_PORT" "$web_dir" \
      "$old_service" "$old_listener")" \
      || return 1
    IFS=$'\t' read -r new_service new_listener <<< "$turnover"
  elif [[ "$current_listener" =~ ^[1-9][0-9]*$ \
    && "$current_listener" != "$old_listener" ]]; then
    new_service="$current_service"
    new_listener="$current_listener"
  else
    turnover="$(wait_for_service_turnover \
      "$web_label" "$web_program" "$WEB_PORT" "$web_dir" \
      "$old_service" "$old_listener")" \
      || return 1
    IFS=$'\t' read -r new_service new_listener <<< "$turnover"
  fi
  [[ "$new_service" != "$old_service" && "$new_listener" != "$old_listener" ]] \
    || return 1
  try_verify_bound_web \
    "$receipt_public" "$receipt_file" "$challenge" "$implementation" "$temp_dir" \
    || return 1
  [[ "$(try_exact_live_listener "$WEB_PORT" "$web_dir" "$new_service")" == "$new_listener" ]] \
    || return 1
  DEPLOY_RESULT_WEB_SERVICE_PID="$new_service"
  DEPLOY_RESULT_WEB_PID="$new_listener"
}

try_restart_web_for_rollback() {
  local web_label="$1"
  local web_program="$2"
  local core_dir="$3"
  local web_dir="$4"
  local temp_dir="$5"
  local current_service=""
  local current_listener=""
  local turnover=""
  local new_service=""
  local new_listener=""
  local attempt=""
  current_service="$(try_wait_for_existing_service_pid "$web_label" "$web_program")" \
    || return 1
  current_listener="$(try_optional_owned_listener "$WEB_PORT" "$web_dir" "$current_service")" \
    || return 1
  try_terminate_owned_service \
    "$web_label" "$web_program" "$current_service" "$core_dir" \
    "-- npm --workspace @core-v2/web run start" \
    || return 1
  turnover="$(wait_for_service_turnover \
    "$web_label" "$web_program" "$WEB_PORT" "$web_dir" \
    "$current_service" "$current_listener")" \
    || return 1
  IFS=$'\t' read -r new_service new_listener <<< "$turnover"
  for attempt in $(/usr/bin/jot 120 1); do
    if verify_generic_web_readiness "$temp_dir"; then
      DEPLOY_RESULT_WEB_SERVICE_PID="$new_service"
      DEPLOY_RESULT_WEB_PID="$new_listener"
      return 0
    fi
    /bin/sleep 0.25
  done
  return 1
}

finish_successful_swap() {
  local state_file="$1"
  local live_build="$2"
  local swap_build="$3"
  [[ "$DEPLOY_RESULT_API_SERVICE_PID" =~ ^[1-9][0-9]*$ \
    && "$DEPLOY_RESULT_API_PID" =~ ^[1-9][0-9]*$ \
    && "$DEPLOY_RESULT_WEB_SERVICE_PID" =~ ^[1-9][0-9]*$ \
    && "$DEPLOY_RESULT_WEB_PID" =~ ^[1-9][0-9]*$ ]] \
    || die "Verified deployment PIDs are unavailable before commit."
  SWAP_STATE_API_SERVICE_PID="$DEPLOY_RESULT_API_SERVICE_PID"
  SWAP_STATE_API_LISTENER_PID="$DEPLOY_RESULT_API_PID"
  SWAP_STATE_WEB_SERVICE_PID="$DEPLOY_RESULT_WEB_SERVICE_PID"
  SWAP_STATE_WEB_LISTENER_PID="$DEPLOY_RESULT_WEB_PID"
  if ! write_swap_state \
    "$state_file" committed "$live_build" "$swap_build" \
    "$SWAP_STATE_API_SERVICE_PID" "$SWAP_STATE_API_LISTENER_PID" \
    "$SWAP_STATE_WEB_SERVICE_PID" "$SWAP_STATE_WEB_LISTENER_PID"; then
    return 1
  fi
  SWAP_STATE_PHASE="committed"
  return 0
}

complete_rollback_and_fail() {
  local state_file="$1"
  local swap_build="$2"
  local api_label="$3"
  local api_program="$4"
  local api_cwd="$5"
  local web_label="$6"
  local web_program="$7"
  local core_dir="$8"
  local web_dir="$9"
  shift 9
  local token="$1"
  local temp_dir="$2"
  local message="$3"
  try_restart_web_for_rollback \
    "$web_label" "$web_program" "$core_dir" "$web_dir" "$temp_dir" \
    || die "Live build was restored, but the Core V2 web rollback service did not become ready; administrator recovery is required."
  try_current_api_ready "$api_label" "$api_program" "$api_cwd" "$token" "$temp_dir" \
    || die "Live web build was restored, but Core V2 API readiness is unavailable; administrator recovery is required."
  delete_swap_state "$state_file"
  remove_private_build_dir "$swap_build" "$STATE_ROOT/deployment/swap-build"
  die "$message"
}

rollback_swapped_deployment() {
  local state_file="$1"
  local live_build="$2"
  local swap_build="$3"
  local api_label="$4"
  local api_program="$5"
  local api_cwd="$6"
  local web_label="$7"
  local web_program="$8"
  local core_dir="$9"
  shift 9
  local web_dir="$1"
  local token="$2"
  local temp_dir="$3"
  local message="$4"
  local live_digest=""
  local swap_digest=""
  live_digest="$(directory_inventory_digest "$live_build")" \
    || die "Could not verify the failed live build before rollback; administrator recovery is required."
  swap_digest="$(directory_inventory_digest "$swap_build")" \
    || die "Could not verify the rollback build; administrator recovery is required."
  [[ "$live_digest" == "$EXPECTED_BUILD_DIGEST" \
    && "$swap_digest" == "$SWAP_STATE_PRIOR_DIGEST" ]] \
    || die "Refusing rollback because the live/backup build roles no longer match durable swap state."
  write_swap_state \
    "$state_file" rollback_pending "$live_build" "$swap_build" \
    "$SWAP_STATE_API_SERVICE_PID" "$SWAP_STATE_API_LISTENER_PID" \
    "$SWAP_STATE_WEB_SERVICE_PID" "$SWAP_STATE_WEB_LISTENER_PID" \
    || log "Could not persist rollback_pending; continuing the immediate atomic rollback."
  atomic_exchange_directories "$live_build" "$swap_build" \
    || die "Core V2 deployment failed and the atomic rollback exchange could not run; administrator recovery is required."
  write_swap_state \
    "$state_file" rollback_swapped "$live_build" "$swap_build" \
    "$SWAP_STATE_API_SERVICE_PID" "$SWAP_STATE_API_LISTENER_PID" \
    "$SWAP_STATE_WEB_SERVICE_PID" "$SWAP_STATE_WEB_LISTENER_PID" \
    || log "Could not persist rollback_swapped; recovery can infer the completed atomic rollback."
  complete_rollback_and_fail \
    "$state_file" "$swap_build" \
    "$api_label" "$api_program" "$api_cwd" \
    "$web_label" "$web_program" "$core_dir" "$web_dir" \
    "$token" "$temp_dir" "$message"
}

complete_swapped_deployment() {
  local state_file="$1"
  local live_build="$2"
  local swap_build="$3"
  local api_label="$4"
  local api_program="$5"
  local api_cwd="$6"
  local web_label="$7"
  local web_program="$8"
  local core_dir="$9"
  shift 9
  local web_dir="$1"
  local token="$2"
  local receipt_public="$3"
  local receipt_file="$4"
  local challenge="$5"
  local implementation="$6"
  local temp_dir="$7"

  try_api_unchanged_and_ready \
    "$SWAP_STATE_API_SERVICE_PID" "$SWAP_STATE_API_LISTENER_PID" \
    "$api_label" "$api_program" "$api_cwd" "$token" "$temp_dir" \
    || rollback_swapped_deployment \
      "$state_file" "$live_build" "$swap_build" \
      "$api_label" "$api_program" "$api_cwd" \
      "$web_label" "$web_program" "$core_dir" "$web_dir" \
      "$token" "$temp_dir" \
      "Core V2 API PID/readiness changed during web deployment; the web build was rolled back."

  try_complete_web_turnover \
    "$SWAP_STATE_WEB_SERVICE_PID" "$SWAP_STATE_WEB_LISTENER_PID" \
    "$web_label" "$web_program" "$core_dir" "$web_dir" \
    "$receipt_public" "$receipt_file" "$challenge" \
    "$implementation" "$temp_dir" \
    || rollback_swapped_deployment \
      "$state_file" "$live_build" "$swap_build" \
      "$api_label" "$api_program" "$api_cwd" \
      "$web_label" "$web_program" "$core_dir" "$web_dir" \
      "$token" "$temp_dir" \
      "Core V2 web restart or attestation verification failed; the prior build was restored."

  SWAP_STATE_API_SERVICE_PID="$DEPLOY_RESULT_API_SERVICE_PID"
  SWAP_STATE_API_LISTENER_PID="$DEPLOY_RESULT_API_PID"
  SWAP_STATE_WEB_SERVICE_PID="$DEPLOY_RESULT_WEB_SERVICE_PID"
  SWAP_STATE_WEB_LISTENER_PID="$DEPLOY_RESULT_WEB_PID"
  write_swap_state \
    "$state_file" swapped "$live_build" "$swap_build" \
    "$SWAP_STATE_API_SERVICE_PID" "$SWAP_STATE_API_LISTENER_PID" \
    "$SWAP_STATE_WEB_SERVICE_PID" "$SWAP_STATE_WEB_LISTENER_PID" \
    || rollback_swapped_deployment \
      "$state_file" "$live_build" "$swap_build" \
      "$api_label" "$api_program" "$api_cwd" \
      "$web_label" "$web_program" "$core_dir" "$web_dir" \
      "$token" "$temp_dir" \
      "Could not persist verified web turnover; the prior build was restored."

  try_api_unchanged_and_ready \
    "$SWAP_STATE_API_SERVICE_PID" "$SWAP_STATE_API_LISTENER_PID" \
    "$api_label" "$api_program" "$api_cwd" "$token" "$temp_dir" \
    || rollback_swapped_deployment \
      "$state_file" "$live_build" "$swap_build" \
      "$api_label" "$api_program" "$api_cwd" \
      "$web_label" "$web_program" "$core_dir" "$web_dir" \
      "$token" "$temp_dir" \
      "Core V2 API changed during web cutover; the prior web build was restored."

  [[ "$(/usr/bin/git -C "$REPOSITORY" rev-parse HEAD)" == "$ATTESTATION" \
    && -z "$(/usr/bin/git -C "$REPOSITORY" status --porcelain=v1 --untracked-files=all -- "$CORE_V2_REL")" ]] \
    || rollback_swapped_deployment \
      "$state_file" "$live_build" "$swap_build" \
      "$api_label" "$api_program" "$api_cwd" \
      "$web_label" "$web_program" "$core_dir" "$web_dir" \
      "$token" "$temp_dir" \
      "Live Core V2 Git state changed during deployment; the prior web build was restored."

  [[ "$(directory_inventory_digest "$live_build")" == "$EXPECTED_BUILD_DIGEST" ]] \
    || rollback_swapped_deployment \
      "$state_file" "$live_build" "$swap_build" \
      "$api_label" "$api_program" "$api_cwd" \
      "$web_label" "$web_program" "$core_dir" "$web_dir" \
      "$token" "$temp_dir" \
      "Live Core V2 build changed during deployment; the prior build was restored."

  if ! finish_successful_swap "$state_file" "$live_build" "$swap_build"; then
    rollback_swapped_deployment \
      "$state_file" "$live_build" "$swap_build" \
      "$api_label" "$api_program" "$api_cwd" \
      "$web_label" "$web_program" "$core_dir" "$web_dir" \
      "$token" "$temp_dir" \
      "Could not durably commit the Core V2 deployment; the prior build was restored."
  fi
  delete_swap_state "$state_file"
  remove_private_build_dir "$swap_build" "$STATE_ROOT/deployment/swap-build"
  SUCCESS=1
  emit_deployment_success \
    "$EXPECTED_BUILD_DIGEST" "$DEPLOY_RESULT_API_PID" "$DEPLOY_RESULT_WEB_PID"
  exit 0
}

recover_deployment_swap_if_needed() {
  local state_file="$1"
  local live_build="$2"
  local swap_build="$3"
  local api_label="$4"
  local api_program="$5"
  local api_cwd="$6"
  local web_label="$7"
  local web_program="$8"
  local core_dir="$9"
  shift 9
  local web_dir="$1"
  local token="$2"
  local receipt_public="$3"
  local receipt_file="$4"
  local challenge="$5"
  local implementation="$6"
  local temp_dir="$7"
  local live_digest=""
  local swap_digest=""

  if ! read_swap_state "$state_file" "$live_build" "$swap_build"; then
    if [[ -e "$swap_build" ]]; then
      log "Removing stale pre-swap deployment build."
      remove_private_build_dir "$swap_build" "$STATE_ROOT/deployment/swap-build"
    fi
    return 0
  fi
  [[ "$SWAP_STATE_ATTESTATION" == "$ATTESTATION" \
    && "$SWAP_STATE_DIGEST" == "$EXPECTED_BUILD_DIGEST" ]] \
    || die "Deployment swap state belongs to another attestation; administrator recovery is required."
  [[ -d "$live_build" && ! -L "$live_build" ]] \
    || die "Live Core V2 build is missing during swap recovery."
  live_digest="$(directory_inventory_digest "$live_build")" \
    || die "Could not inventory the live build during swap recovery."
  if [[ -e "$swap_build" ]]; then
    swap_digest="$(directory_inventory_digest "$swap_build")" \
      || die "Could not inventory the private swap build during recovery."
  fi

  case "$SWAP_STATE_PHASE" in
    prepared)
      if [[ "$live_digest" == "$EXPECTED_BUILD_DIGEST" \
        && "$swap_digest" == "$SWAP_STATE_PRIOR_DIGEST" ]]; then
        write_swap_state \
          "$state_file" swapped "$live_build" "$swap_build" \
          "$SWAP_STATE_API_SERVICE_PID" "$SWAP_STATE_API_LISTENER_PID" \
          "$SWAP_STATE_WEB_SERVICE_PID" "$SWAP_STATE_WEB_LISTENER_PID"
        SWAP_STATE_PHASE="swapped"
      elif [[ "$live_digest" == "$SWAP_STATE_PRIOR_DIGEST" \
        && "$swap_digest" == "$EXPECTED_BUILD_DIGEST" ]]; then
        delete_swap_state "$state_file"
        remove_private_build_dir "$swap_build" "$STATE_ROOT/deployment/swap-build"
        return 0
      elif [[ -z "$swap_digest" \
        && "$live_digest" == "$SWAP_STATE_PRIOR_DIGEST" ]]; then
        delete_swap_state "$state_file"
        return 0
      else
        die "Prepared deployment swap state is inconsistent; administrator recovery is required."
      fi
      ;;
    rollback_pending)
      if [[ "$live_digest" == "$EXPECTED_BUILD_DIGEST" \
        && "$swap_digest" == "$SWAP_STATE_PRIOR_DIGEST" ]]; then
        atomic_exchange_directories "$live_build" "$swap_build" \
          || die "Could not finish the pending atomic deployment rollback."
        write_swap_state \
          "$state_file" rollback_swapped "$live_build" "$swap_build" \
          "$SWAP_STATE_API_SERVICE_PID" "$SWAP_STATE_API_LISTENER_PID" \
          "$SWAP_STATE_WEB_SERVICE_PID" "$SWAP_STATE_WEB_LISTENER_PID"
        SWAP_STATE_PHASE="rollback_swapped"
      elif [[ "$live_digest" == "$SWAP_STATE_PRIOR_DIGEST" \
        && "$swap_digest" == "$EXPECTED_BUILD_DIGEST" ]]; then
        write_swap_state \
          "$state_file" rollback_swapped "$live_build" "$swap_build" \
          "$SWAP_STATE_API_SERVICE_PID" "$SWAP_STATE_API_LISTENER_PID" \
          "$SWAP_STATE_WEB_SERVICE_PID" "$SWAP_STATE_WEB_LISTENER_PID"
        SWAP_STATE_PHASE="rollback_swapped"
      else
        die "Pending deployment rollback state is inconsistent; administrator recovery is required."
      fi
      ;;
    swapped)
      if [[ "$live_digest" == "$SWAP_STATE_PRIOR_DIGEST" \
        && "$swap_digest" == "$EXPECTED_BUILD_DIGEST" ]]; then
        write_swap_state \
          "$state_file" rollback_swapped "$live_build" "$swap_build" \
          "$SWAP_STATE_API_SERVICE_PID" "$SWAP_STATE_API_LISTENER_PID" \
          "$SWAP_STATE_WEB_SERVICE_PID" "$SWAP_STATE_WEB_LISTENER_PID"
        SWAP_STATE_PHASE="rollback_swapped"
      elif [[ "$live_digest" != "$EXPECTED_BUILD_DIGEST" \
        || "$swap_digest" != "$SWAP_STATE_PRIOR_DIGEST" ]]; then
        die "Swapped deployment state is inconsistent; administrator recovery is required."
      fi
      ;;
    rollback_swapped)
      [[ "$live_digest" == "$SWAP_STATE_PRIOR_DIGEST" \
        && ( "$swap_digest" == "$EXPECTED_BUILD_DIGEST" || -z "$swap_digest" ) ]] \
        || die "Restored deployment rollback state is inconsistent."
      ;;
    committed)
      [[ "$live_digest" == "$EXPECTED_BUILD_DIGEST" \
        && ( "$swap_digest" == "$SWAP_STATE_PRIOR_DIGEST" || -z "$swap_digest" ) ]] \
        || die "Committed deployment swap state does not match the live build."
      ;;
  esac

  if [[ "$SWAP_STATE_PHASE" == "rollback_swapped" ]]; then
    complete_rollback_and_fail \
      "$state_file" "$swap_build" \
      "$api_label" "$api_program" "$api_cwd" \
      "$web_label" "$web_program" "$core_dir" "$web_dir" \
      "$token" "$temp_dir" \
      "The prior Core V2 deployment was atomically rolled back; approval remains parked."
  fi

  if [[ "$SWAP_STATE_PHASE" == "committed" ]]; then
    [[ "$(/usr/bin/git -C "$REPOSITORY" rev-parse HEAD)" == "$ATTESTATION" \
      && -z "$(/usr/bin/git -C "$REPOSITORY" status --porcelain=v1 --untracked-files=all -- "$CORE_V2_REL")" ]] \
      || die "Committed deployment Git state changed; administrator recovery is required."
    try_current_api_ready \
      "$api_label" "$api_program" "$api_cwd" "$token" "$temp_dir" \
      || die "Committed deployment API readiness is unavailable; administrator recovery is required."
    try_current_web_ready \
      "$web_label" "$web_program" "$web_dir" \
      "$receipt_public" "$receipt_file" "$challenge" "$implementation" "$temp_dir" \
      || die "Committed deployment web binding is unavailable; administrator recovery is required."
    try_api_unchanged_and_ready \
      "$DEPLOY_RESULT_API_SERVICE_PID" "$DEPLOY_RESULT_API_PID" \
      "$api_label" "$api_program" "$api_cwd" "$token" "$temp_dir" \
      || die "Committed deployment API changed during recovery; administrator recovery is required."
    [[ "$(directory_inventory_digest "$live_build")" == "$EXPECTED_BUILD_DIGEST" ]] \
      || die "Committed deployment build changed during recovery; administrator recovery is required."
    if [[ -e "$swap_build" ]]; then
      delete_swap_state "$state_file"
      remove_private_build_dir "$swap_build" "$STATE_ROOT/deployment/swap-build"
    else
      delete_swap_state "$state_file"
    fi
    SUCCESS=1
    emit_deployment_success \
      "$EXPECTED_BUILD_DIGEST" "$DEPLOY_RESULT_API_PID" "$DEPLOY_RESULT_WEB_PID"
    exit 0
  fi

  complete_swapped_deployment \
    "$state_file" "$live_build" "$swap_build" \
    "$api_label" "$api_program" "$api_cwd" \
    "$web_label" "$web_program" "$core_dir" "$web_dir" \
    "$token" "$receipt_public" "$receipt_file" "$challenge" \
    "$implementation" "$temp_dir"
}

run_deployment() {
  local live_core_dir="$REPOSITORY/$CORE_V2_REL"
  local live_web_dir="$REPOSITORY/$WEB_REL"
  local live_build="$REPOSITORY/$WEB_REL/build"
  local deployment_dir="$STATE_ROOT/deployment"
  local deployment_worktree=""
  local deployment_core_dir=""
  local deployment_web_dir=""
  local npm_cache="$STATE_ROOT/npm-cache"
  local first_inventory="$deployment_dir/build-inventory.first.json"
  local final_inventory="$deployment_dir/build-inventory.json"
  local staged_inventory="$deployment_dir/build-inventory.staged.json"
  local swap_build="$deployment_dir/swap-build"
  local state_file="$deployment_dir/swap-state.json"
  local token=""
  local binding=""
  local deployment_binding=""
  local binding_challenge=""
  local binding_receipt=""
  local binding_implementation=""
  local receipt_file=""
  local receipt_public=""
  local first_build_digest=""
  local build_digest=""
  local old_build_digest=""
  local api_label="com.core.core-v2-api"
  local web_label="com.core.core-v2-web"
  local api_program="$live_core_dir/scripts/core-v2-api-launch.sh"
  local web_program="$live_core_dir/scripts/core-v2-web-launch.sh"
  local api_service=""
  local api_listener=""
  local old_web_service=""
  local old_web_listener=""
  local current_web_service=""
  local current_web_listener=""

  [[ "$EXPECTED_BUILD_DIGEST" =~ ^[a-f0-9]{64}$ ]] \
    || die "--build-digest must be one exact lowercase SHA-256 digest."
  [[ "$(/usr/bin/git -C "$REPOSITORY" rev-parse HEAD)" == "$ATTESTATION" ]] \
    || die "Live repository HEAD is not the approved attestation commit."
  [[ -z "$(/usr/bin/git -C "$REPOSITORY" status --porcelain=v1 --untracked-files=all -- "$CORE_V2_REL")" ]] \
    || die "Live Core V2 has tracked or untracked changes."
  token="$(read_token)"

  binding="$(attestation_binding "$REPOSITORY" "" "")" \
    || die "Live attestation source or receipt is invalid."
  IFS=$'\t' read -r binding_challenge binding_receipt binding_implementation <<< "$binding"
  [[ "$binding_receipt" == "${RECEIPT_PREFIX}${binding_challenge}.json" ]] \
    || die "Live attestation receipt path is invalid."
  receipt_file="$REPOSITORY/$binding_receipt"
  validate_tree_blob "$REPOSITORY" "$ATTESTATION" "$APP_REL"
  validate_tree_blob "$REPOSITORY" "$ATTESTATION" "$binding_receipt"
  validate_tree_executable "$REPOSITORY" "$ATTESTATION" "$CORE_V2_REL/scripts/core-v2-api-launch.sh"
  validate_tree_executable "$REPOSITORY" "$ATTESTATION" "$CORE_V2_REL/scripts/core-v2-web-launch.sh"

  validate_installed_service "$api_label" "$api_program"
  validate_installed_service "$web_label" "$web_program"

  receipt_public="/${binding_receipt#"$STATIC_ROOT"}"
  recover_deployment_swap_if_needed \
    "$state_file" "$live_build" "$swap_build" \
    "$api_label" "$api_program" "$live_core_dir/packages/service" \
    "$web_label" "$web_program" "$live_core_dir" "$live_web_dir" \
    "$token" "$receipt_public" "$receipt_file" "$binding_challenge" \
    "$binding_implementation" "$deployment_dir"

  api_service="$(wait_for_existing_service_pid "$api_label" "$api_program")"
  api_listener="$(validate_live_listener \
    "$API_PORT" "$live_core_dir/packages/service" "$api_service")"
  verify_api_readiness "$token" "$deployment_dir" \
    || die "Core V2 API is not ready before isolated deployment verification."
  DEPLOY_RESULT_API_SERVICE_PID="$api_service"
  DEPLOY_RESULT_API_PID="$api_listener"

  deployment_worktree="$(create_or_validate_deployment_worktree)"
  deployment_core_dir="$deployment_worktree/$CORE_V2_REL"
  deployment_web_dir="$deployment_worktree/$WEB_REL"
  deployment_binding="$(attestation_binding "$deployment_worktree" "" "")" \
    || die "Deployment worktree attestation source or receipt is invalid."
  [[ "$deployment_binding" == "$binding" ]] \
    || die "Deployment worktree attestation binding differs from the live approved source."

  log "Installing exact Core V2 dependencies in the isolated deployment worktree."
  run_npm "$deployment_core_dir" "$npm_cache" ci --no-audit --no-fund \
    || die "npm ci failed in the isolated deployment worktree."
  log "Running isolated Core V2 checks."
  run_npm "$deployment_core_dir" "$npm_cache" run check \
    || die "npm run check failed in the isolated deployment worktree."
  log "Running isolated Core V2 tests."
  run_npm "$deployment_core_dir" "$npm_cache" test \
    || die "npm test failed in the isolated deployment worktree."

  log "Building the isolated adapter-node Core UI."
  reset_generated_web_build "$deployment_worktree" "$deployment_web_dir"
  run_npm "$deployment_core_dir" "$npm_cache" run web:build \
    || die "npm run web:build failed in the isolated deployment worktree."
  [[ -z "$(/usr/bin/git -C "$deployment_worktree" status --porcelain=v1 --untracked-files=all)" ]] \
    || die "The isolated deployment build changed tracked or untracked source files."
  first_build_digest="$(compute_build_inventory \
    "$deployment_web_dir/build" "$first_inventory" "$deployment_worktree")" \
    || die "Could not create the first isolated deployment build inventory."
  [[ "$first_build_digest" =~ ^[a-f0-9]{64}$ ]] \
    || die "The first isolated deployment build digest is invalid."

  log "Rebuilding once to prove deterministic deployment output."
  reset_generated_web_build "$deployment_worktree" "$deployment_web_dir"
  run_npm "$deployment_core_dir" "$npm_cache" run web:build \
    || die "The isolated deterministic deployment rebuild failed."
  [[ -z "$(/usr/bin/git -C "$deployment_worktree" status --porcelain=v1 --untracked-files=all)" ]] \
    || die "The isolated deterministic rebuild changed tracked or untracked source files."
  build_digest="$(compute_build_inventory \
    "$deployment_web_dir/build" "$final_inventory" "$deployment_worktree")" \
    || die "Could not create the final isolated deployment build inventory."
  [[ "$build_digest" == "$first_build_digest" ]] \
    || die "Two clean isolated deployment builds produced different SHA-256 inventories."
  [[ "$build_digest" == "$EXPECTED_BUILD_DIGEST" ]] \
    || die "The isolated deployment build does not match the approved candidate build."

  [[ "$(/usr/bin/git -C "$REPOSITORY" rev-parse HEAD)" == "$ATTESTATION" ]] \
    || die "Live repository HEAD changed during isolated deployment verification."
  [[ -z "$(/usr/bin/git -C "$REPOSITORY" status --porcelain=v1 --untracked-files=all -- "$CORE_V2_REL")" ]] \
    || die "Live Core V2 changed during isolated deployment verification."
  try_api_unchanged_and_ready \
    "$api_service" "$api_listener" \
    "$api_label" "$api_program" "$live_core_dir/packages/service" \
    "$token" "$deployment_dir" \
    || die "Core V2 API wrapper, listener, or readiness changed before web cutover."

  [[ -d "$live_build" && ! -L "$live_build" ]] \
    || die "Live Core V2 build is missing or linked before cutover."
  [[ "$(/usr/bin/stat -f '%u' "$live_build")" == "$CURRENT_UID" ]] \
    || die "Live Core V2 build has an unknown owner."
  assert_no_nested_mounts "$live_build" \
    || die "Live Core V2 build contains an unsafe nested mount."
  old_build_digest="$(directory_inventory_digest "$live_build")" \
    || die "Could not safely inventory the current live Core V2 build."
  [[ "$old_build_digest" =~ ^[a-f0-9]{64}$ ]] \
    || die "Current live Core V2 build inventory is invalid."

  stage_deployment_build \
    "$deployment_web_dir/build" "$swap_build" "$staged_inventory" \
    "$build_digest" "$deployment_worktree"
  [[ "$(/usr/bin/stat -f '%d' "$live_build")" == "$(/usr/bin/stat -f '%d' "$swap_build")" ]] \
    || die "Live and staged Core V2 builds are not on the same filesystem."

  try_api_unchanged_and_ready \
    "$api_service" "$api_listener" \
    "$api_label" "$api_program" "$live_core_dir/packages/service" \
    "$token" "$deployment_dir" \
    || die "Core V2 API wrapper, listener, or readiness changed while staging the web build."
  old_web_service="$(wait_for_existing_service_pid "$web_label" "$web_program")"
  old_web_listener="$(optional_owned_listener \
    "$WEB_PORT" "$live_web_dir" "$old_web_service")"
  old_web_listener="${old_web_listener:-0}"
  [[ "$old_web_listener" =~ ^[0-9]+$ ]] \
    || die "Core V2 web listener state is not numeric before swap preparation."

  SWAP_STATE_PHASE="prepared"
  SWAP_STATE_ATTESTATION="$ATTESTATION"
  SWAP_STATE_DIGEST="$EXPECTED_BUILD_DIGEST"
  SWAP_STATE_PRIOR_DIGEST="$old_build_digest"
  SWAP_STATE_LIVE_BUILD="$live_build"
  SWAP_STATE_SWAP_BUILD="$swap_build"
  SWAP_STATE_API_SERVICE_PID="$api_service"
  SWAP_STATE_API_LISTENER_PID="$api_listener"
  SWAP_STATE_WEB_SERVICE_PID="$old_web_service"
  SWAP_STATE_WEB_LISTENER_PID="$old_web_listener"
  write_swap_state \
    "$state_file" prepared "$live_build" "$swap_build" \
    "$api_service" "$api_listener" "$old_web_service" "$old_web_listener" \
    || die "Could not durably prepare the atomic Core V2 web build swap."

  try_api_unchanged_and_ready \
    "$api_service" "$api_listener" \
    "$api_label" "$api_program" "$live_core_dir/packages/service" \
    "$token" "$deployment_dir" \
    || die "Core V2 API changed after swap preparation; no live web change was made."
  current_web_service="$(try_service_pid "$web_label" "$web_program")" \
    || die "Core V2 web wrapper changed after swap preparation; no live web change was made."
  current_web_listener="$(try_optional_owned_listener \
    "$WEB_PORT" "$live_web_dir" "$current_web_service")" \
    || die "Core V2 web listener became unsafe after swap preparation."
  current_web_listener="${current_web_listener:-0}"
  [[ "$current_web_listener" =~ ^[0-9]+$ ]] \
    || die "Core V2 current web listener state is not numeric before the atomic swap."
  [[ "$current_web_service" == "$old_web_service" \
    && "$current_web_listener" == "$old_web_listener" ]] \
    || die "Core V2 web wrapper or listener changed before the atomic build swap."
  [[ "$(directory_inventory_digest "$live_build")" == "$SWAP_STATE_PRIOR_DIGEST" \
    && "$(directory_inventory_digest "$swap_build")" == "$EXPECTED_BUILD_DIGEST" ]] \
    || die "Prepared live/staged build roles changed before the atomic swap."

  log "Atomically exchanging the verified Core V2 web build."
  atomic_exchange_directories "$live_build" "$swap_build" \
    || die "Could not atomically exchange the live and verified Core V2 web builds."
  SWAP_STATE_PHASE="swapped"
  write_swap_state \
    "$state_file" swapped "$live_build" "$swap_build" \
    "$api_service" "$api_listener" "$old_web_service" "$old_web_listener" \
    || rollback_swapped_deployment \
      "$state_file" "$live_build" "$swap_build" \
      "$api_label" "$api_program" "$live_core_dir/packages/service" \
      "$web_label" "$web_program" "$live_core_dir" "$live_web_dir" \
      "$token" "$deployment_dir" \
      "Could not persist the completed build exchange; the prior build was restored."

  complete_swapped_deployment \
    "$state_file" "$live_build" "$swap_build" \
    "$api_label" "$api_program" "$live_core_dir/packages/service" \
    "$web_label" "$web_program" "$live_core_dir" "$live_web_dir" \
    "$token" "$receipt_public" "$receipt_file" "$binding_challenge" \
    "$binding_implementation" "$deployment_dir"
}

parse_args "$@"
validate_host_and_user
validate_repository
validate_runtime
acquire_lock

if [[ "$MODE" == "candidate" ]]; then
  run_candidate
else
  run_deployment
fi
