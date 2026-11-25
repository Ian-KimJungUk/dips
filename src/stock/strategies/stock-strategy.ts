import type { Stock } from '../../generated/prisma/client.js';

export interface StockStrategy {
  readonly name: string;
  decrease(id: number, quantity: number): Promise<Stock>;
}

export const STOCK_STRATEGY = Symbol('STOCK_STRATEGY');
