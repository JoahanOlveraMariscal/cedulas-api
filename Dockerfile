FROM mcr.microsoft.com/playwright:v1.47.0-jammy
WORKDIR /app

# Copie package.json Y package-lock.json (obligatorio para npm ci)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps

# Copie el resto
COPY . .

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
EXPOSE 8080
CMD ["node", "PruebaLeerCedulas.js"]
