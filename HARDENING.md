# Runtime and supply-chain hardening

`.npmrc` explains its own settings inline. JSON files can't hold comments
(Node rejects unknown keys in `node.config.json`), so this file explains
the rest.

## `npm start`: Node 26 sandbox

`npm start` runs
`node --disallow-code-generation-from-strings --config-file=node.config.json server.js`.

The `permission` block in [node.config.json](node.config.json) turns on the
Node [Permission Model](https://nodejs.org/docs/latest-v26.x/api/permissions.html).
Its presence alone enables `--permission`. Everything not granted below is denied
with `ERR_ACCESS_DENIED`: file writes, child processes, worker threads, native
addons, WASI, FFI, the inspector.

| Setting | What it does | Why here |
|---|---|---|
| `permission.allow-fs-read: ["./public", "./server"]` | The server may read only `public/` (the static files, and the git engine it runs for shared sessions) and `server/` (its own modules), plus its entry point, which is always allowed. | Even if the path-traversal check in `server/app.js` had a bug, the process couldn't read `~/.ssh`, `.env`, etc. Paths are relative to the working directory, so start the server from the project root (`npm start` does). A new top-level folder of server code must be added here, or importing it fails with `ERR_ACCESS_DENIED`. |
| `permission.allow-net: true` | Allows sockets. Without it, `listen()` is denied. | The server has to listen. It's all-or-nothing today (no host/port scoping), and the flag is marked Stability 1.1 (active development) since Node 25, so Node prints an `ExperimentalWarning` on every start. That warning is expected. |
| `nodeOptions.disable-proto: "throw"` | Accessing `obj.__proto__` throws `ERR_PROTO_ACCESS`. | Cheap defense-in-depth against prototype pollution. The server now runs typed git commands, so it matters more: every lookup keyed by user text uses a `Map`, a `switch`, or `Object.hasOwn` (e.g. `git __proto__` gets "not a git command" instead of a throw), and the hub catches anything a message handler throws. |
| `nodeOptions.disable-sigusr1: true` | `kill -USR1 <pid>` no longer opens a debugger. | Another local process can't attach to the running server. The permission model already does this; the setting keeps it if the permission block is ever removed. |
| `--disallow-code-generation-from-strings` (in the start script) | `eval()` and `new Function("…")` throw. | Cheap defense-in-depth: code injected as a string can't be turned into running code on the server. It's a V8 flag, so it can't go in `node.config.json`. (It does nothing in the browser, where the existing CSP without `'unsafe-eval'` already blocks `eval`.) |

`--config-file` is stable since Node 26.12 (`--experimental-config-file` is
still accepted as an alias). Write it as `--config-file=<path>`: the bare form
could take `server.js` as the config path.

### Shared sessions (WebSocket)

Sessions run over a WebSocket at `/ws`. Node ships a WebSocket *client* but no
server, so [server/ws.js](server/ws.js) implements the small part of RFC 6455
that browsers use, instead of adding the `ws` package. The rest of this file
assumes zero dependencies.

- **Origin check.** A handshake whose `Origin` header doesn't match `Host` gets
  `403`. That stops other web pages from opening a socket here through a
  visitor's browser (cross-site WebSocket hijacking). Non-browser clients may
  leave `Origin` out.
- **Frame rules.** Client frames must be masked, text only (binary closes with
  `1003`), valid UTF-8 (`1007`), at most 16 KiB per message, fragmented or not
  (`1009`). Control frames follow the RFC limits. A client that stops reading
  is dropped once 4 MiB is queued for it, and one that stops answering pings
  is dropped by the 30-second heartbeat.
- **Input limits** ([server/hub.js](server/hub.js) `LIMITS`): names up to 24
  characters, with no control, zero-width or bidi-override characters;
  commands up to 1000 characters; 20 messages per second per connection, with
  bursts up to 40; at most 1000 sessions and 50 people per session. Sessions
  are never deleted while the server runs, so the session cap is what bounds
  memory.
- **Session codes and rejoin tokens** come from `node:crypto`. Codes are 12
  characters, about 59 bits; tokens are 144 bits. There are no accounts: a
  person who is offline can be rejoined by name. That's fine for a classroom
  playground, but don't put anything private in commit messages.
- **`HOST` stays `127.0.0.1` by default**, so only this computer can connect.
  `HOST=0.0.0.0 npm start` serves the whole network over plain `ws://`/`http://`
  without TLS. Use it on a network you trust, or put a TLS proxy in front.
  The client switches to `wss://` automatically when the page is served over
  https.

### Deliberately not used

- **`npm test` doesn't use the sandbox.** The test runner runs each test file in
  a child process, which the sandbox would block. Tests run only our own code
  with no dependencies, so a sandbox adds little there.
- **`frozen-intrinsics`**: still experimental.
- **`addons: false` (`--no-addons`)**: redundant, because the permission model
  already blocks native addons unless `allow-addons` is set.

## `devEngines` in package.json

`engines` describes what a *consumer* of the package needs, and npm only checks
it for dependencies. `devEngines` describes the environment for *developing*
this project. With `onFail: "error"`, npm stops with `EBADDEVENGINES` when the
active Node or npm is older than the versions listed. This was checked on
npm 10.9 / Node 22: both `npm install` and `npm test` refuse to run. That
matters because older npm versions silently ignore most of the `.npmrc`
policies. Run `nvm use` (it reads `.nvmrc`) to switch to Node 26.

## Hosting: Dockerfile, Render and CI

The app is hosted on [Render](https://render.com)'s free tier, built from the
[Dockerfile](Dockerfile) and configured in [render.yaml](render.yaml). The test
workflow ([.github/workflows/test.yml](.github/workflows/test.yml)) runs on
every push to `main`, and Render deploys a push only after those checks pass.

- **Stock Node 26 ships npm 11.** Node 26.13.0 bundles npm 11.20, which
  `devEngines` rejects, so the container and CI run `node` directly instead of
  `npm start` / `npm test`. **If you change either script in package.json,
  change the `CMD` in the Dockerfile or the `run` step in the workflow too.**
- **Pinned versions.** The base image is pinned by tag and digest, and the
  GitHub Actions by commit SHA, so a re-pushed tag can't change what runs.
  When you bump Node, update `.nvmrc` and the Dockerfile together.
- **In the container:** the server runs as the unprivileged `node` user, and
  the app files are owned by root, so it can't modify them. Only the files the
  server needs are copied in (`.dockerignore` is an allowlist).
- **`HOST=0.0.0.0` is set in the image**, because the container is reached
  through Render's proxy. Render terminates TLS, so browsers connect over
  `https`/`wss`.
- **SIGTERM:** in a container, node is PID 1, which ignores SIGTERM unless it
  is handled, so `server.js` exits on it. Without the handler, every redeploy
  waited for a SIGKILL.
- **Sessions are wiped on every deploy and restart** (they live in memory),
  and also when the free instance sleeps after 15 minutes without traffic.
