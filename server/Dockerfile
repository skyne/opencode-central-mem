FROM oven/bun:1.2-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN mkdir -p /app/data

ENV PORT=3737
EXPOSE 3737

CMD ["bun", "run", "src/index.ts"]
