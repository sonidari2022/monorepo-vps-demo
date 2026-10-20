# Guía de Aprendizaje: Arquitectura CI/CD, Contenerización y Despliegue de Monorepo (v2)

Este documento explica el **porqué** de cada decisión técnica del proyecto ERP: contenedores, pipeline, seguridad, variables y flujo de trabajo. Está pensado como material de estudio y consulta.

> **Relación con el Manual de Operaciones (v2):** el manual es la *receta* (comandos y pasos en orden). Esta guía es el *razonamiento*. En cada sección encontrarás una referencia del tipo **Manual §X** para ir a los pasos exactos.

## Índice

1. Visión general: cómo encajan las piezas
2. Conceptos de infraestructura y Linux
3. Contenerización con Docker (multi-stage builds)
4. Servidor web interno para la SPA (Nginx del contenedor)
5. Variables: build, ejecución y secretos
6. Autenticación: llaves SSH y tokens
7. Automatización CI/CD con GitHub Actions
8. Orquestación con Docker Compose en el VPS
9. Base de datos y migraciones con Prisma
10. Gestión de versiones: pnpm y Node
11. Flujo de trabajo: staging, producción y protección de `main`
12. Optimización de builds (opcional)
13. Diagnóstico de errores típicos
14. Cuestionario de repaso

---

## 1. Visión General: Cómo Encajan las Piezas

### El recorrido de una petición

```text
Navegador del usuario
        │  HTTPS (certificado público de Cloudflare)
        ▼
   Cloudflare  ── DNS, WAF, Edge SSL
        │  HTTPS (certificado de origen, modo Full Strict)
        ▼
   VPS (OVHcloud) ── UFW: solo puertos 22, 80, 443
        │
        ▼
   Nginx del VPS (reverse proxy)
        │  HTTP hacia 127.0.0.1 (solo local)
        ├──► :3091  contenedor API (NestJS)  ──► PostgreSQL
        └──► :3092  contenedor Web (Nginx + archivos estáticos)
```

Hay **dos Nginx distintos**, y conviene no confundirlos:

| | Nginx del VPS | Nginx del contenedor web |
|---|---|---|
| Dónde vive | En el sistema operativo del VPS | Dentro de la imagen `nginx:alpine` |
| Rol | *Reverse proxy*: recibe HTTPS y reparte hacia los puertos locales | Servidor de archivos estáticos de la SPA |
| Archivo | `/etc/nginx/sites-available/erp.conf` | `apps/web/nginx.conf` |

### El recorrido del código

```text
Tu WSL ──git push──► GitHub ──Actions──► construye imágenes ──► ghcr.io
                                                                   │
                         VPS ◄──SSH: docker compose pull/up────────┘
```

**Idea central:** el código fuente nunca se compila ni se instala en el VPS. GitHub construye las imágenes; el VPS solo las descarga y las ejecuta.

*Manual §2, §3 y §7.*

---

## 2. Conceptos de Infraestructura y Linux

### El directorio `/opt` en Linux

El Estándar de Jerarquía del Sistema de Archivos (FHS) reserva `/opt` (*Optional Software Packages*) para aplicaciones de terceros que no forman parte del sistema operativo base.

* **¿El monorepo está en el VPS?** **No.** El código fuente nunca reside en el servidor. Allí solo hay archivos de orquestación: el `docker-compose` y el `.env`.
* **Aislamiento de entornos:** producción y staging comparten máquina, así que cada uno tiene su propio directorio para evitar colisiones.

```text
/opt/
├── monorepo-demo/                  # Producción (rama main)
│   ├── docker-compose.vps.yml      # se sincroniza desde el repositorio (SCP)
│   └── .env                        # se crea a mano, nunca viaja por GitHub
└── monorepo-demo-staging/          # Staging (rama staging)
    ├── docker-compose.staging.yml
    └── .env
```

### Principio de menor privilegio

Los despliegues automáticos no usan `root`. Se crea el usuario `github-deploy`, que solo puede operar Docker y escribir en sus dos carpetas. Si su llave se filtrara, el daño estaría acotado. Por la misma razón, `github-deploy` **no** tiene `sudo`.

### Puertos y exposición

Los contenedores publican sus puertos como `127.0.0.1:PUERTO:...`. Al anteponer `127.0.0.1`, el puerto solo es accesible desde el propio servidor, es decir, desde el Nginx del VPS. Además, el firewall (UFW) solo abre 22, 80 y 443. Son dos capas de protección: aunque se olvidara una, la otra sigue protegiendo.

