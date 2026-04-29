FROM node:20-alpine

WORKDIR /app

# Install native dependencies for better-sqlite3 build
RUN apk add --no-cache python3 make g++ 

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]