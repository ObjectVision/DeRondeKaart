# Debian-based image: @hocuspocus/extension-sqlite depends on better-sqlite3,
# whose native build is more reliable here than on alpine.
FROM node:20 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
ENV PORT=5174
ENV DB_PATH=/data/annotations.db
EXPOSE 5174
CMD ["node", "dist/index.js"]
