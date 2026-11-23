import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
} from '@nestjs/common';
import { DecreaseStockDto } from './dto/decrease-stock.dto.js';
import { SetStockDto } from './dto/set-stock.dto.js';
import { StockService } from './stock.service.js';

@Controller('stocks')
export class StockController {
  constructor(private readonly stockService: StockService) {}

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.stockService.get(id);
  }

  @Put(':id')
  set(@Param('id', ParseIntPipe) id: number, @Body() dto: SetStockDto) {
    return this.stockService.set(id, dto.quantity);
  }

  @Post(':id/decrease')
  decrease(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DecreaseStockDto,
  ) {
    return this.stockService.decrease(id, dto.quantity);
  }
}
