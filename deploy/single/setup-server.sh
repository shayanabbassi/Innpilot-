#!/bin/sh
# Prepares a fresh Ubuntu 24.04 machine (Arm or x86) for the single-server stack (P7-1); docs/staging-runbook.md
# step 4. Run once, as root, with the deploy key's PUBLIC half (made on your laptop for GitHub Actions):
#   sudo sh setup-server.sh "ssh-ed25519 AAAA... innpilot-deploy"
# Does: security updates (now and automatic), Docker from Docker's own repository with log rotation, the firewall
# opened for SSH, HTTP and HTTPS only, and a "deploy" user owning /opt/innpilot that GitHub Actions signs in as.
# Safe to run again.
set -eu

DEPLOY_KEY=${1:-}
DEPLOY_USER=deploy
DEPLOY_DIR=/opt/innpilot

[ "$(id -u)" = 0 ] || { echo 'Run as root: sudo sh setup-server.sh "<deploy public key>"' >&2; exit 1; }
case "$DEPLOY_KEY" in ssh-ed25519\ * | ssh-rsa\ * | ecdsa-sha2-*) ;; *)
  echo 'Give the deploy key PUBLIC half as the first argument (it starts with ssh-ed25519).' >&2
  exit 1
  ;;
esac
# shellcheck source=/dev/null
. /etc/os-release
[ "$ID" = ubuntu ] || { echo "Written for Ubuntu 24.04; this is $PRETTY_NAME." >&2; exit 1; }

echo '==> Security updates'
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -y -q
apt-get install -y -q ca-certificates curl openssl unattended-upgrades
# Security updates install by themselves every day; a reboot they need is left to you (see the runbook).
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

echo '==> Docker (from download.docker.com)'
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
# Container logs rotate instead of filling the disk.
mkdir -p /etc/docker
cat >/etc/docker/daemon.json <<'EOF'
{ "log-driver": "local", "log-opts": { "max-size": "20m", "max-file": "5" } }
EOF
systemctl enable docker >/dev/null
systemctl restart docker

echo '==> Firewall: SSH, HTTP, HTTPS only'
if command -v netfilter-persistent >/dev/null; then
  # Oracle's Ubuntu images ship iptables rules that refuse everything but SSH; open 80 and 443 before that refusal.
  for port in 443 80; do
    iptables -C INPUT -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null ||
      iptables -I INPUT 1 -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT
  done
  netfilter-persistent save >/dev/null
else
  apt-get install -y -q ufw
  ufw default deny incoming >/dev/null
  ufw allow 22/tcp >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
fi
# The database and monitoring publish no port (deploy/compose.yml); only the proxy listens on 80 and 443.

echo "==> Deploy user '$DEPLOY_USER' and $DEPLOY_DIR"
id "$DEPLOY_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$DEPLOY_USER"
# Membership of the docker group is equivalent to root on this machine: keep the deploy key for GitHub Actions only.
usermod -aG docker "$DEPLOY_USER"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh" "$DEPLOY_DIR"
keys="/home/$DEPLOY_USER/.ssh/authorized_keys"
touch "$keys"
grep -qxF "$DEPLOY_KEY" "$keys" || printf '%s\n' "$DEPLOY_KEY" >>"$keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "$keys"
chmod 600 "$keys"

echo
echo "Done. Docker $(docker version --format '{{.Server.Version}}'), $(docker compose version --short) Compose."
echo "Next (runbook step 5): copy init-env.sh to $DEPLOY_DIR and run it there as $DEPLOY_USER."
[ -f /var/run/reboot-required ] && echo 'The updates need a reboot: sudo reboot (then reconnect).' || true
