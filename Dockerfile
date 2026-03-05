FROM node:22-alpine

WORKDIR /app

# Chromium runtime deps for CDP login flow
RUN apk add --no-cache \
  chromium \
  nss \
  freetype \
  harfbuzz \
  ca-certificates \
  ttf-freefont

COPY package*.json ./
RUN npm ci --omit=dev || npm ci

COPY . .

ENV NODE_ENV=production
ENV LOGIN_SERVER_PORT=3456
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

EXPOSE 3456

CMD ["npm", "run", "server"]
