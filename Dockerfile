FROM mcr.microsoft.com/playwright:v1.47.0-jammy
WORKDIR /app

# 1) Capas cacheables primero
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 2) Solo Chromium (evita ~2/3 del tiempo y del tamaño)
RUN npx playwright install chromium --with-deps

# 3) Copiar el resto del código
COPY . .

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "PruebaLeerCedulas.js"]
