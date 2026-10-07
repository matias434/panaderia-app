const db = require('./db');
const catalogoProductos = require('./catalogoProductos');

const initSchema = async () => {
  console.log('⏳ Conectando y creando tablas en PostgreSQL...');

  await db.query(`
    -- Tabla de Clientes
    CREATE TABLE IF NOT EXISTS clientes (
      id SERIAL PRIMARY KEY,
      nombre VARCHAR(100) NOT NULL,
      telefono VARCHAR(30),
      direccion VARCHAR(150),
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Tabla de Productos
    CREATE TABLE IF NOT EXISTS productos (
      id SERIAL PRIMARY KEY,
      nombre VARCHAR(100) NOT NULL,
      precio_unitario NUMERIC(10,2) NOT NULL DEFAULT 0.00,
      categoria VARCHAR(30) NOT NULL DEFAULT 'Otros',
      subcategoria VARCHAR(30) NOT NULL DEFAULT 'General',
      unidad VARCHAR(50),
      activo BOOLEAN NOT NULL DEFAULT TRUE,
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Tabla de Pedidos
    CREATE TABLE IF NOT EXISTS pedidos (
      id SERIAL PRIMARY KEY,
      cliente_id INT REFERENCES clientes(id) ON DELETE CASCADE,
      cliente_nombre VARCHAR(100),
      fecha_entrega DATE NOT NULL,
      tipo_entrega VARCHAR(20) DEFAULT 'reparto',
      estado VARCHAR(20) DEFAULT 'pendiente',
      repartidor VARCHAR(20),
      creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- Tabla de Detalle de Pedidos
    CREATE TABLE IF NOT EXISTS detalle_pedidos (
      id SERIAL PRIMARY KEY,
      pedido_id INT REFERENCES pedidos(id) ON DELETE CASCADE,
      producto_id INT REFERENCES productos(id) ON DELETE RESTRICT,
      producto_nombre VARCHAR(150),
      cantidad NUMERIC(8,2) NOT NULL,
      unidad VARCHAR(30),
      precio_unitario NUMERIC(12,2)
    );
  `);

  await db.query('ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS repartidor VARCHAR(20)');
  await db.query('ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS cliente_nombre VARCHAR(100)');
  await db.query('ALTER TABLE detalle_pedidos ADD COLUMN IF NOT EXISTS producto_nombre VARCHAR(150)');
  await db.query('ALTER TABLE detalle_pedidos ADD COLUMN IF NOT EXISTS unidad VARCHAR(30)');
  await db.query('ALTER TABLE detalle_pedidos ADD COLUMN IF NOT EXISTS precio_unitario NUMERIC(12,2)');
  await db.query('ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS entregado_en TIMESTAMP');
  await db.query('ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS oculto_proveedor BOOLEAN NOT NULL DEFAULT FALSE');
  await db.query("ALTER TABLE productos ADD COLUMN IF NOT EXISTS categoria VARCHAR(30) NOT NULL DEFAULT 'Otros'");
  await db.query("ALTER TABLE productos ADD COLUMN IF NOT EXISTS subcategoria VARCHAR(30) NOT NULL DEFAULT 'General'");
  await db.query('ALTER TABLE productos ADD COLUMN IF NOT EXISTS unidad VARCHAR(50)');
  await db.query('ALTER TABLE productos ADD COLUMN IF NOT EXISTS activo BOOLEAN NOT NULL DEFAULT TRUE');
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS productos_catalogo_unico
    ON productos (categoria, subcategoria, nombre, unidad)
    WHERE categoria IN ('Mayorista', 'Minorista')
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS pagos_pedidos (
      id SERIAL PRIMARY KEY,
      pedido_id INT NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
      repartidor VARCHAR(20) NOT NULL,
      medio VARCHAR(30) NOT NULL CHECK (medio IN ('Efectivo', 'Mercado Pago')),
      monto NUMERIC(12,2) NOT NULL CHECK (monto > 0),
      registrado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS pagos_pedidos_pedido_fecha
    ON pagos_pedidos (pedido_id, registrado_en)
  `);

  console.log('✅ Tablas creadas exitosamente.');

  await db.query("UPDATE productos SET activo = FALSE WHERE categoria IN ('Mayorista', 'Minorista')");
  await db.query(
    `INSERT INTO productos (nombre, precio_unitario, categoria, subcategoria, unidad)
     SELECT catalogo.nombre, 0, catalogo.categoria, catalogo.subcategoria, catalogo.unidad
     FROM UNNEST($1::VARCHAR[], $2::VARCHAR[], $3::VARCHAR[], $4::VARCHAR[])
       AS catalogo(nombre, categoria, subcategoria, unidad)
     ON CONFLICT (categoria, subcategoria, nombre, unidad)
       WHERE categoria IN ('Mayorista', 'Minorista')
     DO UPDATE SET activo = TRUE`,
    [
      catalogoProductos.map(producto => producto.nombre),
      catalogoProductos.map(producto => producto.categoria),
      catalogoProductos.map(producto => producto.subcategoria),
      catalogoProductos.map(producto => producto.unidad)
    ]
  );

  // Cargar datos de prueba si las tablas están vacías
  const checkClientes = await db.query('SELECT COUNT(*) FROM clientes');
  if (parseInt(checkClientes.rows[0].count) === 0) {
    await db.query(`
      INSERT INTO clientes (nombre, telefono, direccion) VALUES
      ('Despensa San Martín', '3755123456', 'Av. San Martín 450'),
      ('Kiosco El Sol', '3755987654', 'Calle Belgrano 120'),
      ('Supermercado Express', '3755112233', 'Ruta 13 Km 48');

      INSERT INTO productos (nombre, precio_unitario) VALUES
      ('Pan Común (kg)', 1200.00),
      ('Facturas Surtidas (docena)', 3500.00),
      ('Bizcochos de Grasa (kg)', 2800.00),
      ('Galletas de Sal (kg)', 2200.00);
    `);
    console.log('🌱 Datos de prueba (clientes y productos) cargados correctamente.');
  }
};

module.exports = initSchema;

if (require.main === module) {
  initSchema()
    .catch(error => {
      console.error('❌ Error al inicializar la base de datos:', error);
      process.exitCode = 1;
    })
    .finally(() => db.pool.end());
}