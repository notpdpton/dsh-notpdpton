/**
 * A local proxy that prints every request it receives, so a person can watch the
 * running Host's traffic arrive (or fail to).
 *
 * This is the manual-verification counterpart to verify-proxy.mjs: that script
 * asserts the routing offline against a proxy it starts and stops inside one
 * process, while this one stays up so the settings page can be driven by hand.
 *
 * usage: node watch-proxy.mjs [port]
 *
 * It handles both request shapes a proxy sees:
 *   - CONNECT host:port   — an https target or a tunnelled http target;
 *   - GET http://host/... — an absolute-form plain-http request.
 *
 * Every line states what arrived, including whether a Proxy-Authorization header
 * came with it, which is how the authentication setting is checked by eye.
 */
import http from 'node:http'

const port = Number(process.argv[2] ?? 0)
const received = []

const server = http.createServer((request, response) => {
  const line = `absolute ${request.url} auth=${request.headers['proxy-authorization'] ?? 'none'}`
  received.push(line)
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`)
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('proxied by watch-proxy')
})

server.on('connect', (request, socket) => {
  const line = `connect  ${request.url} auth=${request.headers['proxy-authorization'] ?? 'none'}`
  received.push(line)
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`)
  // Accept the tunnel and immediately close it: the goal is to observe that the
  // request arrived, not to relay someone's traffic.
  socket.end('HTTP/1.1 200 Connection Established\r\n\r\n')
})

server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port
  console.log(`watch-proxy listening on 127.0.0.1:${actual}`)
  console.log('Enter this address in the proxy settings as:')
  console.log(`  127.0.0.1:${actual}`)
  console.log('Press Ctrl+C to stop. Each line printed is one request that arrived HERE.')
})
