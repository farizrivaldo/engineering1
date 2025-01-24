// module.exports = {
//   apps: [
//       {
//           name: "index",
//           script: "index.js",
//           cron_restart: "0 6 * * *", // Setiap hari pukul 6 pagi
//           args: ['--max-heap-size=8GB'],
//       },
//   ],
// };

module.exports = {
  apps: [
    {
      name: "index",
      script: "index.js",
      cron_restart: "0 6 * * *", // Every day at 6 AM
      args: ["--max-heap-size=8GB"],
      autorestart: true,
      max_memory_restart: "2G", // Restart if memory usage exceeds 2GB
    },
  ],
};
