# Guía de Aprendizaje: Arquitectura CI/CD, Contenerización y Despliegue de Monorepo

Este documento reúne de forma didáctica la explicación técnica de todos los scripts, archivos de configuración y flujos de trabajo analizados. Su objetivo es servir como referencia de consulta para entender el **porqué** de cada decisión arquitectónica en el ciclo de desarrollo y despliegue del proyecto.

---

## 1. Conceptos Fundamentales de Infraestructura y Linux

### El directorio `/opt` en Linux
El Estándar de Jerarquía del Sistema de Archivos (FHS) de Linux reserva la carpeta `/opt` (*Optional Software Packages*) para instalar aplicaciones de terceros que no forman parte del sistema operativo base.

* **¿En el VPS estará mi monorepo?** **No.** El código fuente nunca reside en el servidor. En el VPS solo se almacenan los archivos de orquestación (`docker-compose.yml`, `.env` y configuraciones de Nginx).
* **Aislamiento de proyectos:** Si tienes múltiples proyectos o entornos (Staging y Producción), cada uno **debe** tener su propio directorio en `/opt` para evitar colisiones de contenedores.

```text
/opt/
├── erp-produccion/           # Entorno de Producción (rama main)
│   ├── docker-compose.vps.yml
│   └── .env
├── erp-staging/              # Entorno de Pruebas (rama staging)
│   ├── docker-compose.staging.yml
│   └── .env
└── sitio-web-secundario/     # Proyecto independiente
```

---

## 2. Contenerización con Docker (Multi-stage Builds)

La técnica **Multi-stage Build** utiliza una etapa inicial pesada para compilar el código y una etapa final ultra reducida para ejecutarlo en producción.

### 2.1. API (NestJS + Prisma + Node.js)
Fichero: `apps/api/Dockerfile`

| Etapa | Imagen Base | Responsabilidad Principal |
| :--- | :--- | :--- |
| **`base`** | `node:24-alpine` | Instala y activa `pnpm` mediante Corepack. |
| **`builder`** | Herencia de `base` | Instala dependencias, compila el código TypeScript a JavaScript (`pnpm --filter api build`) y aísla la API con `pnpm deploy --filter=api --prod /app/out`. |
| **`runner`** | `node:24-alpine` | Copia únicamente `/app/out/dist`, `/node_modules`, `package.json` y los esquemas de Prisma. Enciende el servidor con `pnpm run start:prod`. |

> **Lección clave:** En la imagen final de producción no se incluye el código fuente `.ts` ni las dependencias de desarrollo (`devDependencies`), reduciendo el tamaño de la imagen y los riesgos de seguridad.

### 2.2. Web Frontend (React + Vite + Nginx)
Fichero: `apps/web/Dockerfile`

| Etapa | Imagen Base | Responsabilidad Principal |
| :--- | :--- | :--- |
| **`base`** | `node:24-alpine` | Prepara Node.js y `pnpm`. |
| **`builder`** | Herencia de `base` | Inyecta las variables `ARG VITE_API_URL` en tiempo de compilación y genera los archivos estáticos HTML/CSS/JS (`pnpm --filter web build`). |
| **`runner`** | `nginx:alpine` | **Desecha Node.js.** Copia los archivos estáticos compilados a `/usr/share/nginx/html` y aplica la configuración de Nginx. |

> **Lección clave:** A diferencia del backend, la SPA de React compilada no requiere un motor Node.js en ejecución; solo requiere un servidor web estático de alto rendimiento como Nginx.

---

## 3. Servidor Web Interno para SPA (React)

Fichero: `apps/web/nginx.conf`

```nginx
server {
    listen 80;
    server_name localhost;

    location / {
        root /usr/share/nginx/html;
        index index.html index.htm;
        try_files $uri $uri/ /index.html;
    }
}
```

