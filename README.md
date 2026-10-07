# Módulo de pedidos de panadería

Aplicación web para cargar pedidos de reparto a revendedores y pedidos particulares con retiro en el local. Permite consultar pedidos por fecha, ver los pendientes y preparar las comandas para cocina.

Los productos se eligen del catálogo en Recepción, agrupados en Mayorista y Minorista (Dulce/Salado). Cada opción tiene su unidad o presentación definida para evitar errores de escritura y sumar unidades incompatibles. El catálogo se carga idempotentemente al iniciar el servidor; sus definiciones están en `src/config/catalogoProductos.js`. Las opciones retiradas o corregidas dejan de aparecer al reiniciar; los pedidos históricos conservan el nombre y la unidad con que se guardaron.

Desde Recepción se puede abrir e imprimir, para la fecha seleccionada, los pedidos agrupados por producto y unidad, con cantidad, destinatario, fecha, repartidor y total por grupo. No se hacen conversiones entre unidades.

Desde las tarjetas de pedido en Recepción se puede eliminar definitivamente un pedido con confirmación; también se eliminan sus renglones de detalle.

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

No usar los textos de ejemplo como PIN o secreto. La sesión dura 12 horas. El proveedor ve sus pedidos de reparto para hoy y atrasados, confirma entregas pendientes y registra cobros parciales solo en sus pedidos entregados y valorizados. Puede quitar manualmente de Mis envíos cualquier pedido propio ya entregado; el pedido y su historial de cobros se conservan para Secretaría. Los pedidos entregados y totalmente cobrados también dejan de mostrarse ocho horas después de la entrega. Los que tienen saldo o todavía no fueron valorizados siguen visibles hasta que se quiten manualmente.

La pantalla de Secretaría `/secretaria.html` requiere `SECRETARY_PIN` (4 a 12 dígitos) y `SECRETARY_SESSION_SECRET` (secreto aleatorio de al menos 32 caracteres, distinto del secreto de proveedores). Configurar ambos en `.env` o como variables privadas del servicio de Railway. La sesión dura 12 horas. Secretaría asigna el precio manualmente a cada producto de cada pedido, para permitir precios distintos entre compradores. Los precios quedan guardados en el detalle del pedido. El repartidor solo ve sus pedidos, confirma la entrega y registra uno o más pagos parciales por efectivo o Mercado Pago. El saldo mostrado corresponde únicamente al pedido/reparto actual; no incluye deudas anteriores. Un pedido con pagos registrados no se puede eliminar.

Las operaciones de carga de pedidos y eliminación en Recepción todavía no requieren una sesión administrativa. Usar solo datos ficticios para pruebas públicas y no operar cobros reales hasta que se agregue y pruebe autenticación de Secretaría/Administración para todas las acciones sensibles.

Generar un secreto de sesión con:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Prueba en Railway

El proyecto incluye `railway.json`: Railway inicia con `npm start` y verifica `/health`. El propio servidor crea o actualiza las tablas y comprueba la base seleccionada antes de empezar a aceptar consultas; si la inicialización falla, no arranca.

1. En Railway, crear un proyecto desde el repositorio privado `matias434/panaderia-app` y agregar un servicio PostgreSQL.
2. En el servicio de la aplicación, crear la variable `DATABASE_URL` como referencia a la variable `DATABASE_URL` del servicio PostgreSQL (`${{Postgres.DATABASE_URL}}`, usando el nombre real del servicio).
3. Configurar `PROVIDER_PIN_RODRIGO`, `PROVIDER_PIN_ELSA`, `PROVIDER_PIN_MARCOS`, `PROVIDER_SESSION_SECRET`, `SECRETARY_PIN` y `SECRETARY_SESSION_SECRET` como variables privadas del servicio. Los secretos de proveedor y Secretaría deben ser distintos.
4. Generar un dominio público desde Networking y abrir `/` para Recepción, `/proveedor.html` para el repartidor o `/secretaria.html` para Secretaría.

El plan Free publicado por Railway incluye USD 1 de crédito de uso por mes; la prueba inicial publica USD 5 de crédito por 30 días. Verificar límites y consumo en Railway antes de dejar los servicios activos. Aunque Secretaría y proveedores tienen inicio de sesión, las operaciones administrativas de Recepción todavía no están protegidas integralmente; usar exclusivamente pedidos y datos ficticios durante las pruebas públicas y no operar cobros reales hasta proteger esas acciones.

## Inicialización de la base

`npm run db:init` crea las tablas que falten y agrega las columnas requeridas a una base existente; también se ejecuta automáticamente al iniciar la aplicación. Si la tabla de clientes está vacía, carga clientes y productos de ejemplo. Los pedidos y clientes existentes en otra base de datos no se copian automáticamente. En los logs de inicio deben aparecer `Tablas creadas exitosamente` y `Base preparada`; si no aparecen, revisar la configuración del comando de inicio y la referencia `DATABASE_URL` del servicio.
