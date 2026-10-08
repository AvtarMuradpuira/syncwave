# Build from the app folder:  docker build -f deploy/Dockerfile -t syncwave .
# Run:  docker run -d --name syncwave -p 8080:8080 -v syncwave-data:/data --restart unless-stopped syncwave
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DATA_DIR=/data
COPY package.json ./
# optional: lets the server read tags/duration of mp3, m4a, ogg, opus files right away
RUN npm install --omit=dev --no-audit --no-fund || true
COPY server.js ./
COPY lib ./lib
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
CMD ["node", "--no-warnings", "server.js"]