### Análisis de la directiva `try_files`
En las aplicaciones *Single Page Application* (SPA), las rutas (ej. `/usuarios`, `/inventario`) son gestionadas en el navegador por **React Router**, no por carpetas reales en el servidor.

1. **`$uri`**: Nginx intenta buscar un archivo físico (ej. `/logo.png`).
2. **`$uri/`**: Intenta buscar un directorio.
3. **`/index.html`**: Si el archivo o carpeta no existen en disco, Nginx devuelve `index.html`. Esto permite que el cliente mantenga la URL en la barra de direcciones y React tome el control de la vista **sin provocar un error 404**.

---

## 4. Automatización CI/CD con GitHub Actions

Fichero: `.github/workflows/staging.yml`

El flujo de integración y despliegue continuo se divide en dos **Jobs** secuenciales:

### Job 1: `build-and-push-staging` (Compilación en la Nube)
1. **`actions/checkout@v4`**: Copia el código fuente al servidor virtual de GitHub.
2. **`docker/login-action@v3`**: Autentica en GitHub Container Registry (`ghcr.io`).
3. **Normalización de usuario:** Convierte el nombre del propietario del repositorio a minúsculas, requisito estricto de GHCR:
   ```bash
   echo "OWNER=$(echo "${{ github.repository_owner }}" | tr '[:upper:]' '[:lower:]')" >> $GITHUB_ENV
   ```
4. **`docker/build-push-action@v5`**: Ejecuta los `Dockerfile` de la API y de la Web, construyendo las imágenes y subiéndolas a GHCR con el tag `:staging`.

### Job 2: `deploy-to-vps-staging` (Despliegue SSH)
Se ejecuta solo si la compilación tuvo éxito (`needs: build-and-push-staging`).

* Utiliza `appleboy/ssh-action@v1.0.3` para conectarse por SSH al VPS.
* Ejecuta la secuencia en el servidor:
  ```bash
  cd /opt/monorepo-demo-staging
  docker login ghcr.io -u ${{ github.actor }} -p ${{ secrets.GHCR_PAT }}
  docker compose -f docker-compose.staging.yml pull
  docker compose -f docker-compose.staging.yml up -d --remove-orphans
  docker image prune -f
  ```

---

## 5. Orquestación con Docker Compose en el VPS

Fichero: `docker-compose.staging.yml`

```yaml
version: '3.8'

services:
  api:
    image: ghcr.io/${GITHUB_OWNER}/my-monorepo-api:staging
    container_name: monorepo_api_staging
    restart: always
    ports:
      - "127.0.0.1:3091:3091"
    environment:
      - PORT=3091
      - NODE_ENV=production
      - DATABASE_URL=${DATABASE_URL}
    networks:
      - app-network

  web:
    image: ghcr.io/${GITHUB_OWNER}/my-monorepo-web:staging
    container_name: monorepo_web_staging
    restart: always
    ports:
      - "127.0.0.1:3092:80"
    environment:
      - VITE_API_URL=https://api-exa.midominio.net
    networks:
      - app-network

networks:
  app-network:
    driver: bridge
```

### Medidas de Seguridad y Buenas Prácticas Aplicadas

1. **Conexión Local Estricta (`127.0.0.1:3091:3091`):** Al anteponer `127.0.0.1`, los puertos de la API y Web no quedan expuestos públicamente a internet. Toda petición debe pasar obligatoriamente por el Nginx Reverse Proxy del VPS y el WAF de Cloudflare.
2. **Aislamiento de Nombres:** Nombres de contenedores sufijados (`monorepo_api_staging`) para evitar colisiones con el entorno de producción en la misma máquina.
3. **Consistencia de Etiquetas:** Uso explícito de la etiqueta `:staging` tanto en el pipeline como en el archivo compose.
4. **Mantenimiento Automatizado:** El comando `docker image prune -f` elimina capas de imágenes antiguas tras cada despliegue para optimizar el almacenamiento SSD del VPS.
