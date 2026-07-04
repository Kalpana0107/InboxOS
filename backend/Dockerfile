# Use node:20-alpine as the base image for a lightweight runtime environment
FROM node:20-alpine
RUN apk add --no-cache openssl libc6-compat
# Set working directory inside the container
WORKDIR /usr/src/app

# Copy package files for dependency installation
COPY package*.json ./

# Install project dependencies
RUN npm ci

# Copy Prisma schema definition
COPY prisma ./prisma/

# Generate Prisma Client (performed during build so types are available)
RUN npx prisma generate

# Copy the rest of the application files
COPY --chown=node:node . .

# Package managers are build-time tools. Remove them from the runtime image to
# reduce attack surface and avoid shipping their dependency trees.
RUN rm -rf /usr/local/lib/node_modules/npm \
    /usr/local/lib/node_modules/corepack \
    /opt/yarn-v1.22.22 \
    /root/.npm \
    && rm -f /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/bin/corepack \
    /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg

# Winston writes production logs here; dependencies remain root-owned and
# read-only to the runtime user.
RUN mkdir -p /usr/src/app/logs && chown node:node /usr/src/app/logs

# Switch to the non-root 'node' user for enhanced security
USER node

# Expose the API server port
EXPOSE 8000

# Default command to run the backend server (can be overridden in docker-compose)
CMD ["./node_modules/.bin/ts-node", "src/server.ts"]
