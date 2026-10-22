FROM node:24-slim

# ssh and rsync reach the servers; curl checks each site after updating
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client rsync curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.js updater.sh ./
COPY lib lib
COPY public public

# /ssh becomes the "ssh" named volume: on a Windows bind mount the private key would read as 0777 and ssh would refuse it
RUN mkdir -p /app/data /ssh && chown node:node /app/data /ssh
USER node

ENV WPU_BIND=0.0.0.0 WPU_DATA=/app/data WPU_SSH_DIR=/ssh
EXPOSE 8787
CMD ["node", "server.js"]