| Entorno | API (host) | Web (host) |
|---|---|---|
| Producción | 3091 | 3092 |
| Staging | 3093 | 3094 |

*Manual §3.2, §3.5 y §3.6.*

---

## 3. Contenerización con Docker (Multi-stage Builds)

La técnica **multi-stage build** usa una etapa inicial pesada para compilar y una etapa final reducida para ejecutar.

### 3.1. API (NestJS + Prisma + Node.js)

Archivo: `apps/api/Dockerfile`

| Etapa | Imagen base | Responsabilidad |
| :--- | :--- | :--- |
| **`base`** | `node:24-alpine` | Activa `pnpm` mediante Corepack. |
| **`builder`** | Herencia de `base` | Instala dependencias, compila TypeScript (`pnpm --filter api build`) y aísla la API con `pnpm deploy --filter=api --prod /app/out`. |
| **`runner`** | `node:24-alpine` | Copia solo `dist`, `node_modules` de producción, `package.json` y los esquemas de Prisma. Arranca con `pnpm run start:prod`. |

> **Lección clave:** la imagen final no incluye código `.ts` ni `devDependencies`. Es más pequeña y expone menos superficie de ataque.

### 3.2. Web (React + Vite + Nginx)

Archivo: `apps/web/Dockerfile`

| Etapa | Imagen base | Responsabilidad |
| :--- | :--- | :--- |
| **`base`** | `node:24-alpine` | Prepara Node y `pnpm` (`corepack enable`). |
| **`builder`** | Herencia de `base` | Recibe `ARG VITE_API_URL`, instala dependencias y genera los archivos estáticos (`pnpm --filter web build`). |
| **`runner`** | `nginx:alpine` | **Descarta Node.js.** Copia los estáticos a `/usr/share/nginx/html` y aplica el `nginx.conf`. |

> **Lección clave:** una SPA compilada no necesita Node en ejecución, solo un servidor de archivos estáticos rápido.

### 3.3. Piezas auxiliares

* **`.dockerignore`:** evita que `.git`, `node_modules` locales y archivos `.env` entren al contexto de build. Sin él, `COPY . .` los envía todos, lo que ralentiza el build y puede mezclar módulos.
* **`LABEL org.opencontainers.image.source`:** vincula la imagen al repositorio en ghcr.io. Es lo que permite que `GITHUB_TOKEN` pueda descargarla (ver sección 13).

*Manual §5.1 y §5.2.*

---

## 4. Servidor Web Interno para la SPA (Nginx del Contenedor)

Archivo: `apps/web/nginx.conf`

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

### La directiva `try_files`

En una *Single Page Application*, rutas como `/usuarios` o `/inventario` las gestiona **React Router en el navegador**; no existen como carpetas en el servidor.

1. **`$uri`:** Nginx busca un archivo físico (por ejemplo `/logo.png`).
2. **`$uri/`:** busca un directorio.
3. **`/index.html`:** si no existe ninguno, devuelve `index.html`, y React toma el control de la vista **sin provocar un 404**.

Sin esta línea, recargar la página en `/usuarios` daría error 404.

### Versión con caché (mejora opcional)

```nginx
location /assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
    try_files $uri =404;
}
location / {
    add_header Cache-Control "no-cache";
    try_files $uri $uri/ /index.html;
}
```

**Por qué dos políticas distintas:**

* Vite genera archivos con *hash* en el nombre (`index-a1b2c3.js`). Si el contenido cambia, cambia el nombre, así que pueden cachearse un año sin riesgo.
* `index.html` mantiene siempre el mismo nombre y apunta a esos archivos. Si el navegador lo guardara en caché, tras un despliegue seguiría apuntando a archivos antiguos que ya no existen: **pantalla en blanco**.

*Manual §5.3.*

---

## 5. Variables: Build, Ejecución y Secretos

Esta es la fuente de confusión más frecuente del proyecto. La pregunta clave es: **¿cuándo se lee el valor?**

### 5.1. Variables de build frente a variables de ejecución

