# Production image. Render builds it on every deploy (see render.yaml); it also
# runs anywhere else: docker build -t git-visualizer . && docker run -p 5173:5173 git-visualizer
#
# The Node version must match .nvmrc. The digest pins the exact image, so a
# re-pushed tag can't change what runs. To update, bump the tag and the digest:
#   docker buildx imagetools inspect node:<version>-alpine   (the top-level "Digest")
FROM node:26.13.0-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216

WORKDIR /app

# Only what the server needs at runtime. No npm install: there are no dependencies.
COPY package.json node.config.json server.js ./
COPY server ./server
COPY public ./public

# The image's unprivileged user. The files above stay owned by root, so the
# server couldn't change them even without the Node permission model.
USER node

# Listen on all interfaces inside the container; the default 127.0.0.1 can't be
# reached from outside it. Render sets PORT itself; elsewhere it defaults to 5173.
ENV HOST=0.0.0.0

# The same command as `npm start`. npm isn't used: this image ships npm 11.20,
# older than package.json's devEngines requires, so npm would refuse to run.
# Starting node directly also makes it PID 1, so it gets SIGTERM (see server.js).
CMD ["node", "--disallow-code-generation-from-strings", "--config-file=node.config.json", "server.js"]
