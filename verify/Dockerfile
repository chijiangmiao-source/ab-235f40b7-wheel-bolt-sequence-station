FROM mcr.microsoft.com/playwright:v1.48.2-noble

WORKDIR /verify

# 浏览器已随基础镜像提供，安装依赖时不再重复下载
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY playwright.config.js ./
COPY tests ./tests

CMD ["npx", "playwright", "test"]