| | Variables de **build** | Variables de **ejecución** |
|---|---|---|
| Ejemplo | `VITE_API_URL` | `DATABASE_URL`, `PORT` |
| Cuándo se leen | Al **compilar** la imagen (en GitHub Actions) | Al **arrancar** el contenedor (en el VPS) |
| Dónde se definen | `build-args` del workflow + `ARG` en el Dockerfile | `environment` del compose + `.env` del VPS |
| Para cambiarlas | Hay que **reconstruir** la imagen (nuevo despliegue) | Basta reiniciar el contenedor |
| ¿Son secretas? | **No**: acaban dentro del JavaScript público | Sí, normalmente |

**Por qué `VITE_API_URL` es de build:** Vite sustituye `import.meta.env.VITE_API_URL` por el texto literal de la URL durante la compilación. El resultado son archivos estáticos con la URL ya escrita. Por eso definirla en `environment:` del compose **no hace nada**: la imagen ya está construida.

### 5.2. Secrets frente a Variables en GitHub

| | **Secrets** | **Variables** |
|---|---|---|
| Visibilidad | Cifrados; se ocultan en los logs | Texto plano, visibles |
| Uso | Credenciales (`VPS_SSH_KEY`, `VPS_HOST`, `VPS_USER`) | Valores no sensibles (`API_URL_PROD`, `API_URL_STAGING`) |
| Se leen con | `${{ secrets.NOMBRE }}` | `${{ vars.NOMBRE }}` |

Regla de oro: **nunca se escribe una credencial dentro del workflow**; solo se referencian.

*Secretos de repositorio frente a de entorno:* los secretos de repositorio sirven a todos los workflows. Los de entorno (*Environments*) solo están disponibles para jobs que declaran `environment:`, y permiten, por ejemplo, exigir aprobación manual antes de producción.

### 5.3. Valores que GitHub genera solo

| Valor | Contiene | ¿Lo creas tú? |
|---|---|---|
| `github.actor` | Usuario que provocó la ejecución | No, es automático |
| `github.repository_owner` | Dueño del repositorio | No, es automático |
| `env.OWNER` | El dueño en minúsculas (lo define un paso del propio workflow) | No, lo crea el workflow |
| `secrets.GITHUB_TOKEN` | Token temporal por ejecución, destruido al terminar | No; GitHub no permite secretos con nombre `GITHUB_*` |

### 5.4. El archivo `.env` del VPS

Compose resuelve `${VARIABLE}` en este orden: (1) variables de la shell, (2) el archivo **`.env` junto al compose**, (3) valores por defecto (`${VAR:-valor}`).

* El `.env` se crea **una vez, a mano**, en el VPS. No viaja desde el repositorio, y por eso los secretos nunca pasan por GitHub.
* Se protege con `chmod 600` y se excluye con `.gitignore`.
* `${VAR:?mensaje}` hace que Compose falle con un mensaje claro si falta la variable, en lugar de un error confuso más adelante.

*Manual §4.1, §4.2, §4.3, §5.1 y §6.*

---

## 6. Autenticación: Llaves SSH y Tokens

### 6.1. Cómo funciona un par de llaves SSH

* **Llave privada:** la tiene quien *se conecta* (GitHub Actions, como secreto `VPS_SSH_KEY`).
* **Llave pública:** la tiene quien *recibe* la conexión (el VPS, en `~/.ssh/authorized_keys` de `github-deploy`).

Quien posee la privada puede demostrar que es el dueño de la pública sin revelarla. La pública, por sí sola, no permite entrar.

### 6.2. Por qué la llave se genera en WSL y no en el servidor

1. **La privada nunca toca el servidor.** Si el VPS se compromete, el atacante no obtiene una credencial de acceso.
2. Es cómodo: la privada debe acabar en GitHub y desde WSL se copia con `cat`.
3. Es la práctica estándar: se genera en una máquina de confianza y al servidor solo se envía la pública.

### 6.3. Detalles que conviene entender

* **Contraseña en blanco:** GitHub Actions no puede escribirla en un proceso automático.
* **El *fingerprint*** que muestra `ssh-keygen` es solo una huella de identificación; no se usa en ningún paso.
* **"The authenticity of host can't be established":** SSH no conoce todavía el servidor. Es un aviso normal de la primera conexión; se responde `yes` y el servidor queda guardado en `known_hosts`.
* **El orden de instalación importa:** `usermod -aG docker` falla si Docker aún no está instalado, porque el grupo `docker` lo crea esa instalación.
* **Reutilización:** una llave puede servir para producción y staging en el mismo VPS. Para otro servidor (AWS) conviene una distinta: limita el daño de una filtración y permite rotarla por separado.

