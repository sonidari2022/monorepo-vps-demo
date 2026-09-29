# Manual de Operaciones y Despliegue CI/CD: Monorepo ERP

Este documento detalla la arquitectura, configuración y ciclo de vida del proyecto ERP modular. El sistema utiliza un monorepo gestionado con `pnpm`, backend en NestJS con Prisma ORM, frontend en React, y despliegue automatizado en un VPS de OVHcloud (Ubuntu) mediante GitHub Actions y Docker. La seguridad perimetral se gestiona a través de Cloudflare y Nginx.

---

## 1. Entorno de Desarrollo Local (WSL)

El desarrollo se realiza de forma nativa en WSL, **sin necesidad de instalar Docker en tu computadora local**, garantizando un entorno rápido y ligero.

### Requisitos Previos
* Node.js v24.20.0 (recomendado gestionar con `nvm` utilizando el archivo `.nvmrc`).
* `pnpm` v9+ (activado mediante `corepack enable`).
* Base de datos PostgreSQL externa accesible para desarrollo.

### Inicialización del Proyecto Local
1. **Instalar dependencias globales del monorepo:**
   ```bash
   pnpm install
   ```
2. **Generar el cliente de Prisma:**
   ```bash
   pnpm prisma:generate
   ```
3. **Ejecutar el entorno de desarrollo:**
   Para levantar simultáneamente la API (puerto `3091`) y la Web (puerto `3092`):
   ```bash
   pnpm dev
   ```

---

## 2. Configuración de Infraestructura en Nube (Cloudflare)

Cloudflare gestionará los DNS, forzará la conexión HTTPS pública (Edge SSL) y encriptará el tráfico hacia el VPS (Origin SSL).

### 2.1. Configuración de DNS
En el panel de Cloudflare, crea los siguientes registros apuntando a la IP pública del VPS:
* **Tipo A:** `api-exa` -> `[IP_DEL_VPS]` (Estado Proxy: Activado / Nube naranja)
* **Tipo A:** `web-exa` -> `[IP_DEL_VPS]` (Estado Proxy: Activado / Nube naranja)

### 2.2. Certificados de Origen (SSL)
1. Navega a **SSL/TLS** -> **Origin Server** y haz clic en **Create Certificate**.
2. Conserva la configuración por defecto y genera el certificado.
3. Copia los valores proporcionados (`Origin Certificate` y `Private Key`) para utilizarlos posteriormente en el VPS.
4. En **SSL/TLS** -> **Overview**, establece el modo de encriptación en **Full (Strict)**.
5. En **SSL/TLS** -> **Edge Certificates**, activa **Always Use HTTPS**.

---

## 3. Preparación del Servidor (VPS Ubuntu)

El VPS hospedará las aplicaciones contenerizadas y un servidor Nginx configurado como Reverse Proxy. Se aplicará el principio de menor privilegio para los despliegues automáticos.

### 3.1. Creación de Usuario Restringido para Despliegues
Para evitar otorgar acceso `root` a la automatización de GitHub:
```bash
sudo adduser github-deploy
sudo usermod -aG docker github-deploy
sudo mkdir -p /opt/monorepo-demo /opt/monorepo-demo-staging
sudo chown -R github-deploy:github-deploy /opt/monorepo-demo /opt/monorepo-demo-staging
```

### 3.2. Instalación de Docker y Nginx
```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2 nginx
sudo systemctl enable --now docker
```

### 3.3. Configuración de Certificados SSL en el VPS
```bash
sudo mkdir -p /etc/ssl/cloudflare
sudo nano /etc/ssl/cloudflare/origin.pem # Pega el Origin Certificate
sudo nano /etc/ssl/cloudflare/origin.key # Pega la Private Key
sudo chmod 600 /etc/ssl/cloudflare/origin.key
```

### 3.4. Configuración del Reverse Proxy (Nginx)
```bash
sudo nano /etc/nginx/sites-available/erp.conf
```
*Contenido del archivo:*
```nginx
server {
    listen 443 ssl http2;
    server_name api-exa.midominio.net;
    ssl_certificate /etc/ssl/cloudflare/origin.pem;
    ssl_certificate_key /etc/ssl/cloudflare/origin.key;
    location / {
        proxy_pass http://127.0.0.1:3091;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 443 ssl http2;
    server_name web-exa.midominio.net;
    ssl_certificate /etc/ssl/cloudflare/origin.pem;
    ssl_certificate_key /etc/ssl/cloudflare/origin.key;
    location / {
        proxy_pass http://127.0.0.1:3092;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name api-exa.midominio.net web-exa.midominio.net;
    return 301 https://$host$request_uri;
}
```
Habilita el sitio y recarga Nginx:
```bash
sudo ln -s /etc/nginx/sites-available/erp.conf /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 3.5. Configuración del Firewall (UFW)
```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

