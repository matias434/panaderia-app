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

## Acceso de proveedores

La pantalla móvil está en `/proveedor.html`. Cada repartidor inicia sesión con su nombre y un PIN individual de 4 a 12 dígitos. Configurar `PROVIDER_PIN_RODRIGO`, `PROVIDER_PIN_ELSA` y `PROVIDER_PIN_MARCOS` en `.env` local o en las variables privadas de la plataforma. Configurar también `PROVIDER_SESSION_SECRET` con un secreto aleatorio de al menos 32 caracteres; se puede generar con:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

No usar los textos de ejemplo como PIN o secreto. La sesión dura 12 horas. El proveedor solo ve pedidos de reparto asignados a él cuya fecha de entrega sea hoy o anterior, y únicamente puede confirmar sus propios envíos pendientes.

La autenticación de Secretaría todavía no está implementada: las pantallas y API actuales de pedidos no requieren inicio de sesión. Para una demostración pública, usar solo datos ficticios; antes de cargar datos reales o compartir el sistema en producción, agregar y probar el acceso de Secretaría.

## Inicialización de la base

`npm run db:init` crea las tablas que falten y agrega las columnas requeridas a una base existente. Ejecutarlo manualmente antes de usar la aplicación con una base nueva o después de cambios de esquema.
