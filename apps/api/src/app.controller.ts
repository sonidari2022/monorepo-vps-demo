import { Controller, Get, Post, Body } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('health')
  getHealth() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('ejemplo')
  getEjemplos() {
    return this.appService.getEjemplos();
  }

  @Post('ejemplo')
  createEjemplo(@Body() body: { descripcion: string; otros?: string }) {
    return this.appService.createEjemplo(body);
  }
}
