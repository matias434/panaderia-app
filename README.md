# Módulo de pedidos de panadería

Aplicación web para cargar pedidos de reparto a revendedores y pedidos particulares con retiro en el local. Permite consultar pedidos por fecha, ver los pendientes y preparar las comandas para cocina.

## Requisitos

- Node.js
- PostgreSQL

## Instalación local

1. Instalar las dependencias:

   ```sh
   npm install
   ```

2. Crear un archivo `.env` a partir de `.env.example` y configurar la conexión a PostgreSQL.

3. Crear o actualizar las tablas:

   ```sh
   npm run db:init
   ```

4. Iniciar la aplicación:

   ```sh
   npm start
   ```

5. Abrir `http://localhost:3000`.

## Configuración

Se puede configurar la base mediante `DATABASE_URL`, o mediante las variables `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT` y `DB_NAME`. `PORT` es opcional; la aplicación usa el puerto 3000 por defecto.

No subir `.env` ni compartir sus valores. En plataformas de despliegue, configurar las variables en el panel de la plataforma.

## Inicialización de la base

`npm run db:init` crea las tablas que falten y agrega las columnas requeridas a una base existente. Ejecutarlo manualmente antes de usar la aplicación con una base nueva o después de cambios de esquema.
