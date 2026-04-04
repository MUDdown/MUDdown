#!/usr/bin/env bash
# MUDdown Server Setup Script
# Target: Debian 12+ (Bookworm / Trixie) on Linode
#
# What this script does:
#   Steps 1–3:   System updates, core packages, Node.js 22
#   Step 4:      Create deploy user (SSH-accessible after root lockdown)
#   Steps 5–8:   Harden SSH, firewall (ufw), fail2ban, auto-updates
#   Steps 9–11:  Create service user, clone/build, .env template
#   Steps 12–14: systemd service, nginx, file permissions
#
# Usage:
#   scp -r deploy/ root@<your-linode-ip>:/root/deploy/
#   ssh root@<your-linode-ip> bash /root/deploy/setup.sh
#
# After running, you still need to:
#   - Copy .env file to /opt/muddown/packages/server/.env
#   - Point DNS (muddown.com) to the server IP
#   - Run: certbot --nginx -d muddown.com -d www.muddown.com
#   - Verify: systemctl status muddown-server

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────

export DEBIAN_FRONTEND=noninteractive
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_PORT="${SSH_PORT:-22}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
REPO_URL="https://github.com/MUDdown/MUDdown.git"
INSTALL_DIR="/opt/muddown"
SERVICE_USER="muddown"

# ── Preflight checks ─────────────────────────────────────────────────────────

if [[ $EUID -ne 0 ]]; then
  echo "Error: This script must be run as root." >&2
  exit 1
fi

echo "==> MUDdown Server Setup"
echo "    SSH port: ${SSH_PORT}"
echo "    Deploy user: ${DEPLOY_USER}"
echo "    Install dir: ${INSTALL_DIR}"
echo ""

# ── 1. System updates ────────────────────────────────────────────────────────

echo "==> Updating system packages..."
# Pre-seed grub install device so dpkg --configure can finish non-interactively
BOOT_DISK=$(lsblk -ndo NAME,TYPE | awk '$2=="disk"{print "/dev/"$1; exit}')
if [[ -n "${BOOT_DISK}" ]]; then
  echo "grub-pc grub-pc/install_devices multiselect ${BOOT_DISK}" | debconf-set-selections
fi
# Repair any interrupted dpkg state from a previous run
dpkg --configure -a --force-confdef --force-confold 2>/dev/null || true
# Hold grub-pc — bootloader upgrades need interactive disk selection
apt-mark hold grub-pc grub-pc-bin 2>/dev/null || true
apt-get update -qq
apt-get -y -qq -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" upgrade

# ── 2. Install core packages ─────────────────────────────────────────────────

echo "==> Installing core packages..."
apt-get install -y -qq \
  curl \
  git \
  ufw \
  fail2ban \
  unattended-upgrades \
  apt-listchanges \
  nginx \
  certbot \
  python3-certbot-nginx

# ── 3. Install Node.js 22 LTS ────────────────────────────────────────────────

if ! command -v node &>/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]]; then
  echo "==> Installing Node.js 22..."
  NODESOURCE_SCRIPT=$(mktemp)
  trap 'rm -f "${NODESOURCE_SCRIPT}"' EXIT
  if ! curl -fsSL https://deb.nodesource.com/setup_22.x -o "${NODESOURCE_SCRIPT}"; then
    echo "ERROR: Failed to download NodeSource installer." >&2
    exit 1
  fi
  bash "${NODESOURCE_SCRIPT}"
  rm -f "${NODESOURCE_SCRIPT}"
  trap - EXIT
  apt-get install -y -qq nodejs
fi
echo "    Node.js $(node -v), npm $(npm -v)"

# ── 4. Create deploy user ────────────────────────────────────────────────────

echo "==> Creating deploy user '${DEPLOY_USER}'..."
if ! id "${DEPLOY_USER}" &>/dev/null; then
  useradd --create-home --shell /bin/bash --groups sudo "${DEPLOY_USER}"
  if [[ -s /root/.ssh/authorized_keys ]]; then
    mkdir -p "/home/${DEPLOY_USER}/.ssh"
    cp /root/.ssh/authorized_keys "/home/${DEPLOY_USER}/.ssh/"
    chown -R "${DEPLOY_USER}:${DEPLOY_USER}" "/home/${DEPLOY_USER}/.ssh"
    chmod 700 "/home/${DEPLOY_USER}/.ssh"
    chmod 600 "/home/${DEPLOY_USER}/.ssh/authorized_keys"
  fi
  # Allow passwordless sudo (password auth is disabled over SSH)
  echo "${DEPLOY_USER} ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/${DEPLOY_USER}"
  chown root:root "/etc/sudoers.d/${DEPLOY_USER}"
  chmod 0440 "/etc/sudoers.d/${DEPLOY_USER}"
  echo "    Created user '${DEPLOY_USER}' with passwordless sudo."
else
  echo "    User '${DEPLOY_USER}' already exists."
fi

# ── 5. SSH hardening ─────────────────────────────────────────────────────────

echo "==> Hardening SSH..."
SSHD_CONFIG="/etc/ssh/sshd_config"

