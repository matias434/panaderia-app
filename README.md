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

4. Iniciar la aplicación (inicializa o actualiza el esquema automáticamente antes de aceptar consultas):

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

## Prueba en Railway

El proyecto incluye `railway.json`: Railway inicia con `npm start` y verifica `/health`. El propio servidor crea o actualiza las tablas y comprueba la base seleccionada antes de empezar a aceptar consultas; si la inicialización falla, no arranca.

1. En Railway, crear un proyecto desde el repositorio privado `matias434/panaderia-app` y agregar un servicio PostgreSQL.
2. En el servicio de la aplicación, crear la variable `DATABASE_URL` como referencia a la variable `DATABASE_URL` del servicio PostgreSQL (`${{Postgres.DATABASE_URL}}`, usando el nombre real del servicio).
3. Configurar `PROVIDER_PIN_RODRIGO`, `PROVIDER_PIN_ELSA`, `PROVIDER_PIN_MARCOS` y un `PROVIDER_SESSION_SECRET` aleatorio de al menos 32 caracteres como variables privadas del servicio.
4. Generar un dominio público desde Networking y abrir `/` para Recepción o `/proveedor.html` para la pantalla del repartidor.

El plan Free publicado por Railway incluye USD 1 de crédito de uso por mes; la prueba inicial publica USD 5 de crédito por 30 días. Verificar límites y consumo en Railway antes de dejar los servicios activos. Como la pantalla/API de Secretaría aún no tiene inicio de sesión, usar exclusivamente pedidos y datos ficticios durante las pruebas públicas.

## Inicialización de la base

`npm run db:init` crea las tablas que falten y agrega las columnas requeridas a una base existente; también se ejecuta automáticamente al iniciar la aplicación. Si la tabla de clientes está vacía, carga clientes y productos de ejemplo. Los pedidos y clientes existentes en otra base de datos no se copian automáticamente. En los logs de inicio deben aparecer `Tablas creadas exitosamente` y `Base preparada`; si no aparecen, revisar la configuración del comando de inicio y la referencia `DATABASE_URL` del servicio.
