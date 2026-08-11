#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/opt/fapiao
NODE_VERSION=22.17.0
NODE_PREFIX=/usr/local/node22
NODE_MIRROR=${NODE_MIRROR:-https://npmmirror.com/mirrors/node}
NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmmirror.com}

if [[ $EUID -ne 0 ]]; then
  echo "Run this script as root."
  exit 1
fi

dnf install -y nginx gcc-c++ make python38 python38-devel curl tar xz

if [[ ! -x "$NODE_PREFIX/bin/node" ]]; then
  cd /usr/local/src
  NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
  if ! curl -fL --retry 3 --connect-timeout 20 --max-time 300 -o "$NODE_ARCHIVE" "$NODE_MIRROR/v${NODE_VERSION}/$NODE_ARCHIVE"; then
    curl -fL --retry 3 --connect-timeout 20 --max-time 300 -o "$NODE_ARCHIVE" "https://nodejs.org/dist/v${NODE_VERSION}/$NODE_ARCHIVE"
  fi
  tar -xJf "$NODE_ARCHIVE" -C /usr/local
  ln -sfn "/usr/local/node-v${NODE_VERSION}-linux-x64" "$NODE_PREFIX"
fi

ln -sfn "$NODE_PREFIX/bin/node" /usr/local/bin/node
ln -sfn "$NODE_PREFIX/bin/npm" /usr/local/bin/npm
ln -sfn "$NODE_PREFIX/bin/npx" /usr/local/bin/npx

if ! id fapiao >/dev/null 2>&1; then
  useradd --system --create-home --shell /sbin/nologin fapiao
fi

mkdir -p "$APP_DIR/data" "$APP_DIR/uploads"
chown -R fapiao:fapiao "$APP_DIR"

cd "$APP_DIR"
runuser -u fapiao -- env PATH=/usr/local/bin:/usr/bin:/bin npm_config_registry="$NPM_REGISTRY" /usr/local/bin/npm ci --omit=dev --ignore-scripts
PYTHON_BIN="/usr/bin/python3.8"
runuser -u fapiao -- env PATH=/usr/local/bin:/usr/bin:/bin PYTHON="$PYTHON_BIN" npm_config_disturl="$NODE_MIRROR" npm_config_registry="$NPM_REGISTRY" /usr/local/bin/npm explore better-sqlite3 -- npm run build-release
rm -rf "$APP_DIR/node_modules/better-sqlite3/prebuilds"

install -m 644 deploy/fapiao.service /etc/systemd/system/fapiao.service
install -m 644 deploy/nginx.conf /etc/nginx/conf.d/fapiao.conf

rm -f /etc/nginx/conf.d/default.conf
systemctl daemon-reload
systemctl enable fapiao
systemctl restart fapiao
nginx -t
systemctl enable nginx
systemctl restart nginx

echo "Deployment complete. Open http://SERVER_PUBLIC_IP after allowing TCP port 80 in the ECS security group."
