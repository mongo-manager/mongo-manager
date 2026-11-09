// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
// Mongo Manager under PM2 (prefer `mongo-manager service install`, which adds OS sandboxing).
// Install first: npm install --global @mongo-manager/app
module.exports = {
  apps: [
    {
      name: 'mongo-manager',
      script: 'mongo-manager',
      args: 'start --auth --no-open',
      interpreter: 'none',
      autorestart: true,
      // Its own data directory: a system service uses /var/lib/mongo-manager with its own account.
      env: { MM_DATA_DIR: '/var/lib/mongo-manager-pm2' },
    },
  ],
}