---

## 4. Configuración de Repositorio y CI/CD (GitHub)

### 4.1. Variables Secretas de Entorno
En **Settings -> Secrets and variables -> Actions**, añade:
* `VPS_HOST`: IP de tu VPS.
* `VPS_USER`: `github-deploy`
* `VPS_SSH_KEY`: Llave SSH privada generada para `github-deploy`.
* `GHCR_PAT`: Tu Personal Access Token con permisos `read:packages`.

### 4.2. Protección de Rama
En **Settings -> Branches -> Branch protection rules**, añade `main` y activa **Require a pull request before merging**.

---

## 5. Primer Despliegue Inicial (Puesta en Marcha)

Este proceso demuestra cómo llevar el código desde tu entorno local hasta el VPS por primera vez, delegando la construcción de los contenedores Docker completamente a GitHub Actions.

### Paso 1: Configurar la Base de Datos Inicial
Asegúrate de que tu base de datos PostgreSQL remota exista y que el usuario definido en `DATABASE_URL` tenga permisos para crear tablas. No necesitas crear tablas manualmente, Prisma lo hará.

### Paso 2: Subir el Código Fuente a GitHub
Desde la terminal de tu WSL, donde probaste el proyecto:
```bash
git init
git add .
git commit -m "commit inicial: arquitectura monorepo, nestjs y react"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/TU_REPOSITORIO.git
git push -u origin main
```
*(Nota: No estás ejecutando ningún comando `docker build` aquí. Todo ocurre en la nube).*

### Paso 3: Compilación Automática (La Magia del CI/CD)
Al recibir el `git push`, GitHub Actions inicia una máquina virtual temporal.
1. Lee los archivos `Dockerfile` de tu API y Web.
2. Compila tu código y empaqueta las imágenes Docker.
3. Las guarda en tu GitHub Container Registry (`ghcr.io`).

### Paso 4: Ejecución Automática en el VPS
El mismo pipeline de GitHub, tras compilar, se conecta por SSH a tu VPS como `github-deploy` y ejecuta:
```bash
docker compose pull # Descarga las imágenes que GitHub acaba de compilar
docker compose up -d # Inicia los servicios en los puertos 3091 y 3092
```

Durante el primer arranque del contenedor de la API, se ejecutará `npx prisma migrate deploy`, lo que creará de forma automática la tabla `Ejemplo` en tu base de datos PostgreSQL basándose en tu `schema.prisma`. 

En minutos, tus dominios `api-exa` y `web-exa` estarán funcionales y seguros.

---

## 6. Flujo de Trabajo para Futuras Actualizaciones

Ejemplo: Agregar una nueva columna `otros` a la base de datos.

### Paso 1: Desarrollo Local (WSL)
1. Modifica `apps/api/prisma/schema.prisma`:
   ```prisma
   model Ejemplo {
     id          Int     @id @default(autoincrement())
     descripcion String
     otros       String? // Nuevo campo
   }
   ```
2. Genera y aplica la migración localmente:
   ```bash
   pnpm prisma:migrate dev --name add_columna_otros
   ```
3. Ajusta el frontend y backend para usar la columna `otros`.

### Paso 2: Validación en Staging
Sube tus avances a la rama de simulación:
```bash
git checkout staging
git add .
git commit -m "feat: agregar columna otros"
git push origin staging
```
*GitHub compila y despliega en `/opt/monorepo-demo-staging` para que puedas probar.*

### Paso 3: Pase a Producción
Usa GitHub CLI desde tu terminal en WSL para fusionar los cambios probados:
```bash
gh pr create --base main --head staging --fill && gh pr merge --merge
```
El pipeline enviará los cambios al VPS. Al arrancar, el contenedor detectará el nuevo archivo de migración SQL y añadirá la columna a producción de forma segura y sin comandos manuales.
