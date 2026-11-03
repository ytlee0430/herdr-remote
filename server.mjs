import http from 'node:http';

const service = 'herdr-connectivity-poc';
const port = Number(process.env.PORT || 3000);
const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET' });
    return res.end();
  }
  if (path === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'X-Accel-Buffering': 'no',
    });
    let count = 0;
    const send = () => {
      res.write(`data: ${JSON.stringify({ service, count: ++count, time: new Date().toISOString() })}\n\n`);
      if (count === 5) {
        clearInterval(timer);
        res.end();
      }
    };
    const timer = setInterval(send, 1000);
    res.on('close', () => clearInterval(timer));
    send();
    return;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (path !== '/' && path !== '/health') {
    res.writeHead(404);
    return res.end(JSON.stringify({ error: 'not_found' }) + '\n');
  }
  res.end(JSON.stringify({ ok: true, service, time: new Date().toISOString() }) + '\n');
});

server.requestTimeout = 10000;
server.headersTimeout = 10000;
server.maxConnections = 100;
server.listen(port, '0.0.0.0', () => console.log(`${service} listening on 0.0.0.0:${port}`));
