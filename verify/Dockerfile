# 官方 Playwright 镜像：已预装 Chromium 及其全部系统依赖。
FROM mcr.microsoft.com/playwright:v1.49.0-noble

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app

# 中文字体：保证页面中文文案在验收环境中正常渲染（截图与排版度量）。
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund && npm cache clean --force

COPY . .

# 一次性验收：退出码即验收结论（0 通过，非 0 失败）。
CMD ["node", "--test", "tests/protocol.test.js", "tests/page.test.js"]