### 6.4. Autenticarse en ghcr.io: `GITHUB_TOKEN` frente a PAT

El VPS necesita descargar imágenes privadas de ghcr.io.

| | **`GITHUB_TOKEN`** (recomendado) | **`GHCR_PAT`** |
|---|---|---|
| Origen | Lo genera GitHub en cada ejecución | Lo creas tú manualmente |
| Duración | Hasta que termina el workflow | Hasta su expiración (o indefinida) |
| Mantenimiento | Ninguno | Renovación periódica |
| Si se filtra | Casi inútil: ya caducó | Válido hasta que se revoque |
| Permisos | Los del bloque `permissions:` del job | Los *scopes* elegidos (`read:packages`) |

**Por qué `read:packages` basta para el PAT:** el VPS solo *descarga*. Quien *sube* las imágenes es el workflow, con su propio token.

**Mejores prácticas al iniciar sesión en el VPS:**

* `--password-stdin` evita que el token quede como argumento del comando (y en el historial).
* `docker logout` al final no deja credenciales guardadas en `~/.docker/config.json`.

**Cuándo sí usar un PAT:** para un `docker pull` manual en el VPS, o si el paquete pertenece a otra cuenta u organización. En ese caso, con expiración corta.

*Manual §3.3 y §4.4.*

---

## 7. Automatización CI/CD con GitHub Actions

Archivos: `.github/workflows/deploy-staging.yml` y `.github/workflows/deploy-prod.yml`

El pipeline se divide en dos **jobs** secuenciales.

### Job 1: Compilación en la nube (`build-and-push`)

1. **`actions/checkout@v4`:** copia el código a la máquina virtual temporal de GitHub.
2. **`docker/login-action@v3`:** autentica en ghcr.io con `GITHUB_TOKEN`.
3. **Normalización a minúsculas:** ghcr.io exige nombres en minúsculas.
   ```bash
   echo "OWNER=$(echo "${{ github.repository_owner }}" | tr '[:upper:]' '[:lower:]')" >> $GITHUB_ENV
   ```
4. **`docker/setup-buildx-action@v3`:** prepara el motor de construcción.
5. **`docker/build-push-action@v5`:** construye las imágenes de API y Web y las sube con la etiqueta del entorno (`:staging` o `:latest`). La Web recibe `VITE_API_URL` por `build-args`.

Permisos: `packages: write` (para subir imágenes).

### Job 2: Despliegue por SSH (`deploy-to-vps`)

Se ejecuta solo si el job anterior terminó bien (`needs:`). Permisos: `packages: read`.

1. **Sincronización del compose (Forma 1):** `checkout` + `appleboy/scp-action` copian el `docker-compose` del repositorio al VPS. El repositorio es la fuente de verdad, y así el servidor y el código no se desincronizan. *Forma 2:* mantenerlo a mano en el VPS; es válido, pero hay que acordarse de copiarlo en cada cambio.
2. **Despliegue (`appleboy/ssh-action`):**
   ```bash
   cd /opt/monorepo-demo-staging
   echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
   docker compose -f docker-compose.staging.yml pull
   docker compose -f docker-compose.staging.yml up -d --remove-orphans
   docker image prune -f
   docker logout ghcr.io
   ```

### Qué hace cada comando

* **`pull`:** descarga las imágenes que GitHub acaba de construir.
* **`up -d`:** crea o reemplaza los contenedores cuya imagen cambió, en segundo plano.
* **`--remove-orphans`:** elimina contenedores que ya no están definidos en el compose.
* **`image prune -f`:** borra capas antiguas sin usar y libera disco.

### Dos decisiones independientes en el workflow

| | Opción B (`GITHUB_TOKEN`) | Opción A (`GHCR_PAT`) |
|---|---|---|
| **Forma 1** (SCP) | Recomendada | Válida |
| **Forma 2** (manual) | Válida | Válida |

*Manual §7.*

---

## 8. Orquestación con Docker Compose en el VPS

Archivo: `docker-compose.staging.yml`

```yaml
services:
  api:
    image: ghcr.io/${GITHUB_OWNER:?Falta GITHUB_OWNER en .env}/my-monorepo-api:staging
    container_name: monorepo_api_staging
    restart: always
    ports:
      - "127.0.0.1:3093:3091"   # el contenedor escucha en 3091; el host expone 3093
    environment:
      - PORT=3091
      - NODE_ENV=production
      - DATABASE_URL=${DATABASE_URL:?Falta DATABASE_URL en .env}
    networks:
      - app-network

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
```

