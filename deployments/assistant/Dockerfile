FROM oven/bun:1-debian
# server_bash and MCP servers expect a normal Linux userland: bash, git, curl, jq,
# ripgrep, python3, and Node/npm for npx-based MCP servers.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq nodejs npm python3 ripgrep \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY index.ts cli.ts tsconfig.json ./
COPY src ./src

RUN mkdir -p /data && chown bun:bun /data
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh

ENV BASEDIR=/data \
    PORT=8787 \
    BIND_HOST=0.0.0.0 \
    HOME=/home/bun

EXPOSE 8787
VOLUME ["/data"]
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "index.ts"]
