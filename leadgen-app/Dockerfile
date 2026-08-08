# Optional: Coolify can usually build this app automatically via Nixpacks
# (it detects package.json). This Dockerfile is a fallback if you'd rather
# point Coolify at an explicit Dockerfile build, or if Nixpacks struggles
# compiling the native better-sqlite3 module on your server's architecture.

FROM node:20-slim

WORKDIR /app

# better-sqlite3 needs build tools to compile its native binding
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p data

EXPOSE 3000

CMD ["node", "server.js"]
