/*
  Warnings:

  - You are about to drop the `Ejemplo` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "Ejemplo";

-- CreateTable
CREATE TABLE "ejemplo" (
    "id" SERIAL NOT NULL,
    "descripcion" TEXT NOT NULL,
    "otros" TEXT,

    CONSTRAINT "ejemplo_pkey" PRIMARY KEY ("id")
);
