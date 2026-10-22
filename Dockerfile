FROM nginxinc/nginx-unprivileged:stable-alpine

COPY --chown=101:101 docker/nginx.conf /etc/nginx/nginx.conf
COPY --chown=101:101 site/dist/ /usr/share/nginx/html/

USER 101:101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

# The static configuration needs no entrypoint templating or writable config.
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
