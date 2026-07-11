module.exports = {
  apps: [
    {
      name: 'wapi-api',
      script: 'server.js',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '750M',
      env: {
        NODE_ENV: 'production',
        PORT: 5000
      }
    }
  ]
};
