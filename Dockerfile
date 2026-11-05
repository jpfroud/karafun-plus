# Images de base épinglées par empreinte (index multi-architecture) : même
# construction partout ; Dependabot propose chaque nouvelle empreinte en PR.
FROM --platform=$BUILDPLATFORM maven:3.9-eclipse-temurin-21@sha256:99e61abcff91a9b1333463bd8451fb18495d6eba9250ac66a338b518f8278320 AS solveur
WORKDIR /build
COPY solver/pom.xml solver/pom.xml
COPY solver/src solver/src
RUN mvn -B -ntp -f solver/pom.xml verify \
      org.codehaus.mojo:license-maven-plugin:add-third-party \
      org.codehaus.mojo:license-maven-plugin:download-licenses \
 && mkdir -p LICENCES-JAVA/textes \
 && cp solver/target/generated-sources/license/THIRD-PARTY.txt LICENCES-JAVA/ \
 && cp solver/target/generated-resources/licenses.xml LICENCES-JAVA/ \
 && cp solver/target/generated-resources/licenses/* LICENCES-JAVA/textes/ \
 && test -s solver/target/karafun-solver.jar

FROM eclipse-temurin:21-jdk@sha256:ebfbb18d11ff163ee83b21258acf12248af48d22a0fdfdc68fa1a1516c05976a AS jre
RUN jlink --add-modules java.base,java.xml,java.logging,java.management,jdk.management,jdk.unsupported \
      --strip-debug --no-header-files --no-man-pages --compress=zip-6 \
      --output /solver-runtime \
 && /solver-runtime/bin/java --version

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS deps
ARG VERSION
ARG COMMIT
ARG BUILT_AT
WORKDIR /src
COPY package.json package-lock.json ./
# Aucun script d'installation des dépendances : aucune n'en a besoin, et un
# paquet piégé ne peut rien exécuter pendant la construction.
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts
COPY . .
RUN node scripts/preparer-livrable.js /livrable \
 && cp -R node_modules /livrable/node_modules

FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
ARG VERSION
ARG COMMIT
ARG BUILT_AT
LABEL org.opencontainers.image.title="karafun-plus" \
      org.opencontainers.image.source="https://github.com/jpfroud/karafun-plus" \
      org.opencontainers.image.licenses="Unlicense" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${COMMIT}" \
      org.opencontainers.image.created="${BUILT_AT}"
ENV KARAOKE_MODE=server \
    KARAOKE_BIND=0.0.0.0 \
    KARAOKE_PUBLIC_BIND=0.0.0.0 \
    KARAOKE_CLIENT_IP_HEADER=x-real-ip \
    TZ=Europe/Paris
WORKDIR /app
COPY --from=deps /livrable/ ./
COPY --from=solveur /build/solver/target/karafun-solver.jar solver/karafun-solver.jar
COPY --from=solveur /build/LICENCES-JAVA/ LICENCES-JAVA/
COPY --from=jre /solver-runtime/ solver-runtime/
# L'application n'utilise que node : npm, npx, corepack et yarn de l'image de
# base (et leurs propres dépendances, souvent signalées vulnérables) sont retirés.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v* \
 && mkdir data journal && chown node:node data journal && chmod 0700 data journal
USER node
VOLUME ["/app/data", "/app/journal"]
EXPOSE 3000 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/healthz').then(r => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server.js", "--no-open"]