### Cómo leer un mapeo de puertos

```text
"127.0.0.1:3093:3091"
   │         │    └── puerto DENTRO del contenedor
   │         └─────── puerto en el HOST (el VPS)
   └───────────────── solo accesible desde el propio servidor
```

### Medidas de seguridad y buenas prácticas

1. **Conexión local estricta (`127.0.0.1`):** nada queda expuesto directamente a internet; todo pasa por el Nginx del VPS y Cloudflare.
2. **Aislamiento de nombres:** `container_name` distinto por entorno (`_staging`). Si dos entornos usaran el mismo nombre, Docker no podría arrancar ambos en la misma máquina.
3. **Consistencia de etiquetas:** `:staging` en el pipeline y en el compose; `:latest` en producción.
4. **Sin `VITE_API_URL` en `environment`:** es una variable de build (ver sección 5).
5. **Sin `version:`:** está obsoleto en Compose v2 y solo genera una advertencia.
6. **`restart: always`:** los contenedores se recuperan tras un reinicio del VPS, aunque el token de ghcr.io ya haya caducado, porque las imágenes ya están descargadas localmente.
7. **Mantenimiento automatizado:** `docker image prune -f` libera disco tras cada despliegue.

*Manual §5.4.*

---

## 9. Base de Datos y Migraciones con Prisma

### Qué crea Prisma y qué no

| Lo crea Prisma | Lo creas tú, a mano |
|---|---|
| Tablas, columnas, índices | La **base de datos** y el **usuario** de PostgreSQL |

### `migrate dev` frente a `migrate deploy`

| | `prisma migrate dev` | `prisma migrate deploy` |
|---|---|---|
| Dónde se usa | Desarrollo local (WSL) | Staging y producción |
| Qué hace | Compara el esquema, **genera** el archivo de migración SQL y lo aplica | Solo **aplica** las migraciones ya existentes en el repositorio |
| Riesgo | Puede resetear datos de desarrollo | Seguro: nunca genera ni borra |

**El ciclo completo de un cambio de esquema:**

1. Editas `schema.prisma` en WSL.
2. `pnpm prisma:migrate --name add_columna_otros` genera la migración SQL (el script ya incluye `migrate dev`; si se repitiera `dev`, el comando fallaría).
3. Haces commit de la **carpeta de migraciones** junto con el código.
4. Al arrancar el contenedor de la API en staging o producción, `migrate deploy` detecta la migración nueva y la aplica.

> Verifica que tu comando de arranque (`start:prod` o el `CMD` del contenedor) ejecute `npx prisma migrate deploy` antes de iniciar el servidor; de ahí depende que las migraciones se apliquen solas.

### Una base por entorno

Staging debe tener su **propia** base y usuario (`erp_staging`). Así, una migración de prueba o un dato corrupto nunca toca producción.

### `DATABASE_URL`

```text
postgresql://USUARIO:CLAVE@HOST:5432/BASE?schema=public
```

Puntos de atención:

* Los caracteres especiales en la clave (`@`, `:`, `/`, `#`, `%`) deben codificarse.
* Dentro de un contenedor, `localhost` es el **propio contenedor**, no el VPS. Para llegar a un Postgres del servidor se usa `host.docker.internal` con `extra_hosts`.
* En el `.env`, un `$` dentro de la clave se escribe `$$`.

*Manual §6.3, §6.4 y §9.*

---

## 10. Gestión de Versiones: pnpm y Node

### Una sola fuente de verdad

La versión de pnpm se declara **solo** en `packageManager` del `package.json` raíz:

```json
"packageManager": "pnpm@12.8.0"
```

`corepack enable` hace que pnpm respete ese campo en cualquier lugar: tu WSL, el Dockerfile y cualquier otro clon.

### Por qué evitar `pnpm@latest`

* El build dejaría de ser reproducible: un despliegue que funcionó ayer puede fallar hoy, sin cambios en tu código, porque salió una versión nueva.
* `pnpm install --frozen-lockfile` falla si el formato del lockfile no coincide con la versión que lo lee.
* Si el Dockerfile activa `latest` y el `package.json` fija otra versión, el build depende de cuál gane.

### Qué hace `--frozen-lockfile`

