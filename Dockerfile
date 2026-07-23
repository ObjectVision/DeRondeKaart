# Stage 1: Build the Vite app
FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Select which config overlay to bake in: configs/<CONFIG_PROJECT>/ is layered
# over the public/ defaults at build time (see vite.config.ts). Empty builds the
# public/ defaults. Pass with: docker build --build-arg CONFIG_PROJECT=<slug>
ARG CONFIG_PROJECT=""
ENV VITE_CONFIG_PROJECT=$CONFIG_PROJECT

RUN npm run build

# Stage 2: Serve with nginx
FROM nginx:alpine

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Copy custom nginx config
COPY deploy/nginx-container.conf /etc/nginx/conf.d/default.conf

# Copy built app from build stage
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
