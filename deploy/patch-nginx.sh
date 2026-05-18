#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Patch nginx config from this repo onto a production host.

Usage:
  sudo ./deploy/patch-nginx.sh [--repo-root PATH] [--overwrite-site]

Options:
  --repo-root PATH   Repo root (defaults to parent of this script's directory)
  --overwrite-site   Replace /etc/nginx/sites-available/muddown.conf directly
                     (DANGEROUS if certbot has added TLS blocks)
  -h, --help         Show this help

Default behavior:
  - Always sync snippets:
      /etc/nginx/snippets/muddown-proxy.conf
      /etc/nginx/snippets/muddown-security-headers.conf
  - If site config exists and differs, write candidate to:
      /etc/nginx/sites-available/muddown.conf.repo-new
    and ask for manual merge to preserve TLS/certbot edits.
  - Validate nginx config and reload nginx.
EOF
}

log() {
  printf '[patch-nginx] %s\n' "$*"
}

err() {
  printf '[patch-nginx] ERROR: %s\n' "$*" >&2
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    err "Run as root (try: sudo ./deploy/patch-nginx.sh)"
    exit 1
  fi
}

backup_if_exists() {
  local target="$1"
  local stamp="$2"
  if [[ -f "$target" ]]; then
    cp "$target" "${target}.bak.${stamp}"
    log "Backed up $target -> ${target}.bak.${stamp}"
  fi
}

copy_with_backup() {
  local source="$1"
  local target="$2"
  local stamp="$3"

  if [[ ! -f "$source" ]]; then
    err "Missing source file: $source"
    exit 1
  fi

  backup_if_exists "$target" "$stamp"
  install -m 0644 "$source" "$target"
  log "Updated $target"
}

REPO_ROOT=""
OVERWRITE_SITE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root)
      shift
      if [[ $# -eq 0 ]]; then
        err "--repo-root requires a path"
        exit 1
      fi
      REPO_ROOT="$1"
      ;;
    --overwrite-site)
      OVERWRITE_SITE=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      err "Unknown argument: $1"
      usage >&2
      exit 1
      ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "$REPO_ROOT" ]]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

SOURCE_DIR="$REPO_ROOT/deploy/nginx"
SOURCE_SITE="$SOURCE_DIR/muddown.conf"
SOURCE_PROXY="$SOURCE_DIR/muddown-proxy.conf"
SOURCE_HEADERS="$SOURCE_DIR/security-headers.conf"

TARGET_SNIPPETS_DIR="/etc/nginx/snippets"
TARGET_SITES_AVAILABLE="/etc/nginx/sites-available"
TARGET_SITES_ENABLED="/etc/nginx/sites-enabled"
TARGET_SITE="$TARGET_SITES_AVAILABLE/muddown.conf"
TARGET_SITE_CANDIDATE="$TARGET_SITES_AVAILABLE/muddown.conf.repo-new"
TARGET_PROXY="$TARGET_SNIPPETS_DIR/muddown-proxy.conf"
TARGET_HEADERS="$TARGET_SNIPPETS_DIR/muddown-security-headers.conf"
STAMP="$(date +%Y%m%dT%H%M%S)"

require_root

NGINX_BIN="$(command -v nginx || true)"
if [[ -z "$NGINX_BIN" && -x "/usr/sbin/nginx" ]]; then
  NGINX_BIN="/usr/sbin/nginx"
fi
if [[ -z "$NGINX_BIN" ]]; then
  err "Could not find nginx binary in PATH or at /usr/sbin/nginx"
  err "Install nginx first, then rerun this script"
  exit 1
fi

if [[ ! -d "$SOURCE_DIR" ]]; then
  err "Could not find source directory: $SOURCE_DIR"
  err "Use --repo-root /path/to/MUDdown if needed"
  exit 1
fi

mkdir -p "$TARGET_SNIPPETS_DIR" "$TARGET_SITES_AVAILABLE" "$TARGET_SITES_ENABLED"

log "Syncing nginx snippets from $SOURCE_DIR"
copy_with_backup "$SOURCE_PROXY" "$TARGET_PROXY" "$STAMP"
copy_with_backup "$SOURCE_HEADERS" "$TARGET_HEADERS" "$STAMP"

NEEDS_MANUAL_MERGE=0

if [[ ! -f "$TARGET_SITE" ]]; then
  log "Site config missing; installing fresh $TARGET_SITE"
  install -m 0644 "$SOURCE_SITE" "$TARGET_SITE"
else
  if cmp -s "$SOURCE_SITE" "$TARGET_SITE"; then
    log "Site config already matches repo copy"
  else
    if [[ "$OVERWRITE_SITE" -eq 1 ]]; then
      log "--overwrite-site set; replacing $TARGET_SITE"
      backup_if_exists "$TARGET_SITE" "$STAMP"
      install -m 0644 "$SOURCE_SITE" "$TARGET_SITE"
    else
      install -m 0644 "$SOURCE_SITE" "$TARGET_SITE_CANDIDATE"
      NEEDS_MANUAL_MERGE=1
      log "Site config differs; wrote candidate: $TARGET_SITE_CANDIDATE"
      log "Manual merge required to preserve TLS/certbot edits in $TARGET_SITE"
      log "Suggested: sudo diff -u $TARGET_SITE $TARGET_SITE_CANDIDATE"
    fi
  fi
fi

if [[ ! -e "$TARGET_SITES_ENABLED/muddown.conf" ]]; then
  ln -s "$TARGET_SITE" "$TARGET_SITES_ENABLED/muddown.conf"
  log "Enabled site: $TARGET_SITES_ENABLED/muddown.conf"
fi

log "Validating nginx config"
"$NGINX_BIN" -t

log "Reloading nginx"
systemctl reload nginx

if [[ "$NEEDS_MANUAL_MERGE" -eq 1 ]]; then
  log "Completed snippet patch + reload. Site config merge still pending."
  exit 2
fi

log "Done"
