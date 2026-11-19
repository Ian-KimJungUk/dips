FROM node:26-alpine AS base
WORKDIR /app
RUN npm install -g pnpm@10.29.3

# 빌드: 전체 의존성 설치 → prisma generate(postinstall) → nest build
FROM base AS build
COPY package.json pnpm-lock.yaml prisma.config.ts ./
COPY prisma ./prisma
# prisma generate는 DB에 접속하지 않지만 prisma.config.ts가 DATABASE_URL을 요구함
RUN DATABASE_URL=postgres://placeholder pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# 런타임 의존성: devDependencies 제외. --no-optional로 @prisma/client의 optional peer인 prisma CLI(~200MB)도 제외
# (postinstall의 prisma generate는 build 단계에서 이미 끝났으므로 스크립트 생략)
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --no-optional

FROM node:26-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
