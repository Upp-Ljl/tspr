// TCP echo server — binds on the port passed as PORT env var (or 4000)
const net = require('net');
const port = parseInt(process.env.PORT || '4000', 10);

const server = net.createServer((socket) => {
  socket.pipe(socket);
});

server.listen(port, '0.0.0.0', () => {
  process.stdout.write(`TCP server listening on port ${port}\n`);
});

server.on('error', (err) => {
  process.stderr.write(`Server error: ${err.message}\n`);
  process.exit(1);
});