# Backup original config
if [[ ! -f "${SSHD_CONFIG}.bak" ]]; then
  cp "${SSHD_CONFIG}" "${SSHD_CONFIG}.bak"
  echo "    Backed up ${SSHD_CONFIG} → ${SSHD_CONFIG}.bak"
fi

# Apply hardening settings
sed -i "s/^#\?Port .*/Port ${SSH_PORT}/" "${SSHD_CONFIG}"
sed -i 's/^#\?PermitRootLogin .*/PermitRootLogin no/' "${SSHD_CONFIG}"
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' "${SSHD_CONFIG}"
sed -i 's/^#\?ChallengeResponseAuthentication .*/ChallengeResponseAuthentication no/' "${SSHD_CONFIG}"
sed -i 's/^#\?UsePAM .*/UsePAM no/' "${SSHD_CONFIG}"
sed -i 's/^#\?X11Forwarding .*/X11Forwarding no/' "${SSHD_CONFIG}"
sed -i 's/^#\?MaxAuthTries .*/MaxAuthTries 3/' "${SSHD_CONFIG}"

# Ensure at least one SSH key exists before locking out password auth
has_keys=false
for home_dir in /root $(getent passwd | awk -F: '$3 >= 1000 { print $6 }'); do
  if [[ -s "${home_dir}/.ssh/authorized_keys" ]]; then
    has_keys=true
    break
  fi
done

if [[ "${has_keys}" != "true" ]]; then
  echo "WARNING: No SSH authorized_keys found!" >&2
  echo "         Make sure you have SSH key access before rebooting." >&2
  echo "         Skipping SSH restart to avoid lockout." >&2
else
  if sshd -t; then
    systemctl restart sshd
  else
    echo "ERROR: sshd config validation failed! Restoring backup..." >&2
    cp "${SSHD_CONFIG}.bak" "${SSHD_CONFIG}"
    echo "         Restored original config. Please fix manually." >&2
    exit 1
  fi
fi

# ── 6. Firewall (ufw) ────────────────────────────────────────────────────────

echo "==> Configuring firewall..."
ufw default deny incoming
ufw default allow outgoing
ufw allow "${SSH_PORT}/tcp" comment "SSH"
ufw allow 80/tcp comment "HTTP"
ufw allow 443/tcp comment "HTTPS"
ufw --force enable

# ── 7. fail2ban ──────────────────────────────────────────────────────────────

echo "==> Configuring fail2ban..."
cat > /etc/fail2ban/jail.local <<EOF
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
port    = ${SSH_PORT}
filter  = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime  = 24h
EOF

systemctl enable fail2ban
systemctl restart fail2ban

# ── 8. Automatic security updates ────────────────────────────────────────────

echo "==> Enabling automatic security updates..."
cat > /etc/apt/apt.conf.d/50unattended-upgrades <<'EOF'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
};
Unattended-Upgrade::AutoFixInterruptedDpkg "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
EOF

cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

# ── 9. Create service user ───────────────────────────────────────────────────

echo "==> Creating service user '${SERVICE_USER}'..."
if ! id "${SERVICE_USER}" &>/dev/null; then
  useradd --system --shell /usr/sbin/nologin --home-dir "${INSTALL_DIR}" "${SERVICE_USER}"
fi

# ── 10. Clone and build application ──────────────────────────────────────────

echo "==> Deploying application to ${INSTALL_DIR}..."
# Allow root to operate on repo owned by service user (from previous chown)
git config --global --add safe.directory "${INSTALL_DIR}" 2>/dev/null || true
if [[ -d "${INSTALL_DIR}/.git" ]]; then
  echo "    Repository exists — pulling latest..."
  cd "${INSTALL_DIR}"
  if [[ -n "$(git status --porcelain)" ]]; then
    STASH_MSG="auto-stash before deploy $(date -u +%Y%m%dT%H%M%SZ)"
    echo "    Stashing uncommitted changes: ${STASH_MSG}" >&2
    git stash push -u -m "${STASH_MSG}"
    echo "    Restore later with: cd ${INSTALL_DIR} && git stash pop" >&2
  fi
  git fetch origin main
  git reset --hard origin/main
else
  git clone "${REPO_URL}" "${INSTALL_DIR}"
  cd "${INSTALL_DIR}"
fi

echo "==> Installing dependencies and building..."
if ! npm ci; then
  echo "ERROR: npm ci failed. Check node_modules and package-lock.json." >&2
  echo "       Try: rm -rf node_modules package-lock.json && npm install" >&2
  exit 1
fi
if ! npx turbo run build; then
  echo "ERROR: Build failed. Check TypeScript errors above." >&2
  echo "       Try: npx turbo run build --filter=@muddown/server..." >&2
  exit 1
fi

# Set ownership
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"

# ── 11. Create .env template ─────────────────────────────────────────────────

ENV_FILE="${INSTALL_DIR}/packages/server/.env"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "==> Creating .env template..."
  cat > "${ENV_FILE}" <<'ENVEOF'
# MUDdown Server Environment
# Fill in values and restart: systemctl restart muddown-server

