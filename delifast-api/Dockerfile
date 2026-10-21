FROM node:24.19.0-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts --no-audit
COPY . .
RUN npm run build
FROM node:24.19.0-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=4000 HOST=0.0.0.0 MONGODB_URI=mongodb://mongo:27017/delifast
COPY --from=build /app/package*.json ./
RUN npm ci --ignore-scripts --no-audit --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/schema ./schema
EXPOSE 4000
CMD ["node","dist/src/server.js"]
