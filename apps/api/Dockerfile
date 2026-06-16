FROM public.ecr.aws/docker/library/node:20-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

RUN apk add --no-cache ca-certificates && update-ca-certificates

COPY package.json /app/package.json
RUN npm install --omit=dev

COPY server.mjs /app/server.mjs
COPY openapi-specs.mjs /app/openapi-specs.mjs
COPY tests-dispatch.mjs /app/tests-dispatch.mjs
COPY migrations /app/migrations

EXPOSE 3000
CMD ["node", "/app/server.mjs"]
