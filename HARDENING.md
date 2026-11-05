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
| `permission.allow-fs-read: ["./public"]` | The server may read only `public/` (plus its own entry point, which is always allowed). | Even if the path-traversal check in `server.js` had a bug, the process couldn't read `~/.ssh`, `.env`, etc. Paths are relative to the working directory, so start the server from the project root (`npm start` does). |
| `permission.allow-net: true` | Allows sockets. Without it, `listen()` is denied. | The server has to listen. It's all-or-nothing today (no host/port scoping), and the flag is marked Stability 1.1 (active development) since Node 25, so Node prints an `ExperimentalWarning` on every start. That warning is expected. |
| `nodeOptions.disable-proto: "throw"` | Accessing `obj.__proto__` throws `ERR_PROTO_ACCESS`. | Cheap defense-in-depth against prototype pollution. `server.js` merges no user input today, so the risk is low; the flag costs nothing because nothing uses `__proto__`. |
| `nodeOptions.disable-sigusr1: true` | `kill -USR1 <pid>` no longer opens a debugger. | Another local process can't attach to the running server. The permission model already does this; the setting keeps it if the permission block is ever removed. |
| `--disallow-code-generation-from-strings` (in the start script) | `eval()` and `new Function("…")` throw. | Cheap defense-in-depth: code injected as a string can't be turned into running code on the server. It's a V8 flag, so it can't go in `node.config.json`. (It does nothing in the browser, where the existing CSP without `'unsafe-eval'` already blocks `eval`.) |

`--config-file` is stable since Node 26.12 (`--experimental-config-file` is
still accepted as an alias). Write it as `--config-file=<path>`: the bare form
could take `server.js` as the config path.

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
