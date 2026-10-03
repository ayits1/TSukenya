#!/bin/sh
# One-time VPS setup for deploys from GitHub Actions. Run as root on the VPS:
#   curl -fsSL https://raw.githubusercontent.com/ayits1/TSukenya/main/deploy/setup_ci_deploy.sh | sh
# It installs the forced-command program, creates a dedicated SSH key that can run only that
# program (no shell, no forwarding), and prints the two values to store as GitHub secrets.
# Re-running replaces the program and keeps the existing key. Remove access: delete the line
# ending with "tsukenya-github-deploy" from /root/.ssh/authorized_keys.
set -eu
[ "$(id -u)" = 0 ] || { echo "Запустіть від root." >&2; exit 1; }
[ -d /opt/tsukenya ] || { echo "Немає /opt/tsukenya." >&2; exit 1; }
REF="${TSUKENYA_SETUP_REF:-main}"
umask 077
curl -fsSL "https://raw.githubusercontent.com/ayits1/TSukenya/$REF/deploy/ci_deploy.py" -o /usr/local/sbin/tsukenya-ci-deploy.new
python3 -m py_compile /usr/local/sbin/tsukenya-ci-deploy.new
chmod 0700 /usr/local/sbin/tsukenya-ci-deploy.new
mv /usr/local/sbin/tsukenya-ci-deploy.new /usr/local/sbin/tsukenya-ci-deploy
mkdir -p /root/.ssh && chmod 700 /root/.ssh
KEY=/root/.ssh/tsukenya_github_deploy
[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -C tsukenya-github-deploy -f "$KEY"
LINE="restrict,command=\"/usr/local/sbin/tsukenya-ci-deploy\" $(cat "$KEY.pub")"
touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
grep -q 'tsukenya-github-deploy$' /root/.ssh/authorized_keys || echo "$LINE" >> /root/.ssh/authorized_keys
ADDRESS="$(curl -fsS4 https://api.ipify.org 2>/dev/null || hostname -I | cut -d' ' -f1)"
echo
echo "Готово. Додайте в GitHub: репозиторій → Settings → Secrets and variables → Actions → New repository secret."
echo
echo "1) Назва: DEPLOY_SSH_KEY — значення (увесь блок, з рядками BEGIN/END):"
cat "$KEY"
echo
echo "2) Назва: DEPLOY_KNOWN_HOSTS — значення (один рядок):"
echo "$ADDRESS $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
echo
echo "Приватний ключ залишається на сервері в $KEY; після додавання секрету його можна видалити: rm $KEY"
