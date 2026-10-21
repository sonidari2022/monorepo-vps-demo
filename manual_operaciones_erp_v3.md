# Manual de Operaciones y Despliegue CI/CD: Monorepo ERP (v3)

Este documento detalla la arquitectura, configuración y ciclo de vida del proyecto ERP modular. El sistema utiliza un monorepo gestionado con `pnpm`, backend en NestJS con Prisma ORM, frontend en React (Vite), y despliegue automatizado en un VPS de OVHcloud (Ubuntu) mediante GitHub Actions y Docker. La seguridad perimetral se gestiona a través de Cloudflare y Nginx. El VPS aloja dos entornos aislados: **Producción** y **Staging**. PostgreSQL 18 corre en **contenedores propios** (uno por entorno, con una base y un rol por aplicación), independientes de las apps y conectados a ellas mediante redes Docker privadas (sección 14).

## Índice

1. Entorno de desarrollo local (WSL)
2. Infraestructura en la nube (Cloudflare)
3. Preparación del servidor (VPS Ubuntu)
4. Configuración de GitHub (secretos, variables, autenticación, protección de `main`)
5. Archivos del repositorio (Dockerfile, Nginx, compose, versión de pnpm)
6. Archivos de entorno y base de datos en el VPS
7. Workflows de GitHub Actions (staging y producción)
8. Primer despliegue inicial
9. Ciclo de vida: flujo de actualizaciones
10. Mejoras opcionales de rendimiento
11. Staging en un VPS independiente (AWS EC2)
12. Solución de problemas frecuentes
13. Lista de verificación final
14. PostgreSQL en contenedores en el VPS (producción y staging) *(prerrequisito de las secciones 6 y 8)*

> **Novedades de la v3**
>
> * Nueva sección **14**: Postgres 18 en contenedores independientes, con roles aislados por aplicación, redes `db_prod` / `db_stg`, usuarios de administración, backups y desarrollo local en Docker Desktop.
> * **5.4:** la API se une a la red de su base de datos (`db_prod` / `db_stg`).
> * **6.2 a 6.4:** el `DATABASE_URL` apunta al contenedor de Postgres. Se elimina la recomendación de `host.docker.internal` / `extra_hosts`.
> * **8, 11, 12 y 13:** actualizados (orden de despliegue, AWS, solución de problemas y checklist).
> * Las migraciones de Prisma siguen ejecutándose al arrancar la API (no hay paso manual de `migrate deploy`).

---

## 1. Entorno de Desarrollo Local (WSL)

El desarrollo se realiza de forma nativa en WSL, **sin necesidad de instalar Docker en tu computadora local**, garantizando un entorno rápido y ligero.

### Requisitos Previos

* Node.js v24.20.0 o superior (recomendado gestionar con `nvm` utilizando el archivo `.nvmrc`).
* `pnpm` 12.x, con la **versión exacta fijada en el campo `packageManager` del `package.json` raíz** (ver sección 5.5). Se activa con `corepack enable`.
* Base de datos PostgreSQL accesible para desarrollo (puede ser un contenedor en Docker Desktop integrado con WSL; ver 14.16). Esto no instala Docker dentro de WSL: solo usa la integración de Docker Desktop.

> `corepack` viene incluido en Node 24. En Node 25 o superior ya no se incluye y habría que instalarlo aparte.

### Inicialización del Proyecto Local

1. **Activar pnpm con la versión del proyecto:**
   ```bash
   corepack enable
   pnpm -v   # debe coincidir con el campo packageManager del package.json
   ```
2. **Instalar dependencias del monorepo:**
   ```bash
   pnpm install
   ```
3. **Generar el cliente de Prisma:**
   ```bash
   pnpm prisma:generate
   ```
4. **Ejecutar el entorno de desarrollo:**
   Para levantar simultáneamente la API (puerto `3091`) y la Web (puerto `3092`):
   ```bash
   pnpm dev
   ```

---

## 2. Configuración de Infraestructura en Nube (Cloudflare)

Cloudflare gestionará los DNS, forzará la conexión HTTPS pública (Edge SSL) y encriptará el tráfico hacia el VPS (Origin SSL).

### 2.1. Configuración de DNS

En el panel de Cloudflare, crea los siguientes registros apuntando a la IP pública del VPS:

**Producción:**
* **Tipo A:** `api-exa` -> `[IP_DEL_VPS]` (Proxy: Activado / nube naranja)
* **Tipo A:** `web-exa` -> `[IP_DEL_VPS]` (Proxy: Activado / nube naranja)

**Staging (pruebas):**
* **Tipo A:** `api-exa-staging` -> `[IP_DEL_VPS]` (Proxy: Activado / nube naranja)
* **Tipo A:** `web-exa-staging` -> `[IP_DEL_VPS]` (Proxy: Activado / nube naranja)

### 2.2. Certificados de Origen (SSL)

1. Navega a **SSL/TLS** -> **Origin Server** y haz clic en **Create Certificate**.
2. Conserva la configuración por defecto (incluye el comodín `*.midominio.net`) y genera el certificado. Así sirve para producción y staging.
3. Copia los valores proporcionados (`Origin Certificate` y `Private Key`) para utilizarlos en el VPS. La llave privada solo se muestra una vez.
4. En **SSL/TLS** -> **Overview**, establece el modo de encriptación en **Full (Strict)**.
5. En **SSL/TLS** -> **Edge Certificates**, activa **Always Use HTTPS**.

---

## 3. Preparación del Servidor (VPS Ubuntu)

El VPS hospedará las aplicaciones contenerizadas (Producción y Staging) y un servidor Nginx configurado como Reverse Proxy. Se aplica el principio de menor privilegio para los despliegues automáticos.

> **Orden importante:** Docker se instala **antes** de crear el usuario de despliegue, porque el grupo `docker` lo crea la instalación de `docker.io`. Si se invierte el orden, `usermod -aG docker` falla con "group does not exist".

### 3.1. Instalación de Docker y Nginx

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2 nginx
sudo systemctl enable --now docker
```

### 3.2. Creación de Usuario Restringido y Estructura de Directorios

Para evitar otorgar acceso `root` a la automatización de GitHub:

```bash
sudo adduser github-deploy
sudo usermod -aG docker github-deploy
sudo mkdir -p /opt/monorepo-demo /opt/monorepo-demo-staging
sudo chown -R github-deploy:github-deploy /opt/monorepo-demo /opt/monorepo-demo-staging
```

Verifica que el usuario pertenece al grupo:

```bash
id github-deploy   # debe aparecer "docker" en la lista de grupos
```

*(Alternativa si el grupo no existiera: `sudo groupadd docker`. Es más limpio instalar Docker primero.)*

> **Tu usuario administrador (`ubuntu`)** también necesita estar en el grupo `docker` para ejecutar `docker compose` sin `sudo` (por ejemplo, en `/opt/postgres`): `sudo usermod -aG docker ubuntu`, y volver a abrir la sesión SSH. Si no lo haces, verás `permission denied while trying to connect to the Docker daemon socket` (ver 14.2). `github-deploy` **no** necesita acceso a `/opt/postgres`.

### 3.3. Llave SSH de despliegue

#### Por qué se genera en tu WSL y no en el servidor

* **La llave privada nunca toca el VPS.** El servidor solo guarda la pública, que no sirve para entrar. Si el servidor se compromete, no se filtra una credencial de acceso.
* Es más cómodo: la privada debe acabar en GitHub Secrets y desde WSL se copia con `cat`.
* Es la práctica estándar: se genera en una máquina de confianza y al servidor solo se envía la pública.

#### Generar el par de llaves (en WSL)

Usa un nombre propio para no pisar tu llave personal (`id_rsa`) y un algoritmo moderno:

```bash
ssh-keygen -t ed25519 -C "deploy-key-vps" -f ~/.ssh/deploy_vps
```

* Deja la contraseña en blanco (Enter dos veces), porque GitHub Actions no puede escribirla.
* Al terminar muestra un *fingerprint* (`SHA256:...`). Es solo informativo; no se usa en ningún paso.
* Si te pregunta si sobrescribe un archivo existente (`already exists. Overwrite?`), responde **`n`** y usa otro nombre.
* Comprueba los archivos con `ls ~/.ssh`: deben existir `deploy_vps` (privada) y `deploy_vps.pub` (pública).

#### Instalar la llave pública en el VPS

Muestra la pública en WSL y copia la **línea completa** (`ssh-ed25519 AAAA... deploy-key-vps`, incluido el comentario final, en una sola línea):

```bash
cat ~/.ssh/deploy_vps.pub
```

En el VPS, **como el usuario `github-deploy`** (no como `ubuntu`, o la carpeta quedaría en el lugar equivocado):

```bash
sudo su - github-deploy
whoami                          # debe responder: github-deploy
mkdir -p ~/.ssh
chmod 700 ~/.ssh
nano ~/.ssh/authorized_keys     # pega la línea; guarda con Ctrl+O, Enter, Ctrl+X
chmod 600 ~/.ssh/authorized_keys
exit                            # vuelve a ubuntu; github-deploy no debe tener sudo
```

Verificación desde `ubuntu`:

```bash
sudo cat /home/github-deploy/.ssh/authorized_keys
```

#### Probar la conexión desde WSL

```bash
ssh -i ~/.ssh/deploy_vps github-deploy@IP_DEL_VPS
```

* La primera vez aparece *"The authenticity of host ... can't be established"*. Es normal: escribe `yes`. Ese fingerprint es el de la llave del **servidor**; opcionalmente puedes compararlo en el VPS con `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`.
* Si entra sin pedir contraseña, funciona. Si pide contraseña, revisa que `authorized_keys` esté en `/home/github-deploy/.ssh/`, que los permisos sean `700`/`600` y que la línea esté completa.

#### Qué va a cada lugar

| Archivo | Destino |
|---|---|
| `deploy_vps.pub` (pública) | `authorized_keys` de `github-deploy` en el VPS |
| `deploy_vps` (privada, completa con sus líneas `BEGIN` y `END`) | Secreto `VPS_SSH_KEY` en GitHub |

#### Reutilización de llaves

* **Producción y staging en el mismo VPS:** una sola llave sirve, porque ambos se despliegan con el mismo usuario en la misma máquina.
* **Staging en AWS:** se recomienda una llave distinta (`deploy_aws`) con su propio secreto `AWS_VPS_SSH_KEY`: menor radio de daño ante una filtración y rotación independiente.
  ```bash
  ssh-keygen -t ed25519 -C "deploy-key-aws" -f ~/.ssh/deploy_aws
  ```
* En un proyecto pequeño, usar una sola llave para todo es aceptable, asumiendo que una filtración afectaría a todos los servidores.

### 3.4. Configuración de Certificados SSL en el VPS

```bash
sudo mkdir -p /etc/ssl/cloudflare
sudo nano /etc/ssl/cloudflare/origin.pem # Pega el Origin Certificate
sudo nano /etc/ssl/cloudflare/origin.key # Pega la Private Key
sudo chmod 600 /etc/ssl/cloudflare/origin.key
```

### 3.5. Configuración del Reverse Proxy (Nginx) para Producción y Staging

```bash
sudo nano /etc/nginx/sites-available/erp.conf
```

*Contenido del archivo (Producción y Staging en puertos aislados):*

```nginx
# ================= PRODUCCIÓN =================
# Puertos Docker Host: API (3091) | Web (3092)
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

