FROM mcr.microsoft.com/playwright:v1.47.0-jammy
WORKDIR /app

# Evita npm ci fallando por falta de lock
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npx playwright install --with-deps chromium

COPY . .
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
EXPOSE 8080
CMD ["node","PruebaLeerCedulas.js"]
