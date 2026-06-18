FROM node:20-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg libheif-examples python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.html app.js styles.css dev-server.mjs README.md ./

ENV NODE_ENV=production
ENV PORT=5173
ENV WORKSPACE=/workspace
ENV CONFIG_DIR=/config

RUN mkdir -p /workspace /config

EXPOSE 5173

CMD ["sh", "-c", "node dev-server.mjs \"$PORT\" \"$WORKSPACE\""]
