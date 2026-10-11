# syntax=docker/dockerfile:1
FROM php:8.3-apache-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && docker-php-ext-install pdo_mysql \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /var/www/html

COPY --chown=www-data:www-data *.html *.js *.php ./
COPY --chown=www-data:www-data backend/ ./backend/
COPY --chown=www-data:www-data config/ ./config/

RUN cp backend/config.example.php backend/config.php \
    && mkdir -p logs temp \
    && chown -R www-data:www-data logs temp backend/config.php

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
    CMD curl --fail --silent --output /dev/null http://127.0.0.1/ || exit 1
