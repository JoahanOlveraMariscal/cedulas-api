From mcr.microsoft.com/playwright:v1.47.0-jammy
WORKDIR /app
COPY package.json ./
RUN npm ci --omit=dev

COPY . .
EXPOSE 8080
CMD ["npm", "start"]