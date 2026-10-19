FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
ENV DELIFAST_LOCAL_MODE=true NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24.19.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production DELIFAST_LOCAL_MODE=true NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.mjs ./next.config.mjs
USER node
EXPOSE 3000
CMD ["npm", "start", "--", "--hostname", "0.0.0.0", "--port", "3000"]
