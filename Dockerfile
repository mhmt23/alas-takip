# =============================================================================
# Alas Takip V1 — üretim Docker imajı (Railway).
#
# Tek npm paketi (monorepo yok). Tek aşamalı, küçük bir imaj:
#   - npm ci --omit=dev: yalnızca üretim bağımlılıkları. package-lock.json zorunlu.
#   - ffmpeg: video 720p dönüşümü (V1-SPEC §9). tzdata: TZ=Europe/Istanbul için.
#   - Veri İMAJDA YOK: DATA_DIR=/data, Railway'de Volume olarak bağlanır.
#     data/, _acik/, ornek/, d/ vb. .dockerignore ile dışarıda tutulur.
#   - Kök kullanıcı BİLİNÇLİ (V1-SPEC §9): Volume izni için. Non-root'a geçmeden
#     önce /data yazma iznini ayrıca çözmek gerekir.
# =============================================================================

FROM node:22-alpine

WORKDIR /app

# Sistem paketleri: ffmpeg (video dönüşümü), tzdata (Europe/Istanbul).
RUN apk add --no-cache ffmpeg tzdata

ENV NODE_ENV=production \
    TZ=Europe/Istanbul \
    DATA_DIR=/data

# Önce yalnızca bağımlılık tanımları: kaynak kod değişince npm ci katmanı yeniden kurulmaz.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Uygulama kodu ve oturumsuz statik dosyalar. tools/ ve test/ çalışma zamanında gerekmez.
COPY server ./server
COPY public ./public

# Yerel `docker run` (Volume'suz) için veri klasörünün var olması. Railway Volume'u kendisi bağlar.
RUN mkdir -p /data

EXPOSE 3000

# SESSION_SECRET yoksa (NODE_ENV=production) uygulama kod 1 ile çıkar; Railway Variables'a eklenmeli.
CMD ["node", "server/index.js"]
