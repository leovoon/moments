# Moments - Family Video Sharing App
FROM oven/bun:1-alpine AS base

WORKDIR /app

# Install ffmpeg for video processing (optional)
RUN apk add --no-cache ffmpeg

# Copy package files
COPY package.json bun.lockb* ./

# Install dependencies
RUN bun install --frozen-lockfile || bun install

# Copy source code
COPY . .

# Create storage directories
RUN mkdir -p storage/videos

# Expose port
EXPOSE 3000

# Run the server
CMD ["bun", "run", "server.ts"]
