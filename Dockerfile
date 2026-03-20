FROM node:22-slim

WORKDIR /app

# Chromium runtime deps for CDP login flow
RUN apt-get update && apt-get install -y --no-install-recommends \
  chromium \
  fonts-freefont-ttf \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev || npm ci

COPY . .

ENV NODE_ENV=production
ENV LOGIN_SERVER_PORT=3456
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

EXPOSE 3456

CMD ["npm", "run", "server"]
