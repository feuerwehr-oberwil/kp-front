# Caddy + the rate-limit module.
#
# Stock caddy has no `rate_limit` directive, and Caddy refuses to start on a directive it
# doesn't know rather than ignoring it. That is the behaviour we want — an ingest that came
# up without its limits would be worse than one that didn't come up — but it does mean the
# image has to be built rather than pulled.
FROM caddy:2-builder-alpine AS builder
RUN xcaddy build --with github.com/mholt/caddy-ratelimit

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
