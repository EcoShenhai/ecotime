// PM2: two processes, fork mode. The API answers requests; the scheduler claims due jobs with leases (§10).
// No settings here: database and secrets live only in backend/.env (§13.1).
module.exports = {
  apps: [
    { name: 'ecotime-backend', cwd: `${__dirname}/backend`, script: 'src/server.js', exec_mode: 'fork', max_memory_restart: '250M', env: { NODE_ENV: 'production' } },
    { name: 'ecotime-scheduler', cwd: `${__dirname}/backend`, script: 'src/jobs/schedulerWorker.js', exec_mode: 'fork', max_memory_restart: '200M', kill_timeout: 20000, env: { NODE_ENV: 'production' } },
  ],
};
