FROM node:22-alpine

WORKDIR /usr/src/app

COPY package*.json ./

RUN apk add --no-cache \
    libreoffice \
    ttf-dejavu \
    fontconfig

RUN npm install

COPY . .

EXPOSE 4000

CMD ["npm", "run", "dev"]