# ================= STAGING ====================
# Puertos Docker Host: API (3093) | Web (3094)
server {
    listen 443 ssl http2;
    server_name api-exa-staging.midominio.net;
    ssl_certificate /etc/ssl/cloudflare/origin.pem;
    ssl_certificate_key /etc/ssl/cloudflare/origin.key;
    location / {
        proxy_pass http://127.0.0.1:3093;
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
    server_name web-exa-staging.midominio.net;
    ssl_certificate /etc/ssl/cloudflare/origin.pem;
    ssl_certificate_key /etc/ssl/cloudflare/origin.key;
    location / {
        proxy_pass http://127.0.0.1:3094;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# ================= REDIRECCIÓN HTTP -> HTTPS =================
server {
    listen 80;
    server_name api-exa.midominio.net web-exa.midominio.net api-exa-staging.midominio.net web-exa-staging.midominio.net;
    return 301 https://$host$request_uri;
}
```

> En versiones recientes de Nginx (1.25.1 o superior), `listen 443 ssl http2;` genera una advertencia de obsolescencia pero sigue funcionando. La forma nueva es `listen 443 ssl;` junto con `http2 on;`.

Habilita el sitio y recarga Nginx:

```bash
sudo ln -s /etc/nginx/sites-available/erp.conf /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 3.6. Configuración del Firewall (UFW)

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Los puertos `3091` a `3094` **no** se abren: solo Nginx (local) accede a ellos, porque los contenedores los publican en `127.0.0.1`.

---

## 4. Configuración de GitHub

### 4.1. Secretos del repositorio

En **Settings -> Secrets and variables -> Actions**, pestaña **Secrets**, usa **Repository secrets** (botón **New repository secret**). Los *Environment secrets* solo están disponibles para jobs que declaran `environment:`, y estos workflows no lo hacen.

| Name | Valor |
|---|---|
| `VPS_HOST` | IP pública del VPS |
| `VPS_USER` | `github-deploy` |
| `VPS_SSH_KEY` | Contenido completo de la llave **privada** `deploy_vps` (`cat ~/.ssh/deploy_vps`), incluidas las líneas `-----BEGIN OPENSSH PRIVATE KEY-----` y `-----END OPENSSH PRIVATE KEY-----` |

`GHCR_PAT` solo se crea si eliges la Opción A de autenticación (sección 4.3).

### 4.2. Variables del repositorio

En la pestaña **Variables** (no en Secrets), porque son valores no sensibles que terminan dentro del JavaScript público del frontend:

| Name | Valor |
|---|---|
| `API_URL_PROD` | `https://api-exa.midominio.net` |
| `API_URL_STAGING` | `https://api-exa-staging.midominio.net` |

### 4.3. Valores que GitHub genera automáticamente

Estos valores aparecen en los workflows pero **no se crean en ninguna parte**:

| Valor | Contiene | ¿Lo creas tú? |
|---|---|---|
| `github.actor` | Usuario que provocó la ejecución (quien hizo el push o fusionó el PR) | No, es automático |
| `github.repository_owner` | Dueño del repositorio (usuario u organización) | No, es automático |
| `env.OWNER` | El dueño anterior en minúsculas, que define el paso "Extract repository owner" del propio workflow | No, lo crea el workflow |
| `secrets.GITHUB_TOKEN` | Token temporal que GitHub genera en cada ejecución y destruye al terminar | No; GitHub ni siquiera permite crear secretos con nombre `GITHUB_*` |

Los permisos de `GITHUB_TOKEN` salen del bloque `permissions:` de cada job (`packages: write` en el build y `packages: read` en el despliegue).

### 4.4. Autenticación del VPS contra GitHub Container Registry (ghcr.io)

Existen dos opciones. **La recomendada es la B.**

| Aspecto | Opción A: `GHCR_PAT` | Opción B: `GITHUB_TOKEN` (recomendada) |
|---|---|---|
| Mantenimiento | Renovación periódica | Ninguno |
| Riesgo si se filtra | Válido hasta que venza o se revoque | Casi nulo, caduca al terminar la ejecución |
| Configuración inicial | Crear token y secreto | Ajuste en el workflow (ya incluido) |
| Cambios en el VPS | Ninguno | Ninguno |

#### Opción B: sin `GHCR_PAT` (recomendada)

El workflow hace `docker login` dentro del paso SSH con `GITHUB_TOKEN`, usando `--password-stdin`, y `docker logout` al final. No hay credenciales de larga duración que renovar ni filtrar. Se usa tal como aparece en la sección 7.

Usar un PAT solo se justifica si necesitas hacer `docker pull` manual en el VPS, o si el paquete pertenece a otra cuenta u organización. Para un `pull` manual puntual, crea un PAT con `read:packages` y expiración corta (7 o 30 días).

#### Opción A: con `GHCR_PAT`

1. En GitHub: `Settings > Developer settings > Personal access tokens (classic)`.
2. Crea un token con **solo** el scope `read:packages`. No hace falta `write:packages`: las imágenes las sube el workflow con su propio token.
3. Define una expiración (90 días o 1 año) en lugar de "No expiration".
4. Guarda el valor como secreto `GHCR_PAT`.
5. En el workflow, activa el bloque comentado de la Opción A y comenta el de la Opción B (sección 7).

**Renovación cuando venza:** el despliegue falla con `unauthorized` o `denied` en `docker compose pull`. Para renovarlo: abre el token, pulsa **Regenerate token**, copia el valor nuevo y actualiza el secreto `GHCR_PAT`. No se toca el VPS ni el workflow. Crea un recordatorio en tu calendario unas dos semanas antes (GitHub también avisa por correo). Si usas *Environments*, actualízalo en cada uno.

### 4.5. Acceso del paquete a Actions (`denied` al descargar imágenes)

Con la Opción B, el `GITHUB_TOKEN` solo accede a paquetes vinculados al repositorio.

**Dónde revisarlo:** tu perfil (u organización) -> pestaña **Packages** -> abrir el paquete -> **Package settings** -> sección **Manage Actions access**. Ahí debe aparecer tu repositorio con rol Read o Write (**Add Repository** si falta). Si **Inherit access from source repository** está activo, normalmente no hay que hacer nada más.

**Escenarios en que aparece `denied`:**

1. El paquete no está vinculado al repositorio (por ejemplo, se subió manualmente con `docker push` desde tu PC). Es la causa más común.
2. Falta la etiqueta de origen en el Dockerfile. Añádela en el Dockerfile de api y de web:
   ```dockerfile
   LABEL org.opencontainers.image.source="https://github.com/TU_USUARIO/TU_REPOSITORIO"
   ```
3. La imagen la publicó otro repositorio: añade el repo que despliega en *Manage Actions access*.
4. Falta `packages: write` en el job de build (falla el push) o `packages: read` en el de despliegue. Revisa también `Settings > Actions > General > Workflow permissions`.
5. El paquete es de una organización con restricciones de acceso.
6. Nombre de imagen con mayúsculas: `ghcr.io` exige minúsculas (el workflow las convierte con `env.OWNER`).

**Diagnóstico rápido:** si falla en el *push* (job de build), suele ser el punto 4; si falla en el *pull* del VPS, suele ser el 1, 2 o 3.

### 4.6. Protección de la rama `main`

**Objetivo:** evitar el push directo a `main`, que dispararía un despliegue a producción sin pasar antes por staging. Hay dos opciones.

| Aspecto | Opción 1: hook local (gratis) | Opción 2: protección de rama en GitHub |
|---|---|---|
| Costo | Ninguno | Gratis solo en repos públicos; en privados requiere Pro, Team o Enterprise |
| Dónde se aplica | Solo en tu máquina | En el servidor de GitHub |
| Se puede saltar | Sí, con `--no-verify` | No, con "Do not allow bypassing" activo |
| Protege desde otras máquinas | No; hay que configurarlo en cada una | Sí |
| Configuración | Script y `git config` | Opciones en la web |

**Ninguna de las dos garantiza que hayas probado en staging.** Evitan el push directo; la disciplina de probar primero sigue dependiendo de ti, aunque el paso extra del PR sirve de recordatorio.

#### Opción 1: hook local `pre-push` (plan gratuito)

Bloquea cualquier push que actualice `main` en el remoto (revisa la rama **destino**, por lo que también detecta `git push origin staging:main`):

```bash
#!/bin/bash
# .githooks/pre-push: bloquea cualquier push que actualice main en el remoto
while read local_ref local_sha remote_ref remote_sha; do
  if [ "$remote_ref" = "refs/heads/main" ]; then
    echo "Push a main bloqueado."
    echo "Prueba primero en staging y luego usa:"
    echo "  gh pr create --base main --head staging --fill && gh pr merge --merge"
    exit 1
  fi
done
exit 0
```

Instalación (con el hook versionado dentro del repositorio):

```bash
mkdir -p .githooks
nano .githooks/pre-push          # pega el script
chmod +x .githooks/pre-push
git config core.hooksPath .githooks
git add .githooks && git commit -m "chore: hook pre-push que bloquea push directo a main"
```

Detalles importantes:

* **Instálalo después del primer despliegue** (sección 8), porque ese push inicial va a `main` y se bloquearía. Si ya lo instalaste, usa `git push --no-verify` solo esa vez.
* **Tu flujo normal no se ve afectado:** `gh pr merge` fusiona en GitHub y no ejecuta `git push` desde tu WSL.
* **Alcance:** `git config core.hooksPath .githooks` se ejecuta sin `--global`, por lo que solo afecta a este repositorio. Los demás proyectos, actuales y futuros, no se ven afectados. Compruébalo con `git config --show-origin core.hooksPath` (debe mostrar `.git/config`).
* **Evita** `git config --global core.hooksPath ...` o `init.templateDir`, que lo extenderían a todos tus repositorios.
* **Otros clones:** el archivo viaja con el código, pero en cada clon nuevo (otra máquina u otro WSL) hay que repetir `git config core.hooksPath .githooks`.
* **Otros proyectos:** copia la carpeta `.githooks` y repite la instalación. Si usan `master` en lugar de `main`, cambia `refs/heads/main` en el script.
* Es una barrera de disciplina, no de seguridad: se salta con `--no-verify` y no protege pushes hechos desde otra máquina sin el hook.

#### Opción 2: protección de rama en GitHub (plan de pago o repositorio público)

1. Ve a `Settings` > `Branches` en el repositorio.
2. En "Branch protection rules", pulsa **Add rule** (el texto del botón puede variar según la versión de la interfaz, por ejemplo "Add classic branch protection rule").
3. En **Branch name pattern**, escribe `main`.
4. Marca **Require a pull request before merging**.
5. **No actives "Require approvals" si trabajas solo:** no puedes aprobar tu propio PR y quedarías bloqueado para pasar a producción.
6. Activa **Do not allow bypassing the above settings** (en algunas versiones, **Include administrators**). Sin ella, la regla no se aplica a ti como administrador y podrías seguir haciendo push directo.
7. Opcional: **Require status checks to pass before merging** (requiere que el workflow también corra en los PR).
8. Pulsa **Create**.

*Disponibilidad:* repositorios públicos con GitHub Free, y públicos y privados con Pro, Team y Enterprise. En un repositorio privado con plan gratuito la opción no estará disponible: usa el hook local.

---

## 5. Archivos del Repositorio

### 5.1. Dockerfile de Web (`apps/web/Dockerfile`)

```dockerfile
FROM node:24-alpine AS base
# No usar "corepack prepare pnpm@latest": la versión se define en packageManager (package.json)
RUN corepack enable

FROM base AS builder
WORKDIR /app
COPY . .
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm install --frozen-lockfile
RUN pnpm --filter web build

FROM nginx:alpine AS runner
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

Puntos clave:

* **Las variables `VITE_*` se incrustan al compilar**, no al arrancar el contenedor. Por eso se pasan con `ARG`/`ENV` y `build-args` en el workflow; **definirlas en `environment:` del compose no tiene ningún efecto**.
* Si cambias la URL de la API, debes **volver a construir la imagen web** (un nuevo despliegue). Reiniciar el contenedor no basta.
* La URL de la API acaba dentro del JavaScript público: un dominio no es un secreto.
* Si cambiaste `build.outDir` de Vite, ajusta el `COPY --from=builder`.
* Añade la etiqueta `LABEL org.opencontainers.image.source=...` (sección 4.5).
* El Dockerfile de api no se documenta aquí; revisa que `npx prisma migrate deploy` se ejecute al arrancar el contenedor de la API (ver sección 8).

### 5.2. `.dockerignore` (raíz del repositorio)

Con `COPY . .`, sin este archivo se envían al contexto de build `.git`, `node_modules` locales y archivos `.env`:

```
node_modules
**/node_modules
**/dist
.git
.env
**/.env
```

### 5.3. Nginx del contenedor web (`apps/web/nginx.conf`)

Este Nginx es el **del contenedor**, distinto del Nginx del VPS (reverse proxy).

**Versión básica (suficiente):** `try_files $uri $uri/ /index.html;` es la línea clave para el enrutamiento de la aplicación de una sola página; sin ella, recargar `/clientes` daría 404.

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

**Versión mejorada (opcional):** añade compresión y caché. Los archivos de `assets/` tienen hash en el nombre y pueden cachearse un año; `index.html` no debe cachearse, o tras un despliegue los usuarios verían una pantalla en blanco hasta forzar la recarga.

```nginx
server {
    listen 80;
    server_name localhost;

    root /usr/share/nginx/html;
    index index.html;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml image/svg+xml;

    # Archivos con hash: caché larga
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    # SPA: cualquier otra ruta devuelve index.html, sin caché
    location / {
        add_header Cache-Control "no-cache";
        try_files $uri $uri/ /index.html;
    }
}
```

Si tu `build.assetsDir` de Vite es otro, ajusta el `location /assets/`.

### 5.4. Archivos docker-compose

> **Prerrequisito:** las redes `db_prod` y `db_stg` las crea el compose de Postgres (`/opt/postgres`, sección 14). Levántalo **antes** del primer despliegue de las apps; de lo contrario `docker compose up` falla con `network db_prod declared as external, but could not be found`.

#### Producción (`docker-compose.vps.yml`)

```yaml
services:
  api:
    image: ghcr.io/${GITHUB_OWNER:?Falta GITHUB_OWNER en .env}/my-monorepo-api:latest
    container_name: monorepo_api
    restart: always
    ports:
      - "127.0.0.1:3091:3091"
    environment:
      - PORT=3091
      - NODE_ENV=production
      - DATABASE_URL=${DATABASE_URL:?Falta DATABASE_URL en .env}
    networks:
      - app-network
      - db_prod

  web:
    image: ghcr.io/${GITHUB_OWNER:?Falta GITHUB_OWNER en .env}/my-monorepo-web:latest
    container_name: monorepo_web
    restart: always
    ports:
      - "127.0.0.1:3092:80"
    # VITE_API_URL no va aquí: Vite la incrusta al compilar (build-args del workflow)
    networks:
      - app-network

networks:
  app-network:
    driver: bridge
  db_prod:
    external: true
    name: db_prod
```

Notas:

* La línea `version:` está obsoleta en Compose v2 y se omite.
* `${VAR:?mensaje}` hace que el despliegue falle con un mensaje claro si falta la variable en el `.env`.
* **No incluir `VITE_API_URL` en `environment`** del servicio `web` (ver 5.1).
* Los puertos enlazados a `127.0.0.1` son accesibles solo para Nginx desde el propio servidor.
* Solo la **API** se une a la red de la base de datos; el `web` no la necesita.
* `db_prod` es una red **externa** (creada por `/opt/postgres`). Mantén `app-network` en la API para que siga comunicándose con el `web`.

#### Staging (`docker-compose.staging.yml`)

Mismo esquema, con estas diferencias, necesarias para que ambos entornos convivan en el mismo VPS:

| | Producción | Staging |
|---|---|---|
| Etiqueta de imagen | `:latest` | `:staging` |
| Puertos del host | `3091` y `3092` | `3093` y `3094` |
| `container_name` | `monorepo_api`, `monorepo_web` | `monorepo_api_staging`, `monorepo_web_staging` |
| Red de base de datos | `db_prod` | `db_stg` |
| Host de la BD en `DATABASE_URL` | `erp_postgres_prod` | `erp_postgres_stg` |
| Base y rol | `monorepodemo_prod` / `monorepodemo_prod_user` | `monorepodemo_stg` / `monorepodemo_stg_user` |
| Archivo `.env` | `/opt/monorepo-demo/.env` | `/opt/monorepo-demo-staging/.env` |
| Variable del frontend en el build | `API_URL_PROD` | `API_URL_STAGING` |

```yaml
services:
  api:
    image: ghcr.io/${GITHUB_OWNER:?Falta GITHUB_OWNER en .env}/my-monorepo-api:staging
    container_name: monorepo_api_staging
    restart: always
    ports:
      - "127.0.0.1:3093:3091"   # el contenedor sigue escuchando en 3091
    environment:
      - PORT=3091
      - NODE_ENV=production
      - DATABASE_URL=${DATABASE_URL:?Falta DATABASE_URL en .env}
    networks:
      - app-network
      - db_stg

  web:
    image: ghcr.io/${GITHUB_OWNER:?Falta GITHUB_OWNER en .env}/my-monorepo-web:staging
    container_name: monorepo_web_staging
    restart: always
    ports:
      - "127.0.0.1:3094:80"
    networks:
      - app-network

networks:
  app-network:
    driver: bridge
  db_stg:
    external: true
    name: db_stg
```

> Si dos entornos usan los mismos `container_name`, Docker no podrá arrancar ambos en el mismo VPS. Con proyectos Compose en carpetas distintas, las redes `app-network` quedan separadas automáticamente (`monorepo-demo_app-network` y `monorepo-demo-staging_app-network`).
>
> Usar **una red de base de datos por entorno** garantiza que la API de staging ni siquiera pueda ver el Postgres de producción.

### 5.5. Versión de pnpm: una sola fuente de verdad

La versión de pnpm se define **únicamente** en el campo `packageManager` del `package.json` raíz, y todo lo demás debe leer ese valor:

```json
{
  "name": "monorepo-vps-project",
  "private": true,
  "packageManager": "pnpm@12.8.0",
  "engines": { "node": ">=24.20.0" }
}
```

**Dónde pueden chocar las versiones y cómo evitarlo:**

| Lugar | Riesgo | Qué hacer |
|---|---|---|
| **Dockerfile** | `corepack prepare pnpm@latest` activa una versión distinta de la fijada, y el build cambia solo cuando sale una nueva | Usar solo `RUN corepack enable` |
| **Workflow de GitHub Actions** | Un paso con `pnpm/action-setup` y `version: latest` (o un número distinto) | No instalar pnpm en el workflow: el build ocurre dentro de Docker, que ya usa `packageManager` |
| **WSL local** | Un pnpm global distinto puede reescribir `pnpm-lock.yaml` con otro formato | Activar con `corepack enable` y comprobar con `pnpm -v` |
| **Otros clones o máquinas** | Un lockfile de otro formato rompe `--frozen-lockfile` | Mismo procedimiento |

**Por qué importa:** `pnpm install --frozen-lockfile` falla si el formato del lockfile no coincide con la versión que lo lee, y con `latest` un despliegue que funcionó ayer puede fallar hoy sin cambios.

**Cómo actualizar pnpm de forma ordenada:**

1. Consultar las versiones disponibles: `npm view pnpm dist-tags`.
2. Cambiar el valor de `packageManager` en el `package.json`.
3. Ejecutar `pnpm install` en WSL para regenerar el lockfile y hacer commit de **ambos archivos**.
4. Subir a `staging` y verificar el build antes de pasar a producción.

**Comprobaciones rápidas:**

```bash
pnpm -v                          # debe coincidir con packageManager
grep packageManager package.json
```

---

## 6. Archivos de Entorno y Base de Datos en el VPS

### 6.1. Cómo obtiene Compose sus variables

Las variables como `${GITHUB_OWNER}` y `${DATABASE_URL}` se resuelven, en orden de prioridad, desde: (1) variables exportadas en la shell, (2) el archivo **`.env` en la misma carpeta que el compose**, (3) valores por defecto del compose (`${VAR:-valor}`).

El workflow ejecuta `cd /opt/monorepo-demo` antes de `docker compose`, así que el `.env` de esa carpeta se lee solo. **Ese archivo no viaja desde el repositorio**: se crea una vez a mano en el VPS, y por eso mantiene los secretos fuera de GitHub. Sin él, `GITHUB_OWNER` queda vacío y el `pull` falla.

### 6.2. Crear el `.env` de cada entorno

```bash
cd /opt/monorepo-demo
nano .env
chmod 600 .env
```

```env
GITHUB_OWNER=tu_usuario_en_minusculas
DATABASE_URL=postgresql://monorepodemo_prod_user:CLAVE@erp_postgres_prod:5432/monorepodemo_prod?schema=public
```

Repite en `/opt/monorepo-demo-staging/.env` con el host `erp_postgres_stg`, el rol `monorepodemo_stg_user` y la base `monorepodemo_stg`.

* El host es el **nombre del contenedor** de Postgres y el puerto es siempre el interno `5432` (el `5433` de staging solo existe en el host, para túneles SSH).
* La `CLAVE` es la definida para ese rol en `/opt/postgres/.env` (sección 14.4).
* El workflow **no** copia ni sobrescribe el `.env`.
* **Nunca subirlo al repositorio:** añade `.env` al `.gitignore`. Sí puedes subir un `.env.example` con valores falsos como plantilla.
* Si la clave contiene `$`, escríbelo como `$$` (Compose lo interpreta como variable). Lo más simple es generar claves solo con letras y números (`openssl rand -hex 24`).

### 6.3. Crear la base de datos y el usuario

Prisma crea las **tablas**, pero no la base de datos ni el rol. En esta arquitectura los crea el script de inicialización del Postgres en contenedor (`/opt/postgres/init/01-init-dbs.sh`), una sola vez, al primer arranque. El procedimiento completo está en la **sección 14**.

* **Una base y un rol por aplicación y por entorno**, con el rol como dueño de su base y sin acceso a las demás.
* **Staging usa su propio contenedor, base y rol** (`erp_postgres_stg`), para que las migraciones de prueba nunca toquen producción.
* Para agregar una aplicación nueva después, ver 14.13.
* Si usas un servicio de Postgres **externo o administrado** en lugar de contenedores, créalos desde su panel y copia la cadena de conexión; en ese caso no aplican las redes `db_*`.

### 6.4. Formato y problemas habituales de `DATABASE_URL`

```
postgresql://USUARIO:CLAVE@HOST:5432/BASE?schema=public
```

* Si la clave tiene caracteres especiales (`@`, `:`, `/`, `#`, `%`), codifícalos (por ejemplo `@` -> `%40`), o la conexión fallará. Evítalo generando claves alfanuméricas.
* En servicios externos suele hacer falta `&sslmode=require`.
* **`localhost` dentro de un contenedor apunta al propio contenedor**, no al VPS. Por eso el host debe ser el nombre del contenedor de Postgres (`erp_postgres_prod` / `erp_postgres_stg`).
* Para que Docker resuelva ese nombre, la API debe estar en la misma red que Postgres (`db_prod` o `db_stg`, ver 5.4).
* **No uses `host.docker.internal` ni `extra_hosts`**: esa alternativa obliga a abrir Postgres en el host a más interfaces. Con redes Docker compartidas no hace falta tocar `pg_hba.conf` ni `listen_addresses`.
* No hace falta `depends_on`: no funciona entre composes distintos, y `restart: always` reintenta la API hasta que la base esté lista.

---

## 7. Workflows de GitHub Actions

Reglas generales:

* **Nunca se escribe una credencial en el workflow.** Todo se referencia con `${{ secrets.NOMBRE }}` o `${{ vars.NOMBRE }}` (ver tabla 4.3).
* Los workflows contienen **dos decisiones independientes**:
  * **Autenticación en ghcr.io:** Opción A (`GHCR_PAT`) u Opción B (`GITHUB_TOKEN`, activa por defecto).
  * **Archivo compose:** Forma 1 (copia automática por SCP, activa por defecto) o Forma 2 (manual).

| | Opción B (`GITHUB_TOKEN`) | Opción A (`GHCR_PAT`) |
|---|---|---|
| **Forma 1** (SCP) | Recomendada | Válida |
| **Forma 2** (manual) | Válida | Válida |

**Forma 1 (automática):** cada `push` copia el compose del repositorio al VPS, que es la fuente de verdad. Requiere el archivo en la raíz del repositorio. El `.env` no se copia.

**Forma 2 (manual):** borra los pasos `Checkout` y `Copy compose file` del job de despliegue y copia el archivo tú mismo, una vez y cada vez que lo modifiques:

```bash
scp -i ~/.ssh/deploy_vps docker-compose.staging.yml github-deploy@IP_DEL_VPS:/opt/monorepo-demo-staging/
```

Riesgo: el archivo del VPS y el del repositorio pueden quedar desincronizados.

### 7.1. Staging (`.github/workflows/deploy-staging.yml`)

```yaml
name: CI/CD Pipeline - Deploy to Staging

on:
  push:
    branches:
      - staging

jobs:
  build-and-push-staging:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract repository owner name lowercase
        id: repo_owner
        run: echo "OWNER=$(echo "${{ github.repository_owner }}" | tr '[:upper:]' '[:lower:]')" >> $GITHUB_ENV

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build and push API image (Staging)
        uses: docker/build-push-action@v5
        with:
          context: .
          file: ./apps/api/Dockerfile
          push: true
          tags: ghcr.io/${{ env.OWNER }}/my-monorepo-api:staging

      - name: Build and push Web image (Staging)
        uses: docker/build-push-action@v5
        with:
          context: .
          file: ./apps/web/Dockerfile
          push: true
          build-args: |
            VITE_API_URL=${{ vars.API_URL_STAGING }}
          tags: ghcr.io/${{ env.OWNER }}/my-monorepo-web:staging

  deploy-to-vps-staging:
    needs: build-and-push-staging
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: read

    steps:
      # =================================================================
      # ARCHIVO COMPOSE - FORMA 1 (ACTIVA): copia automática por SCP
      # FORMA 2 (MANUAL): borra o comenta los dos pasos siguientes
      # (Checkout y Copy compose file) y copia el archivo a mano.
      # =================================================================
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Copy compose file to VPS
        uses: appleboy/scp-action@v0.1.7
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          source: docker-compose.staging.yml
          target: /opt/monorepo-demo-staging/

      - name: Deploy Staging to VPS via SSH
        uses: appleboy/ssh-action@v1.0.3
        # ---------------------------------------------------------------
        # AUTENTICACIÓN - OPCIÓN B (ACTIVA): GITHUB_TOKEN (sin GHCR_PAT)
        # ---------------------------------------------------------------
        env:
          GHCR_USER: ${{ github.actor }}
          GHCR_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          envs: GHCR_USER,GHCR_TOKEN
          script: |
            cd /opt/monorepo-demo-staging
            echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
            docker compose -f docker-compose.staging.yml pull
            docker compose -f docker-compose.staging.yml up -d --remove-orphans
            docker image prune -f
            docker logout ghcr.io

        # ---------------------------------------------------------------
        # AUTENTICACIÓN - OPCIÓN A (COMENTADA): GHCR_PAT
        # Para usarla: comenta el bloque de la Opción B (env, envs y script)
        # y descomenta este bloque. Requiere el secreto GHCR_PAT en GitHub
        # (token clásico con scope read:packages y expiración definida).
        # ---------------------------------------------------------------
        # with:
        #   host: ${{ secrets.VPS_HOST }}
        #   username: ${{ secrets.VPS_USER }}
        #   key: ${{ secrets.VPS_SSH_KEY }}
        #   script: |
        #     cd /opt/monorepo-demo-staging
        #     echo "${{ secrets.GHCR_PAT }}" | docker login ghcr.io -u ${{ github.actor }} --password-stdin
        #     docker compose -f docker-compose.staging.yml pull
        #     docker compose -f docker-compose.staging.yml up -d --remove-orphans
        #     docker image prune -f
        #     docker logout ghcr.io
```

### 7.2. Producción (`.github/workflows/deploy-prod.yml`)

```yaml
name: CI/CD Pipeline - Deploy to Production

on:
  push:
    branches:
      - main

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract repository owner name lowercase
        id: repo_owner
        run: echo "OWNER=$(echo "${{ github.repository_owner }}" | tr '[:upper:]' '[:lower:]')" >> $GITHUB_ENV

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build and push API image (Production)
        uses: docker/build-push-action@v5
        with:
          context: .
          file: ./apps/api/Dockerfile
          push: true
          tags: ghcr.io/${{ env.OWNER }}/my-monorepo-api:latest

      - name: Build and push Web image (Production)
        uses: docker/build-push-action@v5
        with:
          context: .
          file: ./apps/web/Dockerfile
          push: true
          build-args: |
            VITE_API_URL=${{ vars.API_URL_PROD }}
          tags: ghcr.io/${{ env.OWNER }}/my-monorepo-web:latest

  deploy-to-vps:
    needs: build-and-push
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: read

    steps:
      # =================================================================
      # ARCHIVO COMPOSE - FORMA 1 (ACTIVA): copia automática por SCP
      # FORMA 2 (MANUAL): borra o comenta los dos pasos siguientes
      # (Checkout y Copy compose file) y copia el archivo a mano.
      # =================================================================
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Copy compose file to VPS
        uses: appleboy/scp-action@v0.1.7
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          source: docker-compose.vps.yml
          target: /opt/monorepo-demo/

      - name: Deploy to VPS via SSH
        uses: appleboy/ssh-action@v1.0.3
        # ---------------------------------------------------------------
        # AUTENTICACIÓN - OPCIÓN B (ACTIVA): GITHUB_TOKEN (sin GHCR_PAT)
        # ---------------------------------------------------------------
        env:
          GHCR_USER: ${{ github.actor }}
          GHCR_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          envs: GHCR_USER,GHCR_TOKEN
          script: |
            cd /opt/monorepo-demo
            echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
            docker compose -f docker-compose.vps.yml pull
            docker compose -f docker-compose.vps.yml up -d --remove-orphans
            docker image prune -f
            docker logout ghcr.io

        # ---------------------------------------------------------------
        # AUTENTICACIÓN - OPCIÓN A (COMENTADA): GHCR_PAT
        # Para usarla: comenta el bloque de la Opción B (env, envs y script)
        # y descomenta este bloque. Requiere el secreto GHCR_PAT en GitHub
        # (token clásico con scope read:packages y expiración definida).
        # ---------------------------------------------------------------
        # with:
        #   host: ${{ secrets.VPS_HOST }}
        #   username: ${{ secrets.VPS_USER }}
        #   key: ${{ secrets.VPS_SSH_KEY }}
        #   script: |
        #     cd /opt/monorepo-demo
        #     echo "${{ secrets.GHCR_PAT }}" | docker login ghcr.io -u ${{ github.actor }} --password-stdin
        #     docker compose -f docker-compose.vps.yml pull
        #     docker compose -f docker-compose.vps.yml up -d --remove-orphans
        #     docker image prune -f
        #     docker logout ghcr.io
```

**Diferencias entre ambos workflows**

| | Staging | Producción |
|---|---|---|
| Rama | `staging` | `main` |
| Ruta en el VPS | `/opt/monorepo-demo-staging` | `/opt/monorepo-demo` |
| Archivo compose | `docker-compose.staging.yml` | `docker-compose.vps.yml` |
| Etiqueta de imagen | `:staging` | `:latest` |
| Variable del frontend | `API_URL_STAGING` | `API_URL_PROD` |

---

## 8. Primer Despliegue Inicial (Puesta en Marcha)

Este proceso lleva el código desde tu entorno local hasta el VPS por primera vez, delegando la construcción de los contenedores Docker completamente a GitHub Actions.

**Antes de empezar, verifica:** DNS y certificados (sección 2), VPS preparado (sección 3), secretos y variables de GitHub (sección 4), archivos `.env` de cada entorno en el VPS (sección 6) y **Postgres levantado con sus bases y roles creados (sección 14)**.

### Paso 1: Levantar PostgreSQL y verificar las bases

Levanta `/opt/postgres` (sección 14), comprueba que existan las redes `db_prod` y `db_stg` y que cada rol solo acceda a su base (14.7 y 14.8). No necesitas crear tablas manualmente: Prisma lo hará al arrancar la API. Después crea los `.env` de cada app con su `DATABASE_URL` (6.2).

### Paso 2: Subir el Código Fuente a GitHub

Desde la terminal de tu WSL:

```bash
git init
git add .
git commit -m "commit inicial: arquitectura monorepo, nestjs y react"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/TU_REPOSITORIO.git
git push -u origin main
```

*(No ejecutas ningún `docker build` aquí. Todo ocurre en la nube.)* **Instala el hook de protección de `main` (4.6) después de este primer push.**

### Paso 3: Compilación Automática (CI/CD)

Al recibir el `git push`, GitHub Actions inicia una máquina virtual temporal que:

1. Lee los `Dockerfile` de la API y de la Web.
2. Compila el código y empaqueta las imágenes Docker (la web recibe `VITE_API_URL` como `build-arg`).
3. Guarda las imágenes en GitHub Container Registry (`ghcr.io`).

### Paso 4: Ejecución Automática en el VPS

Tras compilar, el pipeline se conecta por SSH al VPS como `github-deploy`, se autentica en `ghcr.io` y ejecuta:

```bash
docker compose -f docker-compose.vps.yml pull
docker compose -f docker-compose.vps.yml up -d --remove-orphans
```

Durante el primer arranque del contenedor de la API se ejecuta `npx prisma migrate deploy`, que crea automáticamente las tablas en PostgreSQL a partir de las migraciones del repositorio. No hay un paso manual de migración en el workflow.

> Para que esto funcione, el CLI de `prisma` debe existir en la **imagen final** de la API (en `dependencies`, no solo en `devDependencies` podadas). Si la API se reinicia en bucle, revisa `docker logs monorepo_api`.

En minutos, `api-exa` y `web-exa` estarán funcionales y seguros.

---

## 9. Ciclo de Vida: Flujo de Trabajo para Actualizaciones

Ejemplo: agregar una nueva columna `otros` a la base de datos.

### Paso 1: Desarrollo Local (WSL)

1. Modifica `apps/api/prisma/schema.prisma`:
   ```prisma
   model Ejemplo {
     id          Int     @id @default(autoincrement())
     descripcion String
     otros       String? // Nuevo campo
   }
   ```
2. Genera y aplica la migración localmente. El script `prisma:migrate` ya incluye `migrate dev`, por lo que **no se repite `dev`**:
   ```bash
   pnpm prisma:migrate --name add_columna_otros
   ```
3. Ajusta el frontend y el backend para usar la columna `otros`.

### Paso 2: Validación en Staging (automática vía `push`)

```bash
git checkout staging
git add .
git commit -m "feat: agregar columna otros"
git push origin staging
```

GitHub compila las imágenes, sincroniza el compose y despliega en `/opt/monorepo-demo-staging`. Prueba en `web-exa-staging` y `api-exa-staging`.

### Paso 3: Pase a Producción

Usa GitHub CLI desde tu terminal en WSL para fusionar los cambios probados:

```bash
gh pr create --base main --head staging --fill && gh pr merge --merge
```

El pipeline enviará los cambios al VPS. Al arrancar, el contenedor detectará el nuevo archivo de migración SQL y añadirá la columna a producción sin comandos manuales.

### Actualizar dependencias (`package.json` de api o web)

Las dependencias **no se instalan en el VPS**: `pnpm install` corre durante el build de Docker dentro de GitHub Actions, con paquetes del registro público de npm. El token de ghcr no interviene.

1. Actualiza la versión en `package.json` y ejecuta `pnpm install`, que actualiza `pnpm-lock.yaml`.
2. Haz commit de **ambos archivos** (el Dockerfile usa `--frozen-lockfile`).
3. Push a `staging`, prueba y pasa a producción como cualquier otro cambio.

---

## 10. Mejoras Opcionales de Rendimiento

*Ninguna es necesaria. Considéralas solo si los builds se vuelven lentos.*

### 10.1. Caché de capas de Docker (`cache-from` / `cache-to`)

* **Finalidad:** cada ejecución de Actions arranca en una máquina vacía y reconstruye todas las capas. Estas líneas leen (`cache-from`) y guardan (`cache-to`) las capas en la caché de GitHub Actions para reutilizar las que no cambiaron. `mode=max` guarda también las capas intermedias, necesario porque casi todo el trabajo ocurre en la etapa `builder`.
* **Dónde:** dentro del `with:` de **cada** paso `docker/build-push-action` (4 pasos en total, requiere `docker/setup-buildx-action`). Usa `scope` para que las cachés no se pisen:

```yaml
      - name: Build and push API image (Production)
        uses: docker/build-push-action@v5
        with:
          context: .
          file: ./apps/api/Dockerfile
          push: true
          tags: ghcr.io/${{ env.OWNER }}/my-monorepo-api:latest
          cache-from: type=gha,scope=api-prod
          cache-to: type=gha,mode=max,scope=api-prod
```

En el resto de los pasos, usa `web-prod`, `api-staging` y `web-staging`.

**Limitaciones:**

1. Con `COPY . .` antes de `pnpm install`, cualquier cambio de código invalida el `install` y la caché ahorra poco. Para que sea efectiva, ver 10.3.
2. Límite de 10 GB por repositorio; lo no usado en 7 días se elimina.
3. Una ejecución lee las cachés de su rama y de la rama principal, no las de otras ramas. Staging aprovecha lo cacheado por `main`, pero no al revés.
4. Si un build no refleja un cambio, borra las cachés en **Actions > Caches**.

### 10.2. Instalar solo lo que web necesita (`--filter web...`)

```dockerfile
RUN pnpm install --frozen-lockfile --filter web...
RUN pnpm --filter web build
```

Instala solo las dependencias de `web` y de los paquetes internos de los que depende (los **tres puntos** son esenciales: `--filter web` sin ellos excluiría los paquetes internos). La imagen no descarga NestJS ni Prisma.

**Riesgo de dependencias cruzadas.** Puede fallar si:

1. Web usa algo declarado solo en el `package.json` **raíz** (el filtro no lo instala).
2. Un paquete interno (por ejemplo `packages/shared`) necesita compilarse antes: usa `pnpm --filter web... build`.
3. Web importa código o tipos desde api (como el cliente de Prisma generado).
4. Hay scripts `postinstall` que esperan otro paquete instalado.

**Cómo saber si te afecta:** busca entradas `workspace:` en `apps/web/package.json`, revisa si existe `packages/` y `pnpm-workspace.yaml`, y comprueba que web no importe desde `../api`.

**Prueba local previa** (en una copia o rama de prueba, porque borra `node_modules`):

```bash
rm -rf node_modules apps/*/node_modules
pnpm install --frozen-lockfile --filter web...
pnpm --filter web build
```

Si genera `apps/web/dist`, es seguro. Si falla con módulos no encontrados, sabrás qué dependencia falta. Prueba después en staging; si algo falla, vuelves a `pnpm install --frozen-lockfile`.

### 10.3. Copiar primero los manifiestos (caché del `install`)

Copiar `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` y los `package.json` de cada app **antes** de `COPY . .` permite reutilizar la capa de `pnpm install` mientras las dependencias no cambien. Depende de la estructura exacta del monorepo.

---

## 11. Staging en un VPS Independiente (AWS EC2)

1. **Secretos dedicados:** crea `AWS_VPS_HOST`, `AWS_VPS_USER` (`ubuntu`) y `AWS_VPS_SSH_KEY` (llave propia `deploy_aws`, ver 3.3).
2. **Puertos:** al no compartir máquina con producción, el compose de staging puede volver a usar los puertos estándar (`3091`/`3092`), y el Nginx de esa máquina se ajusta en consecuencia.
3. **Security Groups:** reemplaza `ufw` por reglas de entrada en la consola de AWS, abriendo los puertos 22, 80 y 443.
4. **DNS:** los registros de staging en Cloudflare deben apuntar a la IP pública de la instancia EC2.
5. **PostgreSQL de staging:** esa máquina necesita su propio Postgres en contenedor (`/opt/postgres` solo con el servicio `postgres_stg` y su red `db_stg`, sección 14). El `DATABASE_URL` de staging apunta a `erp_postgres_stg` y la red externa `db_stg` sigue igual en el compose.
6. **Environments (opcional):** si más adelante producción y staging usan valores distintos con el mismo nombre de secreto, o quieres aprobación manual antes de desplegar a producción, crea *Environments* en GitHub y añade `environment:` al job correspondiente.

---

## 12. Solución de Problemas Frecuentes

| Síntoma | Causa probable | Solución |
|---|---|---|
| `usermod: group 'docker' does not exist` | Docker no estaba instalado todavía | Instalar `docker.io` primero (3.1) y repetir `usermod` |
| SSH pide contraseña tras `yes` | `authorized_keys` en el lugar equivocado, permisos incorrectos o línea incompleta | Revisar ubicación en `/home/github-deploy/.ssh/`, permisos `700`/`600` y línea completa (3.3) |
| `authenticity of host can't be established` | Primera conexión al servidor | Responder `yes` (normal) |
| `docker compose pull` falla con `unauthorized` | PAT vencido (Opción A) | Regenerar el token y actualizar `GHCR_PAT` (4.4) |
| `docker compose pull` falla con `denied` | Paquete no vinculado al repositorio | Revisar *Manage Actions access* y la etiqueta `LABEL` (4.5) |
| Imagen `ghcr.io//my-monorepo-api` | Falta `GITHUB_OWNER` en el `.env` | Crear el `.env` en la carpeta del compose (6.2) |
| El workflow no se ejecuta | Error de sintaxis YAML | Revisar el mensaje en la pestaña Actions |
| El frontend llama a una URL de API incorrecta o vacía | `VITE_API_URL` no llegó al build | Verificar `build-args`, la variable `API_URL_*` y reconstruir la imagen (5.1) |
| Error 404 al recargar una ruta del frontend | Falta `try_files ... /index.html` | Revisar `nginx.conf` (5.3) |
| Pantalla en blanco tras un despliegue | `index.html` cacheado apuntando a archivos antiguos | Usar la versión mejorada de `nginx.conf` con `no-cache` en `index.html` |
| `prisma migrate dev dev ...` falla | Se repitió `dev` en el comando | Usar `pnpm prisma:migrate --name ...` (9) |
| El build falla con pnpm no encontrado o lockfile incompatible | Versiones de pnpm distintas | Fijar la versión en `packageManager` y usar `corepack enable` (5.5) |
| Error de conexión a la base de datos | Caracteres especiales en la clave, `localhost` dentro del contenedor, o la API fuera de la red de la BD | Codificar la clave; usar como host el nombre del contenedor (`erp_postgres_prod`) y verificar que la API esté en `db_prod` / `db_stg` (6.4, 14.10) |
| `container name already in use` | Staging y producción comparten `container_name` | Usar nombres distintos (5.4) |
| `protected branch hook declined` o hook que bloquea el push | Protección de `main` funcionando | Usar `staging` y luego el PR (4.6) |
| `git push` a `main` bloqueado en el primer despliegue | Hook instalado antes del push inicial | `git push --no-verify` solo esa vez |
| `network db_prod declared as external, but could not be found` | Postgres no se levantó antes que la app | `cd /opt/postgres && docker compose up -d` (14.7) |
| `permission denied ... docker.sock` | El usuario no está en el grupo `docker` | `sudo usermod -aG docker ubuntu` y reconectar SSH (14.2) |
| Contenedor de Postgres en `Restarting` con `initdb: superuser name ... is disallowed` | El nombre del admin empieza con `pg_` (reservado) | Usar otro nombre (`dbadmin_prod`) y recrear el volumen (14.17) |
| Los roles y bases no se crearon | El script de init solo corre con el volumen vacío | Ver 14.13 y 14.17 |
| `FATAL: database "usuario" does not exist` al usar `psql` | No se indicó `-d`; `psql` busca una base con el nombre del usuario | Agregar `-d nombre_base` (14.12) |
| `permission denied for database` | El rol intenta entrar a una base que no es suya (aislamiento correcto) | Usar el rol y la base correspondientes |
| La API se reinicia en bucle tras desplegar | Falta el CLI de `prisma` en la imagen, `DATABASE_URL` incorrecto o la API no está en la red de la BD | `docker logs monorepo_api`; revisar 8 (Paso 4) y 14.10 |

---

## 13. Lista de Verificación Final

**Cloudflare**
- [ ] Registros DNS de producción y staging con proxy activado
- [ ] Certificado de origen creado; modo **Full (Strict)** y **Always Use HTTPS**

**VPS**
- [ ] Docker y Nginx instalados antes de crear el usuario
- [ ] Usuario `github-deploy` en el grupo `docker` y directorios creados
- [ ] Llave pública instalada y conexión SSH probada
- [ ] Certificados en `/etc/ssl/cloudflare/` y `erp.conf` habilitado
- [ ] UFW con puertos 22, 80 y 443
- [ ] `.env` de producción y de staging (permisos `600`)
- [ ] Usuario `ubuntu` en el grupo `docker`
- [ ] `/opt/postgres` levantado (`docker compose ps`: ambos contenedores en `Up`), con redes `db_prod` y `db_stg`
- [ ] Bases y roles creados por app y entorno; aislamiento probado (14.8)
- [ ] Postgres publicado solo en `127.0.0.1` (puertos `5432` y `5433`)
- [ ] `/opt/postgres/.env` con permisos `600`; claves distintas por rol y entorno
- [ ] Backups programados y copiados fuera del VPS (14.14)

**GitHub**
- [ ] Secretos de repositorio: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`
- [ ] Variables: `API_URL_PROD`, `API_URL_STAGING`
- [ ] Workflows `deploy-staging.yml` y `deploy-prod.yml` en `.github/workflows/`
- [ ] Protección de `main` (hook local o regla de rama)

**Repositorio**
- [ ] `packageManager` fijado y sin `pnpm@latest` en Dockerfiles ni workflows
- [ ] `.dockerignore` y `.env` en `.gitignore`
- [ ] Compose sin `VITE_API_URL` en `environment`
- [ ] `LABEL org.opencontainers.image.source` en los Dockerfile
- [ ] `docker-compose.vps.yml` y `docker-compose.staging.yml` en la raíz, con la API unida a `db_prod` / `db_stg`
- [ ] `DATABASE_URL` de cada `.env` con host `erp_postgres_prod` / `erp_postgres_stg`
- [ ] CLI de `prisma` disponible en la imagen final de la API

---

## 14. PostgreSQL en Contenedores en el VPS (Producción y Staging)

Esta sección documenta cómo se montó PostgreSQL de forma **independiente de las aplicaciones**: un contenedor por entorno, con una base de datos y un rol por aplicación. Es prerrequisito de las secciones 6 y 8. Se construye una sola vez, a mano, con el usuario administrador (`ubuntu`); el workflow de GitHub **no** interviene aquí.

### 14.1. Arquitectura

```
/opt/postgres  (compose propio, administrado por ubuntu)
├── erp_postgres_prod  (postgres:18.6, 127.0.0.1:5432, red db_prod, volumen postgres_pgdata_prod)
│     ├── erp_prod              <- dueño: erp_prod_user
│     └── monorepodemo_prod     <- dueño: monorepodemo_prod_user
└── erp_postgres_stg   (postgres:18.6, 127.0.0.1:5433, red db_stg,  volumen postgres_pgdata_stg)
      ├── erp_stg               <- dueño: erp_stg_user
      └── monorepodemo_stg      <- dueño: monorepodemo_stg_user

/opt/monorepo-demo           -> API en redes app-network + db_prod
/opt/monorepo-demo-staging   -> API en redes app-network + db_stg
```

Decisiones de diseño:

* **Dos contenedores (prod y staging), no uno por aplicación.** Es lo más importante para aislar entornos y evita levantar muchos Postgres. Varias apps comparten el contenedor de su entorno, cada una con su base y su rol.
* **Credenciales distintas por entorno y por aplicación.** Si se filtra la clave de staging, no sirve para producción, y se evita ejecutar una migración contra la base equivocada.
* **Versión fija** (`postgres:18.6`), igual a la del entorno local. No uses `latest`. Antes de desplegar, verifica en Docker Hub la última versión 18.x. Cambiar de versión **mayor** requiere migrar los datos (14.15).
* **Redes Docker separadas** (`db_prod`, `db_stg`): la API de staging no puede ver el Postgres de producción.
* **Puertos solo en `127.0.0.1`.** Docker publica puertos saltándose las reglas de `ufw`; sin ese prefijo la base quedaría expuesta a internet.

### 14.2. Quién administra qué (usuarios)

Hay tres conceptos de "usuario" que no deben confundirse:

| Usuario | Tipo | Para qué sirve |
|---|---|---|
| `ubuntu` | Linux (VPS) | Administra el servidor, edita `/opt/postgres` y ejecuta `docker compose`. Nunca se usa `root` |
| `github-deploy` | Linux (VPS) | Lo usa el workflow por SSH para desplegar las **apps**. No tiene acceso a `/opt/postgres` |
| `dbadmin_prod`, `erp_prod_user`, ... | Roles de PostgreSQL | Autenticación y permisos dentro de la base de datos; no tienen relación con los usuarios de Linux |

Puntos clave:

* **"Tener control del contenedor"** no depende del usuario *dentro* del contenedor, sino de quién puede hablar con el **daemon de Docker** (`/var/run/docker.sock`): `root` y los miembros del grupo `docker`. Con `docker exec` entras al contenedor aunque no conozcas ninguna contraseña de la base.
* Pertenecer al grupo `docker` equivale en la práctica a tener acceso root al servidor. Es normal para `ubuntu` y para `github-deploy`, pero protege bien la llave SSH del workflow (exclusiva para ello y guardada solo en GitHub Secrets) y no añadas a ese grupo usuarios que no lo necesiten.
* `ubuntu` debe estar en el grupo `docker`:
  ```bash
  groups                              # debe aparecer "docker"
  docker ps                           # debe responder sin error
  sudo usermod -aG docker ubuntu      # solo si falla; luego cierra la sesión SSH y vuelve a entrar
  ```
  Si ves `permission denied while trying to connect to the Docker daemon socket`, es esto. Puedes confirmarlo con `ls -l /var/run/docker.sock` (debe ser `root:docker`). Como alternativa temporal sirve `sudo docker ...`, pero no mezcles ambos modos.
* **Carpeta `/opt/postgres`:** pertenece a `ubuntu`, con el `.env` en `chmod 600`. El workflow no la toca: despliega las apps, no el Postgres.

### 14.3. Estructura de archivos

```bash
sudo mkdir -p /opt/postgres/init
sudo chown -R $USER:$USER /opt/postgres    # $USER es "ubuntu"; la carpeta pasa a ser tuya
cd /opt/postgres
```

```
/opt/postgres/
├── docker-compose.yml     <- el único YAML
├── .env                   <- variables y claves (sin extensión; chmod 600; nunca a GitHub)
└── init/
    └── 01-init-dbs.sh     <- script de shell: crea roles y bases al primer arranque
```

Son **tres archivos**, solo uno es `.yml`. Puedes crearlos con `nano` (pega el contenido, guarda con `Ctrl+O` y `Enter`, sal con `Ctrl+X`; YAML no admite tabuladores) o con un heredoc:

```bash
cat > docker-compose.yml <<'EOF'
(contenido)
EOF
```

Las comillas simples en `'EOF'` evitan que la terminal sustituya los `$...` del contenido. Después:

```bash
chmod 600 .env
chmod +x init/01-init-dbs.sh
ls -la . init     # .env debe verse -rw-------, el script -rwxr-xr-x
```

### 14.4. Archivo `.env` de Postgres (`/opt/postgres/.env`)

```env
# PRODUCCIÓN
PROD_ADMIN_USER=dbadmin_prod
PROD_ADMIN_PASSWORD=clave_admin_prod

PROD_ERP_DB_NAME=erp_prod
PROD_ERP_DB_USER=erp_prod_user
PROD_ERP_DB_PASSWORD=clave_erp_prod

PROD_MONODEMO_DB_NAME=monorepodemo_prod
PROD_MONODEMO_DB_USER=monorepodemo_prod_user
PROD_MONODEMO_DB_PASSWORD=clave_monodemo_prod

# STAGING
STG_ADMIN_USER=dbadmin_stg
STG_ADMIN_PASSWORD=clave_admin_stg

STG_ERP_DB_NAME=erp_stg
STG_ERP_DB_USER=erp_stg_user
STG_ERP_DB_PASSWORD=clave_erp_stg

STG_MONODEMO_DB_NAME=monorepodemo_stg
STG_MONODEMO_DB_USER=monorepodemo_stg_user
STG_MONODEMO_DB_PASSWORD=clave_monodemo_stg
```

* Genera **cada clave distinta** con `openssl rand -hex 24` (solo letras y números: evita problemas en el `DATABASE_URL` y con las comillas del script).
* **El nombre del admin no puede empezar con `pg_`**: PostgreSQL reserva ese prefijo para sus roles internos y `initdb` rechaza el superusuario, dejando el contenedor en bucle de reinicios.
* El admin (`POSTGRES_USER`) se crea como **superusuario**. Se usa solo para administrar, nunca en las aplicaciones.

### 14.5. `docker-compose.yml` de Postgres

```yaml
name: postgres
services:
  postgres_prod:
    image: postgres:18.6
    container_name: erp_postgres_prod
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${PROD_ADMIN_USER}
      POSTGRES_PASSWORD: ${PROD_ADMIN_PASSWORD}
      ERP_DB_NAME: ${PROD_ERP_DB_NAME}
      ERP_DB_USER: ${PROD_ERP_DB_USER}
      ERP_DB_PASSWORD: ${PROD_ERP_DB_PASSWORD}
      MONODEMO_DB_NAME: ${PROD_MONODEMO_DB_NAME}
      MONODEMO_DB_USER: ${PROD_MONODEMO_DB_USER}
      MONODEMO_DB_PASSWORD: ${PROD_MONODEMO_DB_PASSWORD}
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - pgdata_prod:/var/lib/postgresql
      - ./init:/docker-entrypoint-initdb.d:ro
    networks:
      - db_prod

  postgres_stg:
    image: postgres:18.6
    container_name: erp_postgres_stg
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${STG_ADMIN_USER}
      POSTGRES_PASSWORD: ${STG_ADMIN_PASSWORD}
      ERP_DB_NAME: ${STG_ERP_DB_NAME}
      ERP_DB_USER: ${STG_ERP_DB_USER}
      ERP_DB_PASSWORD: ${STG_ERP_DB_PASSWORD}
      MONODEMO_DB_NAME: ${STG_MONODEMO_DB_NAME}
      MONODEMO_DB_USER: ${STG_MONODEMO_DB_USER}
      MONODEMO_DB_PASSWORD: ${STG_MONODEMO_DB_PASSWORD}
    ports:
      - "127.0.0.1:5433:5432"
    volumes:
      - pgdata_stg:/var/lib/postgresql
      - ./init:/docker-entrypoint-initdb.d:ro
    networks:
      - db_stg

networks:
  db_prod:
    name: db_prod
  db_stg:
    name: db_stg

volumes:
  pgdata_prod:
  pgdata_stg:
```

Notas:

* **`name: postgres`** (primera línea) fija el nombre del proyecto Compose. Si no lo pones, Compose usa el nombre de la carpeta; si algún día mueves o renombras `/opt/postgres`, se crearían volúmenes nuevos y vacíos con otro prefijo y parecería que perdiste los datos.
* Compose antepone el nombre del proyecto a volúmenes y redes: `pgdata_prod` existe realmente como `postgres_pgdata_prod`. `docker compose config` muestra esos nombres resueltos y es normal verlos aunque no los hayas escrito.
* En las imágenes de **Postgres 18** el punto de montaje del volumen es `/var/lib/postgresql` (en versiones anteriores era `/var/lib/postgresql/data`).
* La imagen oficial lee `POSTGRES_USER`, `POSTGRES_PASSWORD` y `POSTGRES_DB` **solo la primera vez**, con el volumen vacío. Cambiarlas después no tiene efecto.
* Los servicios publican solo en `127.0.0.1`; para acceder desde tu PC usa un túnel SSH (14.11).

### 14.6. Script de inicialización (`init/01-init-dbs.sh`)

La imagen solo crea un usuario y una base. Este script crea los roles y bases de **cada aplicación** y garantiza el aislamiento: la base tiene como dueño a su rol y se **quita el permiso `CONNECT` a `PUBLIC`** (por defecto, cualquier rol puede conectarse a cualquier base; este paso es el que más se olvida).

```bash
#!/bin/bash
set -e

create_app_db() {
  local db="$1" user="$2" pass="$3"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
    CREATE ROLE "$user" LOGIN PASSWORD '$pass';
    CREATE DATABASE "$db" OWNER "$user";
    REVOKE ALL ON DATABASE "$db" FROM PUBLIC;
    GRANT CONNECT ON DATABASE "$db" TO "$user";
EOSQL
}

create_app_db "$ERP_DB_NAME"      "$ERP_DB_USER"      "$ERP_DB_PASSWORD"
create_app_db "$MONODEMO_DB_NAME" "$MONODEMO_DB_USER" "$MONODEMO_DB_PASSWORD"
```

El script solo se ejecuta cuando el volumen está vacío (primera inicialización).

### 14.7. Levantar y verificar

`docker compose` busca el `docker-compose.yml` y el `.env` en el **directorio actual**; lo más simple es entrar a la carpeta:

```bash
cd /opt/postgres
docker compose config      # revisa que no haya variables vacías ni errores
docker compose up -d
docker compose ps          # ambos deben estar en "Up" (no "Restarting")
docker compose logs postgres_prod | tail -n 40
```

Desde otra carpeta puedes usar `docker compose --project-directory /opt/postgres up -d` o `-f /opt/postgres/docker-compose.yml --env-file /opt/postgres/.env` (sin `--env-file`, el `.env` podría no leerse).

En los logs de la primera inicialización deben aparecer:

* `sourcing /docker-entrypoint-initdb.d/01-init-dbs.sh`
* una serie `CREATE ROLE`, `CREATE DATABASE`, `REVOKE`, `GRANT` por cada aplicación
* al final, `database system is ready to accept connections`

La advertencia `initdb: warning: enabling "trust" authentication for local connections` es esperada (ver 14.9).

Verifica roles, bases y redes:

```bash
docker exec erp_postgres_prod psql -U dbadmin_prod -d postgres -c "\du"
docker exec erp_postgres_prod psql -U dbadmin_prod -d postgres -c "\l"
docker exec erp_postgres_stg  psql -U dbadmin_stg  -d postgres -c "\l"
docker network ls | grep db_
docker network inspect db_prod --format '{{range .Containers}}{{.Name}} {{end}}'
```

Prueba la conexión **como la hará la API** (por red, con contraseña) desde otro contenedor de la misma red:

```bash
docker run --rm --network db_prod postgres:18.6 \
  psql "postgresql://monorepodemo_prod_user:CLAVE@erp_postgres_prod:5432/monorepodemo_prod" \
  -c "SELECT current_user, version();"
```

Esa línea deja la clave en el historial de la shell; puedes borrarla con `history -d` o anteponer un espacio si tu shell lo soporta.

### 14.8. Probar el aislamiento

```bash
# Debe funcionar
docker exec erp_postgres_prod psql -U monorepodemo_prod_user -d monorepodemo_prod -c "SELECT current_user;"

# Debe fallar con "permission denied for database"
docker exec erp_postgres_prod psql -U monorepodemo_prod_user -d erp_prod -c "SELECT 1;"
```

El segundo falla aunque la conexión por socket local no pida clave, porque el permiso `CONNECT` se evalúa después de autenticarse.

### 14.9. Cómo funciona la autenticación

El rol de PostgreSQL sirve para dos cosas: **autenticarse** (demostrar quién eres) y **autorizarse** (qué puede hacer: leer, escribir, crear tablas, conectarse a qué bases).

| Tipo de conexión | Quién la usa | ¿Pide contraseña? |
|---|---|---|
| Socket Unix local, dentro del contenedor (`docker exec ... psql`) | Tú, administrando | **No** (`trust` en `pg_hba.conf` de la imagen oficial) |
| Red TCP (puerto `5432` interno, o `127.0.0.1:5432`/`5433` en el host) | La API de la app, túneles SSH | **Sí** (`scram-sha-256`) |

Por eso `docker exec` no pide clave: quien ya controla el daemon de Docker se considera de confianza. Para ver las reglas: `docker exec erp_postgres_prod psql -U dbadmin_prod -d postgres -c "SHOW hba_file;"` y luego `cat` de ese archivo.

### 14.10. Conectar la API (Prisma)

El `DATABASE_URL` de cada app va en su `.env` del VPS (no en GitHub Secrets; ver 6.2):

```
postgresql://monorepodemo_prod_user:CLAVE@erp_postgres_prod:5432/monorepodemo_prod?schema=public
```

* **Host:** el `container_name` del Postgres (`erp_postgres_prod` / `erp_postgres_stg`). Docker lo resuelve porque la API está en la misma red (`db_prod` / `db_stg`).
* **Puerto:** siempre `5432` (el interno). El `5433` solo aplica desde el host.
* **Si se cambia el `container_name`** de Postgres, hay que actualizar los `DATABASE_URL`.
* **Quién crea las tablas:** Postgres solo crea la base vacía. Las tablas las crean las migraciones de Prisma, que se ejecutan con `npx prisma migrate deploy` al arrancar la API (sección 8). El rol de la app es dueño de su base, por lo que no necesita permisos adicionales.
* **Nunca** uses `prisma migrate dev` ni `db push` en el VPS: pueden pedir resetear la base. `migrate dev` es solo para local (necesita crear una *shadow database*; en tu Postgres local el usuario es superusuario y puede).
* **`DATABASE_URL` en GitHub Secrets:** solo haría falta si el runner de GitHub necesitara la URL (por ejemplo, para escribir el `.env` en cada despliegue). Con Postgres cerrado a `127.0.0.1` y el `.env` creado a mano en el VPS, la clave de producción no sale del servidor, y en GitHub solo quedan los secretos SSH.

### 14.11. Acceso desde tu PC (túnel SSH)

Como Postgres no está expuesto a internet, usa un túnel:

```bash
ssh -L 5434:localhost:5432 ubuntu@IP_DEL_VPS     # producción
ssh -L 5435:localhost:5433 ubuntu@IP_DEL_VPS     # staging
```

Mientras la sesión esté abierta, conéctate desde tu PC a `localhost:5434` (o `5435`) con tu cliente SQL favorito y el rol de la app. Elige puertos locales libres (el `5434` puede estar en uso por tu Postgres de desarrollo; ver 14.16).

### 14.12. Operación diaria: comandos útiles

```bash
# Versión del servidor
docker exec erp_postgres_prod postgres --version
docker exec erp_postgres_prod psql -U dbadmin_prod -d postgres -c "SELECT version();"

# Sesión interactiva (necesita -it); sal con \q
docker exec -it erp_postgres_prod psql -U erp_prod_user -d erp_prod

# Explorar
docker exec erp_postgres_prod psql -U erp_prod_user -d erp_prod -c "\dt"
docker exec erp_postgres_prod psql -U erp_prod_user -d erp_prod -c "\d nombre_tabla"
docker exec erp_postgres_prod psql -U erp_prod_user -d erp_prod -c "SELECT * FROM nombre_tabla LIMIT 10;"
docker exec erp_postgres_prod psql -U erp_prod_user -d erp_prod -x -c "SELECT * FROM nombre_tabla LIMIT 3;"   # salida expandida
```

Recomendaciones:

* **Indica siempre la base con `-d`.** Sin ella, `psql` busca una base con el mismo nombre que el usuario y falla con `FATAL: database "erp_prod_user" does not exist`; la conexión al servidor sí funcionó.
* En `-c "..."`, usa comillas dobles para el SQL y simples para los valores de texto.
* Si la tabla se creó con mayúsculas entre comillas, escríbela igual (`"Clientes"`); si no está en `public`, indica el esquema (`esquema.tabla`).
* Los logs de Postgres: `cd /opt/postgres && docker compose logs -f postgres_prod`.
* Revisar variables del contenedor: `docker inspect ... | grep POSTGRES` **muestra las contraseñas**; no pegues esa salida en lugares públicos.

### 14.13. Agregar una aplicación nueva o rehacer desde cero

El script de init **solo corre con el volumen vacío**.

* **Agregar una app a un Postgres que ya tiene datos:** ejecuta el SQL a mano como admin (y, si quieres, agrega la llamada a `create_app_db` en el script y las variables en el `.env` para futuras recreaciones):
  ```bash
  docker exec -it erp_postgres_prod psql -U dbadmin_prod -d postgres
  ```
  ```sql
  CREATE ROLE "app_user" LOGIN PASSWORD 'clave';
  CREATE DATABASE "app_db" OWNER "app_user";
  REVOKE ALL ON DATABASE "app_db" FROM PUBLIC;
  GRANT CONNECT ON DATABASE "app_db" TO "app_user";
  ```
* **Rehacer todo (solo si no hay datos reales):** `docker compose down -v` borra los volúmenes y `docker compose up -d` vuelve a ejecutar el init. **`-v` destruye los datos.**
* **Aplicar cambios del compose** (por ejemplo, nuevas redes): `docker compose up -d` recrea los contenedores, pero los datos se conservan porque están en el volumen.

### 14.14. Backups

El volumen de Docker **no es un respaldo**. Haz un `pg_dump` por base para poder restaurar cada app por separado:

```bash
docker exec erp_postgres_prod pg_dump -U dbadmin_prod -d monorepodemo_prod | gzip > monorepodemo_prod_$(date +%F).sql.gz
```

Ejemplo de script programado (`/opt/postgres/backup.sh`, con `chmod +x`):

```bash
#!/bin/bash
set -e
DEST=/opt/backups/postgres
mkdir -p "$DEST"
STAMP=$(date +%F_%H%M)
docker exec erp_postgres_prod pg_dump -U dbadmin_prod -d monorepodemo_prod | gzip > "$DEST/monorepodemo_prod_$STAMP.sql.gz"
docker exec erp_postgres_prod pg_dump -U dbadmin_prod -d erp_prod          | gzip > "$DEST/erp_prod_$STAMP.sql.gz"
find "$DEST" -name '*.sql.gz' -mtime +14 -delete
```

```bash
crontab -e
# 0 3 * * * /opt/postgres/backup.sh
```

Copia esos archivos **fuera del VPS** (almacenamiento externo). Para restaurar en una base existente:

```bash
gunzip -c monorepodemo_prod_FECHA.sql.gz | docker exec -i erp_postgres_prod psql -U dbadmin_prod -d monorepodemo_prod
```

Prueba la restauración en staging antes de necesitarla de verdad.

### 14.15. Actualizar la versión de PostgreSQL

* **Versión menor (18.6 -> 18.x):** cambia el tag en el compose, luego `docker compose pull && docker compose up -d`. Haz un backup antes.
* **Versión mayor (18 -> 19):** los datos no son compatibles entre versiones mayores. El procedimiento es: backup con `pg_dump`, levantar un contenedor nuevo con la versión nueva y un volumen nuevo, restaurar, y validar en staging antes de producción.
* Mantén local, staging y producción en la **misma versión mayor** para que se comporten igual.

### 14.16. Desarrollo local: Postgres en Docker Desktop (WSL)

En tu PC, Postgres puede correr en Docker Desktop con integración WSL (*Settings -> Resources -> WSL Integration*, activada para tu distribución). Ejemplo de contenedor local: `erp_postgres`, imagen `postgres:18.6`, puerto `5434:5432`.

```bash
docker exec erp_postgres postgres --version
docker exec erp_postgres psql -U erp_dev_user -d testdb -c "SELECT version();"
docker exec erp_postgres psql -U erp_dev_user -d testdb -c "SELECT * FROM ejemplo LIMIT 10;"
docker exec -it erp_postgres psql -U erp_dev_user -d testdb      # sesión interactiva
```

Desde WSL, por el puerto mapeado y con contraseña (necesita `psql`: `sudo apt install postgresql-client`):

```bash
psql -h localhost -p 5434 -U erp_dev_user -d testdb -c "SELECT version();"
```

* `SELECT version();` siempre devuelve la versión del **servidor**; `psql --version` devuelve la del cliente, que puede ser distinta.
* En local no hay aislamiento por roles: el usuario definido en `POSTGRES_USER` es superusuario, lo que permite a `prisma migrate dev` crear su *shadow database*.
* Si `docker` no se reconoce en WSL, revisa la integración WSL en Docker Desktop.
* Si el puerto `5434` local choca con un túnel SSH (14.11), usa otro puerto local para el túnel.

### 14.17. Problemas frecuentes de Postgres en contenedores

| Síntoma | Causa | Solución |
|---|---|---|
| `permission denied ... /var/run/docker.sock` | `ubuntu` no está en el grupo `docker` | `sudo usermod -aG docker ubuntu` y reconectar (14.2) |
| Contenedores en `Restarting` con `superuser name "pg_admin_prod" is disallowed` | Nombre de admin con prefijo reservado `pg_` | Cambiarlo (`dbadmin_prod`), `docker compose down -v` y `up -d` |
| No se crearon los roles ni las bases | El script solo corre con el volumen vacío, o falló una variable | Ver `docker compose logs`; si no hay datos, `docker compose down -v` y `up -d` (14.13) |
| Variables vacías en `docker compose config` | `.env` ausente o no leído desde ese directorio | Ejecutar desde `/opt/postgres` o usar `--env-file` |
| `FATAL: database "usuario" does not exist` | Falta `-d` en `psql` | Agregar `-d nombre_base` |
| `permission denied for database` | El rol no es dueño de esa base (aislamiento correcto) | Usar el rol y la base de la app |
| `network db_prod declared as external, but could not be found` | Postgres no está levantado | `cd /opt/postgres && docker compose up -d` |
| La API no resuelve `erp_postgres_prod` | API fuera de la red `db_prod`, o nombre de contenedor distinto | Revisar `networks` del compose de la app y el host del `DATABASE_URL` |
| Autenticación fallida desde la API | Clave distinta a la de `/opt/postgres/.env`, o caracteres especiales | Usar la misma clave; generar claves alfanuméricas |
| Los datos "desaparecieron" tras mover la carpeta | Cambió el nombre del proyecto Compose y se crearon volúmenes nuevos | Fijar `name: postgres`; los datos viejos siguen en el volumen anterior (`docker volume ls`) |
