FROM mcr.microsoft.com/playwright:v1.47.0-jammy
WORKDIR /app

# Copie package.json Y package-lock.json para permitir 'npm ci'
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps

# Copie el resto del código
COPY . .

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "PruebaLeerCedulas.js"]
