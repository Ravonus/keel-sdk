FROM node:22-bookworm-slim

WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY examples ./examples
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @keel/protocol build \
 && pnpm --filter @keel/sdk build \
 && pnpm --filter @keel/builder build \
 && pnpm --filter @keel/viewer build

CMD ["node", "examples/immutable-three-one-of-one/run.mjs"]