Instala **exactamente** lo que dice `pnpm-lock.yaml`, sin resolver versiones nuevas, y falla si el lockfile no coincide con los `package.json`. Garantiza que lo probado en staging es lo mismo que llega a producción.

### Cómo actualizar pnpm o una dependencia

1. Cambiar la versión (`packageManager` o el `package.json` correspondiente).
2. Ejecutar `pnpm install` en WSL para regenerar el lockfile.
3. Hacer commit de **ambos archivos**.
4. Probar en staging antes de producción.

Las dependencias nunca se instalan en el VPS: `pnpm install` ocurre durante el build de Docker, con paquetes del registro público de npm.

### Nota sobre Node

`corepack` viene incluido en Node 24. En Node 25 o superior ya no se incluye y debería instalarse aparte.

*Manual §5.5.*

---

## 11. Flujo de Trabajo: Staging, Producción y Protección de `main`

### Ramas y entornos

| Rama | Entorno | Imagen | Dominios |
|---|---|---|---|
| `staging` | Pruebas | `:staging` | `*-exa-staging` |
| `main` | Producción | `:latest` | `*-exa` |

### El camino de un cambio

```text
WSL (desarrollo) ──push──► staging ──(pruebas OK)──► PR ──merge──► main ──► producción
```

```bash
git push origin staging
gh pr create --base main --head staging --fill && gh pr merge --merge
```

### Por qué proteger `main`

Un `git push origin main` por costumbre despliega directamente a producción sin pasar por staging. Hay dos barreras posibles:

| | Hook local (gratis) | Protección de rama (de pago o repositorio público) |
|---|---|---|
| Dónde actúa | En tu máquina | En el servidor de GitHub |
| ¿Se puede saltar? | Sí (`--no-verify`) | No, con "Do not allow bypassing" |
| Alcance | Solo el repositorio donde se instala | El repositorio configurado |

**Conceptos importantes:**

* El hook `pre-push` revisa la rama **destino** del push, no la rama en la que estás.
* `git config core.hooksPath .githooks` (sin `--global`) solo afecta al repositorio actual.
* Como administrador, la regla de GitHub **no te aplica** salvo que actives "Do not allow bypassing the above settings".
* No actives "Require approvals" si trabajas solo: no puedes aprobar tu propio PR.
* Ninguna de las dos verifica que *hayas probado* en staging; solo evitan el atajo accidental.

*Manual §4.6 y §9.*

---

## 12. Optimización de Builds (Opcional)

Ninguna de estas mejoras es necesaria. Se justifican si los builds se vuelven lentos.

### 12.1. Caché de capas de Docker

```yaml
cache-from: type=gha,scope=web-prod
cache-to: type=gha,mode=max,scope=web-prod
```

* **Problema que resuelve:** cada ejecución de Actions arranca en una máquina vacía y reconstruye todo.
* **Cómo funciona:** guarda las capas en la caché de GitHub y las reutiliza si no cambiaron. `mode=max` incluye capas intermedias; `scope` separa las cachés de cada imagen.
* **Limitación:** con `COPY . .` antes de `pnpm install`, cualquier cambio de código invalida el `install`, y el ahorro es pequeño.

### 12.2. Copiar primero los manifiestos

Copiar `package.json` y `pnpm-lock.yaml` **antes** del resto del código permite reutilizar la capa del `install` mientras las dependencias no cambien. Es lo que hace efectiva la caché.

### 12.3. Instalación selectiva con `--filter web...`

Instala solo lo que `web` necesita. Los **tres puntos** significan "web y todo aquello de lo que depende". Riesgos: dependencias declaradas solo en la raíz, paquetes internos que requieren compilarse antes, código importado desde api o scripts `postinstall`. Se prueba primero en local y luego en staging.

*Manual §10.*

---

## 13. Diagnóstico de Errores Típicos

La clave es ubicar **en qué paso** ocurre el fallo.

