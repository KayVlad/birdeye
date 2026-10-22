FROM node:24-alpine
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY --chown=node:node backend/*.cjs ./backend/
COPY --chown=node:node site/dist/ ./site/dist/
USER node
ENV BIRDEYE_DB=/data/birdeye.db BIND_ADDRESS=0.0.0.0 PORT=8081
EXPOSE 8081
CMD ["node", "backend/server.cjs"]
