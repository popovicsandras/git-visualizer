// Entry point: serves the app and its shared sessions (see server/).
import { networkInterfaces } from 'node:os';
import { createAppServer } from './server/app.js';

const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';

const server = createAppServer();

// In a container (see Dockerfile) node is PID 1, and PID 1 ignores SIGTERM unless
// the process exits itself, so every stop or redeploy would wait for a SIGKILL.
// Sessions live only in memory, so there is nothing to save first.
process.on('SIGTERM', () => process.exit(0));

server.listen(PORT, HOST, () => {
  console.log(`git-visualizer running at http://${HOST}:${PORT}`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    // Show the addresses teammates on the network can use.
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list ?? []) {
        if (!a.internal && a.family === 'IPv4') console.log(`  on your network: http://${a.address}:${PORT}`);
      }
    }
  } else if (HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1') {
    console.log('  Only this computer can connect. To invite teammates on your network: HOST=0.0.0.0 npm start');
  }
});
