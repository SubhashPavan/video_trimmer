FROM node:20-slim

# Install ffmpeg from OS packages (much more reliable than npm binary on Linux)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json* ./

# Install only production deps (skip ffmpeg/ffprobe npm installers — we use OS ffmpeg)
RUN npm ci --omit=dev

COPY . .

# Create upload/output dirs
RUN mkdir -p uploads output

EXPOSE 3000

USER node

CMD ["node", "server.js"]
