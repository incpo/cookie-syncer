FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

COPY index.ts ./

EXPOSE 3456

CMD ["bun", "run", "index.ts"]
