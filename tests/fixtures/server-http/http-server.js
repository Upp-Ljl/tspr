// HTTP server — responds 200 OK on all routes
// Binds on PORT env var
const http = require('http');
const port = parseInt(process.env.PORT || '3000', 10);

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK\n');
});

server.listen(port, '0.0.0.0', () => {
  process.stdout.write(`HTTP server listening on port ${port}\n`);
});

server.on('error', (err) => {
  process.stderr.write(`Server error: ${err.message}\n`);
  process.exit(1);
});
