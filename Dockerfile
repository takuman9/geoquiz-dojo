# GeoQuiz Dojo — Cloud Run 用 (依存ゼロなので npm install 不要)
FROM node:20-slim
WORKDIR /app
# .env も含めてコピー(除外は .dockerignore で管理)
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
