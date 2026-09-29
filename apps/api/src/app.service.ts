import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Injectable()
export class AppService {
  constructor(private prisma: PrismaService) {}

  async getEjemplos() {
    try {
      return await this.prisma.ejemplo.findMany();
    } catch (error) {
      return [
        { id: 1, descripcion: 'Datos simulados (Sin conexión DB activa)', otros: 'Valor de prueba en columna otros' }
      ];
    }
  }

  async createEjemplo(data: { descripcion: string; otros?: string }) {
    return await this.prisma.ejemplo.create({
      data,
    });
  }
}
