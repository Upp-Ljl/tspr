/**
 * Tiny 3-page Express site for ui-explore tests.
 * Pages:
 *   /          — home with links to /about and /settings
 *   /about     — static info page with a link back home
 *   /settings  — form with inputs and a submit button
 *   /missing   — intentionally absent (causes 404 on sub-resource to test exception capture)
 */
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const HOME_HTML = `<!DOCTYPE html>
<html>
<head><title>Home — Tiny Site</title></head>
<body>
  <h1>Home</h1>
  <nav>
    <a href="/about">About</a>
    <a href="/settings">Settings</a>
  </nav>
  <img src="/missing-asset.png" alt="missing" />
</body>
</html>`;

const ABOUT_HTML = `<!DOCTYPE html>
<html>
<head><title>About — Tiny Site</title></head>
<body>
  <h1>About</h1>
  <p>This is a test fixture site for tspr ui-explore tests.</p>
  <a href="/">Home</a>
  <button type="button">Learn More</button>
</body>
</html>`;

const SETTINGS_HTML = `<!DOCTYPE html>
<html>
<head><title>Settings — Tiny Site</title></head>
<body>
  <h1>Settings</h1>
  <form action="/settings" method="POST">
    <label>Username: <input type="text" name="username" /></label>
    <label>Email: <input type="email" name="email" /></label>
    <label>Password: <input type="password" name="password" /></label>
    <button type="submit">Save Settings</button>
  </form>
  <a href="/">Home</a>
</body>
</html>`;

const SETTINGS_POST_HTML = `<!DOCTYPE html>
<html>
<head><title>Settings Saved — Tiny Site</title></head>
<body>
  <h1>Settings Saved</h1>
  <p>Your settings have been saved.</p>
  <a href="/">Home</a>
</body>
</html>`;

const PROTECTED_HTML = `<!DOCTYPE html>
<html>
<head><title>Protected — Tiny Site</title></head>
<body>
  <h1>Protected Page</h1>
  <p>You are logged in.</p>
  <a href="/">Home</a>
</body>
</html>`;

export interface TinySite {
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * Start the tiny site on a given port.
 * Returns baseUrl and a close() function.
 */
export async function startTinySite(port: number): Promise<TinySite> {
  const app = express();
  app.use(express.urlencoded({ extended: true }));

  // Track session cookies for login tests
  const activeSessions = new Set<string>();

  app.get('/', (_req, res) => res.send(HOME_HTML));
  app.get('/about', (_req, res) => res.send(ABOUT_HTML));
  app.get('/settings', (_req, res) => res.send(SETTINGS_HTML));
  app.post('/settings', (_req, res) => res.send(SETTINGS_POST_HTML));

  // Login endpoint for login tests
  app.get('/login', (_req, res) => {
    res.send(`<!DOCTYPE html>
<html><head><title>Login — Tiny Site</title></head>
<body>
  <h1>Login</h1>
  <form action="/login" method="POST">
    <input type="text" name="username" placeholder="Username" />
    <input type="password" name="password" />
    <button type="submit">Login</button>
  </form>
</body></html>`);
  });

  app.post('/login', (req, res) => {
    const { username, password } = req.body as { username?: string; password?: string };
    if (username === 'testuser' && password === 'testpass') {
      const sessionId = Math.random().toString(36).slice(2);
      activeSessions.add(sessionId);
      res.setHeader('Set-Cookie', `session=${sessionId}; Path=/; HttpOnly`);
      res.redirect('/protected');
    } else {
      res.status(401).send('Invalid credentials');
    }
  });

  app.get('/protected', (req, res) => {
    const cookies = parseCookies(req.headers['cookie'] ?? '');
    const sessionId = cookies['session'];
    if (sessionId && activeSessions.has(sessionId)) {
      res.send(PROTECTED_HTML);
    } else {
      res.redirect('/login');
    }
  });

  // 404 for missing assets (intentional for exception tests)
  // express default 404 handles this

  return new Promise((resolve, reject) => {
    let server: Server;
    server = app.listen(port, () => {
      const addr = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://localhost:${addr.port}`,
        close: () => new Promise((res, rej) => server.close(err => err ? rej(err) : res())),
      });
    });
    server.on('error', reject);
  });
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k && v !== undefined) cookies[k.trim()] = v.trim();
  }
  return cookies;
}