| Síntoma | Qué significa | Dónde buscar |
|---|---|---|
| `denied` al hacer **push** | El job de build no tiene permiso de escritura | `permissions: packages: write` |
| `denied` al hacer **pull** en el VPS | El token no puede ver el paquete | *Manage Actions access* y la etiqueta `LABEL ...image.source` |
| `unauthorized` con `GHCR_PAT` | El PAT venció o no tiene `read:packages` | Regenerar el token y actualizar el secreto |
| `ghcr.io//my-monorepo-api` | `GITHUB_OWNER` vacío | Falta el `.env` junto al compose |
| El frontend llama a una API equivocada | `VITE_API_URL` no llegó al build | `build-args`, variable `API_URL_*` y reconstruir |
| 404 al recargar `/usuarios` | Falta el fallback a `index.html` | `try_files` en el `nginx.conf` |
| Pantalla en blanco tras desplegar | `index.html` cacheado con archivos viejos | `no-cache` en `index.html` |
| SSH pide contraseña | La llave no se está usando | Ubicación y permisos de `authorized_keys` |
| `group 'docker' does not exist` | Docker no estaba instalado | Instalarlo antes de `usermod` |
| `container name already in use` | Dos entornos con el mismo `container_name` | Sufijar los nombres |
| Error de lockfile en el build | Versiones de pnpm distintas | `packageManager` y `corepack enable` |

**Método general:** (1) identifica el job y el paso que falló en la pestaña Actions; (2) lee el mensaje exacto; (3) pregúntate si el problema es de *permisos*, de *valor faltante* o de *versión*.

---

## 14. Cuestionario de Repaso

**Preguntas**

1. ¿Por qué el código fuente nunca está en el VPS?
2. ¿Cuál es la diferencia entre el Nginx del VPS y el Nginx del contenedor web?
3. ¿Qué pasa si defines `VITE_API_URL` en `environment:` del compose? ¿Por qué?
4. ¿Cuándo se lee una variable de build y cuándo una de ejecución?
5. ¿Por qué la llave privada SSH se genera en tu WSL y no en el servidor?
6. ¿Qué ventaja tiene `GITHUB_TOKEN` sobre un PAT?
7. ¿Qué hace `--password-stdin` y por qué es preferible a `-p`?
8. ¿Por qué se usa `127.0.0.1:3093:3091` y no `3093:3091`?
9. ¿Qué crea Prisma automáticamente y qué debes crear tú?
10. ¿En qué se diferencian `migrate dev` y `migrate deploy`?
11. ¿Por qué se evita `pnpm@latest` en el Dockerfile?
12. ¿Por qué `index.html` no debe cachearse pero los archivos de `assets/` sí?
13. ¿Qué protege el hook `pre-push` y qué no?
14. Un `docker compose pull` falla con `denied`. ¿Cuáles son las dos primeras cosas que revisas?

**Respuestas**

1. Porque GitHub compila las imágenes y el VPS solo las descarga. Así el servidor no necesita herramientas de build y se reduce el riesgo.
2. El del VPS es un *reverse proxy* que recibe HTTPS y reparte hacia los puertos locales. El del contenedor es un servidor de archivos estáticos de la SPA.
3. No tiene efecto: Vite incrusta la variable al compilar, y la imagen ya está construida cuando arranca el contenedor. Debe pasarse con `build-args` en el workflow.
4. La de build, al compilar la imagen en GitHub Actions; la de ejecución, al arrancar el contenedor en el VPS.
5. Para que la privada nunca esté en el servidor: si este se compromete, no se filtra una credencial de acceso. Además, es más cómodo copiarla a GitHub desde WSL.
6. Se genera por ejecución y caduca al terminar: no hay nada que renovar ni que filtrar de forma útil.
7. Pasa el token por la entrada estándar en lugar de como argumento, por lo que no queda en el historial de comandos ni en la lista de procesos.
8. Con `127.0.0.1` el puerto solo es accesible desde el propio servidor (el Nginx del VPS); sin él quedaría expuesto a internet.
9. Prisma crea tablas y columnas; tú creas la base de datos y el usuario de PostgreSQL.
10. `migrate dev` genera y aplica migraciones en desarrollo; `migrate deploy` solo aplica las existentes, y se usa en staging y producción.
11. Porque el build dejaría de ser reproducible y podría chocar con la versión fijada en `packageManager`, además de romper `--frozen-lockfile`.
12. Los de `assets/` llevan hash en el nombre y cambian de nombre cuando cambian; `index.html` mantiene su nombre y, si se cacheara, apuntaría a archivos antiguos tras un despliegue.
13. Evita pushes accidentales a `main` desde tu máquina; no verifica que hayas probado en staging, ni protege contra `--no-verify` o pushes desde otra máquina sin el hook.
14. (1) Que el paquete esté vinculado al repositorio (*Manage Actions access* y la etiqueta `LABEL`), y (2) que el job de despliegue tenga `packages: read` (o que el PAT siga vigente si usas la Opción A).
