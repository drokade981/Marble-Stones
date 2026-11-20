#!/usr/bin/env bash
set -e

# Copy .env if not exists
if [ ! -f /var/www/html/.env ]; then
    echo "Creating .env from .env.example..."
    cp /var/www/html/.env.example /var/www/html/.env
fi

# Ensure composer dependencies and autoloader are complete
if [ ! -f /var/www/html/vendor/autoload.php ] || [ ! -d /var/www/html/vendor/predis/predis ]; then
    echo "Synchronizing composer vendor packages..."
    composer install --no-interaction --prefer-dist --optimize-autoloader
else
    # Refresh autoload classmap to ensure newly added packages are registered
    composer dump-autoload --optimize --quiet || true
fi

# Generate APP_KEY if empty
if ! grep -q "APP_KEY=base64" /var/www/html/.env; then
    echo "Generating application encryption key..."
    php artisan key:generate --force
fi

# Wait for MySQL database if DB_CONNECTION is mysql
if [ "$DB_CONNECTION" = "mysql" ]; then
    echo "Waiting for MySQL database at ${DB_HOST:-database}:${DB_PORT:-3306}..."
    until php -r "
        try {
            new PDO('mysql:host=' . getenv('DB_HOST') . ';port=' . (getenv('DB_PORT') ?: '3306') . ';dbname=' . getenv('DB_DATABASE'), getenv('DB_USERNAME'), getenv('DB_PASSWORD'));
            exit(0);
        } catch (Throwable \$e) {
            exit(1);
        }
    " 2>/dev/null; do
        echo "MySQL is unavailable - sleeping 2 seconds..."
        sleep 2
    done
    echo "MySQL database is ready!"
fi

# Run migrations and seed on app container startup
if [ "$1" = "php" ] && [ "$2" = "artisan" ] && [ "$3" = "serve" ]; then
    echo "Running database migrations..."
    php artisan migrate --force

    echo "Checking and seeding initial ERP data..."
    php artisan db:seed --force
fi

exec "$@"
