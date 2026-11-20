#!/usr/bin/env bash
set -e

# Copy .env if not exists
if [ ! -f /var/www/html/.env ]; then
    echo "Creating .env from .env.example..."
    cp /var/www/html/.env.example /var/www/html/.env
fi

# Generate APP_KEY if empty
if ! grep -q "APP_KEY=base64" /var/www/html/.env; then
    echo "Generating application encryption key..."
    php artisan key:generate --force
fi

# Wait for PostgreSQL database if DB_CONNECTION is pgsql
if [ "$DB_CONNECTION" = "pgsql" ]; then
    echo "Waiting for PostgreSQL at ${DB_HOST:-database}:${DB_PORT:-5432}..."
    until pg_isready -h "${DB_HOST:-database}" -p "${DB_PORT:-5432}" -U "${DB_USERNAME:-postgres}"; do
        echo "Database is unavailable - sleeping..."
        sleep 2
    done
    echo "PostgreSQL is ready!"
fi

# Run migrations and seed on app container startup
if [ "$1" = "php" ] && [ "$2" = "artisan" ] && [ "$3" = "serve" ]; then
    echo "Running database migrations..."
    php artisan migrate --force

    echo "Seeding ERP database with initial data (products, warehouses, suppliers, POs, users)..."
    php artisan db:seed --force
fi

exec "$@"
