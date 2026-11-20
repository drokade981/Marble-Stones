FROM php:8.3-cli-alpine

# Install system dependencies & MySQL client
RUN apk add --no-cache \
    curl \
    git \
    unzip \
    libzip-dev \
    mariadb-client \
    mysql-client \
    bash \
    icu-dev \
    oniguruma-dev \
    linux-headers

# Install PHP extensions for MySQL, Redis and background jobs
RUN docker-php-ext-install -j$(nproc) \
    pdo \
    pdo_mysql \
    bcmath \
    zip \
    intl \
    mbstring \
    pcntl \
    opcache

# Install Composer
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

WORKDIR /var/www/html

# Copy composer files first for caching
COPY composer.json composer.lock ./

# Install composer dependencies
RUN composer install --no-interaction --no-scripts --no-autoloader --prefer-dist

# Copy full application code
COPY . .

# Complete composer autoload
RUN composer dump-autoload --optimize

# Permissions
RUN chown -R www-data:www-data /var/www/html/storage /var/www/html/bootstrap/cache && \
    chmod -R 775 /var/www/html/storage /var/www/html/bootstrap/cache && \
    chmod +x /var/www/html/docker/entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["/var/www/html/docker/entrypoint.sh"]
CMD ["php", "artisan", "serve", "--host=0.0.0.0", "--port=8000"]