PORT=3300
MUDDOWN_DB=/opt/muddown/packages/server/muddown.sqlite
WEBSITE_ORIGIN=https://muddown.com

# GitHub OAuth (optional)
# GITHUB_CLIENT_ID=
# GITHUB_CLIENT_SECRET=
# GITHUB_CALLBACK_URL=https://muddown.com/auth/callback

# Microsoft OAuth (optional)
# MICROSOFT_CLIENT_ID=
# MICROSOFT_CLIENT_SECRET=
# MICROSOFT_CALLBACK_URL=https://muddown.com/auth/callback

# Google OAuth (optional)
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# GOOGLE_CALLBACK_URL=https://muddown.com/auth/callback
ENVEOF
  chown "${SERVICE_USER}:${SERVICE_USER}" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  echo "    Created ${ENV_FILE} — edit with your secrets before starting."
fi

# ── 12. Install systemd service ──────────────────────────────────────────────

echo "==> Installing systemd service..."
if [[ -f "${INSTALL_DIR}/deploy/muddown-server.service" ]]; then
  cp "${INSTALL_DIR}/deploy/muddown-server.service" /etc/systemd/system/
elif [[ -f "${SCRIPT_DIR}/muddown-server.service" ]]; then
  cp "${SCRIPT_DIR}/muddown-server.service" /etc/systemd/system/
else
  echo "ERROR: muddown-server.service not found in repo or script dir." >&2
  echo "       Copy the full deploy/ directory: scp -r deploy root@<ip>:/root/deploy" >&2
  exit 1
fi
systemctl daemon-reload
systemctl enable muddown-server

# ── 13. Configure nginx ──────────────────────────────────────────────────────

echo "==> Configuring nginx..."

# Determine source directory for nginx configs
NGINX_SRC=""
if [[ -f "${INSTALL_DIR}/deploy/nginx/muddown.conf" ]]; then
  NGINX_SRC="${INSTALL_DIR}/deploy/nginx"
elif [[ -f "${SCRIPT_DIR}/nginx/muddown.conf" ]]; then
  NGINX_SRC="${SCRIPT_DIR}/nginx"
else
  echo "ERROR: nginx config not found in repo or script dir." >&2
  echo "       Copy the full deploy/ directory: scp -r deploy root@<ip>:/root/deploy" >&2
  exit 1
fi

# Always safe to copy snippets (certbot doesn't modify these)
cp "${NGINX_SRC}/security-headers.conf" /etc/nginx/snippets/muddown-security-headers.conf
[[ -f "${NGINX_SRC}/muddown-proxy.conf" ]] && cp "${NGINX_SRC}/muddown-proxy.conf" /etc/nginx/snippets/muddown-proxy.conf

# Only copy the main site config on first install — certbot modifies it in
# place to add the HTTPS server block, so overwriting it after TLS setup
# would remove SSL and take the site down.
if [[ ! -f /etc/nginx/sites-available/muddown.conf ]]; then
  cp "${NGINX_SRC}/muddown.conf" /etc/nginx/sites-available/
  echo "    Installed muddown.conf (first-time setup)."
else
  echo "    muddown.conf already exists — skipping to preserve certbot SSL config."
  echo "    To update nginx locations, edit /etc/nginx/sites-available/muddown.conf manually."
fi
ln -sf /etc/nginx/sites-available/muddown.conf /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

if ! nginx -t; then
  echo "ERROR: nginx config test failed!" >&2
  echo "       Check: /etc/nginx/sites-available/muddown.conf" >&2
  echo "       Check: /etc/nginx/snippets/muddown-security-headers.conf" >&2
  echo "       Fix the config and run: nginx -t && systemctl reload nginx" >&2
  exit 1
fi
systemctl enable nginx
systemctl reload nginx

# ── 14. Harden file permissions ──────────────────────────────────────────────

echo "==> Setting file permissions..."
chmod 750 "${INSTALL_DIR}"
if [[ -f "${ENV_FILE}" ]]; then
  chmod 600 "${ENV_FILE}"
else
  echo "WARNING: ${ENV_FILE} not found — skipping permission set." >&2
fi

# Ensure SQLite DB directory is writable by service user
mkdir -p "${INSTALL_DIR}/packages/server"
chown "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}/packages/server"

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "============================================"
echo "  MUDdown server setup complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Edit secrets:   nano ${ENV_FILE}"
echo "  2. Start server:   systemctl start muddown-server"
echo "  3. Check status:   systemctl status muddown-server"
echo "  4. View logs:      journalctl -u muddown-server -f"
SERVER_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || curl -s --max-time 5 icanhazip.com 2>/dev/null || echo '<this-ip>')
echo "  5. Point DNS:      muddown.com → ${SERVER_IP}"
echo "  6. Enable TLS:     certbot --nginx -d muddown.com -d www.muddown.com"
echo ""
if [[ "${SSH_PORT}" != "22" ]]; then
  echo "  SSH port changed to ${SSH_PORT}. Reconnect with:"
  echo "    ssh -p ${SSH_PORT} <user>@<ip>"
  echo ""
fi
