# Monorepo Producción & Staging con pnpm, NestJS, Prisma y React

## Ajustes integrados en este ZIP:
1. **Prisma ORM integrado en `apps/api`:**
   - Esquema inicial `schema.prisma` con la entidad `Ejemplo` (campos `id`, `descripcion`, `otros`).
   - Migración inicial generada en `apps/api/prisma/migrations/`.
   - Script de inicio automatizado `"start:prod": "npx prisma migrate deploy && node dist/main.js"`.
2. **Pipelines de GitHub Actions divididos:**
   - `.github/workflows/deploy-staging.yml` para desplegar la rama `staging`.
   - `.github/workflows/deploy-prod.yml` para desplegar la rama `main` a producción.
3. **Soporte completo para Node.js 24.20.0 y pnpm 9.**
