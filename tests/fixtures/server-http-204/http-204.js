// HTTP server — always returns 204 No Content
// Binds on PORT env var
const http = require('http');
const port = parseInt(process.env.PORT || '3000', 10);

const server = http.createServer((req, res) => {
  res.writeHead(204);
  res.end();
});

server.listen(port, '0.0.0.0', () => {
  process.stdout.write(`HTTP 204 server listening on port ${port}\n`);
});

server.on('error', (err) => {
  process.stderr.write(`Server error: ${err.message}\n`);
  process.exit(1);
});
