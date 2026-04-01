#!/usr/bin/env bash
# MUDdown Server Setup Script
# Target: Debian 12 (Bookworm) on Linode
#
# What this script does:
#   1. System hardening (SSH, firewall, fail2ban, auto-updates)
#   2. Install runtime dependencies (Node.js 20, nginx)
#   3. Create muddown service user
#   4. Deploy application to /opt/muddown
#   5. Install systemd service
#   6. Configure nginx
#
# Usage:
#   scp deploy/setup.sh root@<your-linode-ip>:/root/
#   ssh root@<your-linode-ip> bash /root/setup.sh
#
# After running, you still need to:
#   - Copy .env file to /opt/muddown/packages/server/.env
#   - Point DNS (muddown.com) to the server IP
#   - Run: certbot --nginx -d muddown.com -d www.muddown.com
#   - Verify: systemctl status muddown-server

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────

SSH_PORT="${SSH_PORT:-22}"
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
echo "    Install dir: ${INSTALL_DIR}"
echo ""

# ── 1. System updates ────────────────────────────────────────────────────────

echo "==> Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq

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

# ── 3. Install Node.js 20 LTS ────────────────────────────────────────────────

if ! command -v node &>/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  echo "==> Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
echo "    Node.js $(node -v), npm $(npm -v)"

# ── 4. SSH hardening ─────────────────────────────────────────────────────────

echo "==> Hardening SSH..."
SSHD_CONFIG="/etc/ssh/sshd_config"

# Backup original config
cp -n "${SSHD_CONFIG}" "${SSHD_CONFIG}.bak" 2>/dev/null || true

# Apply hardening settings
sed -i "s/^#\?Port .*/Port ${SSH_PORT}/" "${SSHD_CONFIG}"
sed -i 's/^#\?PermitRootLogin .*/PermitRootLogin no/' "${SSHD_CONFIG}"
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' "${SSHD_CONFIG}"
sed -i 's/^#\?ChallengeResponseAuthentication .*/ChallengeResponseAuthentication no/' "${SSHD_CONFIG}"
sed -i 's/^#\?UsePAM .*/UsePAM no/' "${SSHD_CONFIG}"
sed -i 's/^#\?X11Forwarding .*/X11Forwarding no/' "${SSHD_CONFIG}"
sed -i 's/^#\?MaxAuthTries .*/MaxAuthTries 3/' "${SSHD_CONFIG}"

# Ensure at least one SSH key exists before locking out password auth
if [[ ! -s /root/.ssh/authorized_keys ]] && [[ ! -d /home/*/.ssh ]]; then
  echo "WARNING: No SSH authorized_keys found!"
  echo "         Make sure you have SSH key access before rebooting."
  echo "         Skipping SSH restart to avoid lockout."
else
  systemctl restart sshd
fi

# ── 5. Firewall (ufw) ────────────────────────────────────────────────────────

echo "==> Configuring firewall..."
ufw default deny incoming
ufw default allow outgoing
ufw allow "${SSH_PORT}/tcp" comment "SSH"
ufw allow 80/tcp comment "HTTP"
ufw allow 443/tcp comment "HTTPS"
ufw --force enable

# ── 6. fail2ban ──────────────────────────────────────────────────────────────

echo "==> Configuring fail2ban..."
cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
port    = ssh
filter  = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime  = 24h
EOF

systemctl enable fail2ban
systemctl restart fail2ban

# ── 7. Automatic security updates ────────────────────────────────────────────

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

# ── 8. Create service user ───────────────────────────────────────────────────

echo "==> Creating service user '${SERVICE_USER}'..."
if ! id "${SERVICE_USER}" &>/dev/null; then
  useradd --system --shell /usr/sbin/nologin --home-dir "${INSTALL_DIR}" "${SERVICE_USER}"
fi

# ── 9. Clone and build application ───────────────────────────────────────────

echo "==> Deploying application to ${INSTALL_DIR}..."
if [[ -d "${INSTALL_DIR}/.git" ]]; then
  echo "    Repository exists — pulling latest..."
  cd "${INSTALL_DIR}"
  git fetch origin main
  git reset --hard origin/main
else
  git clone "${REPO_URL}" "${INSTALL_DIR}"
  cd "${INSTALL_DIR}"
fi

echo "==> Installing dependencies and building..."
npm ci --production=false
npx turbo run build

# Set ownership
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"

# ── 10. Create .env template ─────────────────────────────────────────────────

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

# ── 11. Install systemd service ──────────────────────────────────────────────

echo "==> Installing systemd service..."
cp "${INSTALL_DIR}/deploy/muddown-server.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable muddown-server

# ── 12. Configure nginx ──────────────────────────────────────────────────────

echo "==> Configuring nginx..."
cp "${INSTALL_DIR}/deploy/nginx/muddown.conf" /etc/nginx/sites-available/
ln -sf /etc/nginx/sites-available/muddown.conf /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl enable nginx
systemctl reload nginx

# ── 13. Harden file permissions ──────────────────────────────────────────────

echo "==> Setting file permissions..."
chmod 750 "${INSTALL_DIR}"
chmod 600 "${ENV_FILE}" 2>/dev/null || true

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
echo "  5. Point DNS:      muddown.com → $(curl -s ifconfig.me || echo '<this-ip>')"
echo "  6. Enable TLS:     certbot --nginx -d muddown.com -d www.muddown.com"
echo ""
if [[ "${SSH_PORT}" != "22" ]]; then
  echo "  SSH port changed to ${SSH_PORT}. Reconnect with:"
  echo "    ssh -p ${SSH_PORT} <user>@<ip>"
  echo ""
fi
