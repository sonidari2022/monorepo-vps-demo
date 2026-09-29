import { useEffect, useState } from 'react';

interface EjemploItem {
  id: number;
  descripcion: string;
  otros?: string;
}

export function App() {
  const [items, setItems] = useState<EjemploItem[]>([]);

  useEffect(() => {
    const apiUrl = import.meta.env.VITE_API_URL || 'http://192.168.1.2:3091';
    console.log("sd->apiUrl:",apiUrl);
    fetch(`${apiUrl}/ejemplo`)
      .then((res) => res.json())
      .then((data) => setItems(data))
      .catch((err) => console.error('Error conectando a NestJS API:', err));
  }, []);

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: '900px', margin: '0 auto' }}>
      <h1>ERP Frontend (React 19) - Conexión con NestJS & Prisma</h1>
      <p>Entorno local WSL (Node 24.20.0) / VPS Production Ready</p>

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '1.5rem', textAlign: 'left' }}>
        <thead>
          <tr style={{ background: '#2563eb', color: '#fff' }}>
            <th style={{ padding: '12px' }}>ID</th>
            <th style={{ padding: '12px' }}>Descripción</th>
            <th style={{ padding: '12px' }}>Otros (Nueva Columna)</th>
          </tr>
        </thead>
        <tbody>
          {items.length > 0 ? (
            items.map((item) => (
              <tr key={item.id} style={{ borderBottom: '1px solid #e5e7eb' }}>
                <td style={{ padding: '12px' }}>{item.id}</td>
                <td style={{ padding: '12px' }}>{item.descripcion}</td>
                <td style={{ padding: '12px' }}>{item.otros || '-'}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={3} style={{ padding: '12px', textAlign: 'center' }}>
                Cargando registros desde la API...
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default App;
