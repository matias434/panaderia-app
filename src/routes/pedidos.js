// Obtener pedidos por fecha con sus detalles
router.get('/fecha/:fecha', async (req, res) => {
  try {
    const { fecha } = req.params;
    
    const query = `
      SELECT 
        p.id, 
        p.fecha_entrega, 
        p.tipo_entrega, 
        p.estado,
        c.nombre AS cliente_nombre,
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'producto_nombre', pr.nombre,
            'cantidad', dp.cantidad
          )
        ) AS items
      FROM pedidos p
      JOIN clientes c ON p.cliente_id = c.id
      JOIN detalle_pedidos dp ON dp.pedido_id = p.id
      JOIN productos pr ON dp.producto_id = pr.id
      WHERE p.fecha_entrega = $1
      GROUP BY p.id, c.nombre
      ORDER BY p.id ASC;
    `;

    const { rows } = await db.query(query, [fecha]);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener comandas' });
  }
});