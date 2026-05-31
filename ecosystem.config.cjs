// pm2 process manager config (cross-platform).
//   npm run build && pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup     # persist across reboots (follow printed instructions)
// Runs in YOUR user context so the `claude login` subscription credentials are available.
const path = require('node:path');
const os = require('node:os');

const dataDir = process.env.ZAMOLXIS_DATA_DIR || path.join(os.homedir(), '.zamolxis');

module.exports = {
  apps: [
    {
      name: 'zamolxis',
      script: 'dist/index.js',
      cwd: __dirname,
      node_args: '--enable-source-maps',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '600M',
      env: { NODE_ENV: 'production' },
      out_file: path.join(dataDir, 'logs', 'zamolxis.out.log'),
      error_file: path.join(dataDir, 'logs', 'zamolxis.err.log'),
      time: true,
    },
  ],
};
