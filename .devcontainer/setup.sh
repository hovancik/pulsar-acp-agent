set -eu

. "$NVM_DIR/nvm.sh" --no-use
nvm install
nvm alias default "$(nvm current)"
npm ci
