FROM oven/bun:1-alpine
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY index.ts cli.ts tsconfig.json ./
COPY src ./src

RUN mkdir -p /data && chown bun:bun /data

ENV BASEDIR=/data \
    PORT=8787 \
    BIND_HOST=0.0.0.0

EXPOSE 8787
VOLUME ["/data"]
USER bun
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "index.ts"]
