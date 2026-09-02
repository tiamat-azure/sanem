FROM node:22-alpine

# ffmpeg also provides ffprobe. ~80 MB, the assumed cost of PRD §10 (media
# analysis, thumbnails, on-demand HLS transcoding).
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY public/ ./public/

# node:22-alpine ships a preexisting "node" user (uid/gid 1000), which
# matches the compose "user: 1000:1000" override.
USER node

EXPOSE 3900

CMD ["node", "src/server.js"]
