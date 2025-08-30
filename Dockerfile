FROM node:20-slim

# Create nonroot user
RUN useradd -m appuser
WORKDIR /app

# Install deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY index.js ./

# Security hardening
USER appuser
ENV NODE_ENV=production PORT=8080

EXPOSE 8080
CMD ["node", "index.js"]